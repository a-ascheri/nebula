// =====================================================================
// actualizar-nebula.js — Obtiene posiciones de Sol, Luna y planetas
// desde AstronomyAPI v2, calcula RA/Dec y las guarda en nebula-astro.json
// =====================================================================
const fs = require('fs');
const https = require('https');

const APP_ID = process.env.NEBULA_APP_ID || '';
const APP_SECRET = process.env.NEBULA_APP_SECRET || '';
const API_URL = 'https://api.astronomyapi.com/api/v2/bodies/positions';

// Cuerpos que pedimos a la API
const BODIES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'];

function pad2(n) { return String(n).padStart(2, '0'); }

function get(url, headers) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: Object.assign({ 'user-agent': 'Nebula-GitHub-Action/1.0' }, headers || {}) }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(get(res.headers.location, headers));
            }
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, text: data }));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    });
}

function extractEntries(json) {
    const d = json && json.data;
    if (Array.isArray(d)) {
        return d.map((it) => ({
            name: (it.body && it.body.name) || it.name,
            sample: Array.isArray(it.samples) ? it.samples[0] : null
        }));
    }
    if (d && d.table && Array.isArray(d.table.rows)) {
        return d.table.rows.map((r) => ({
            name: r.entry && r.entry.name,
            sample: Array.isArray(r.cells) ? r.cells[0] : null
        }));
    }
    if (d && Array.isArray(d.rows)) {
        return d.rows.map((r) => ({
            name: (r.body && r.body.name) || (r.entry && r.entry.name) || r.name,
            sample: Array.isArray(r.positions) ? r.positions[0] : null
        }));
    }
    return [];
}

// --- FUNCIONES MATEMÁTICAS PARA CONVERTIR HORIZONTAL A ECUATORIAL ---

/** Días desde J2000.0 */
function daysFromJ2000(ms) {
    return ms / 86400000 + 2440587.5 - 2451545.0;
}

/** Tiempo sidéreo medio de Greenwich (grados) */
function gmstDeg(d) {
    return ((280.46061837 + 360.98564736629 * d) % 360 + 360) % 360;
}

/** Convierte Alt/Az (desde Greenwich) a RA/Dec usando la hora exacta */
function horizontalToEquatorial(altDeg, azDeg, latDeg, lonDeg, d) {
    const D2R = Math.PI / 180, R2D = 180 / Math.PI;
    const alt = altDeg * D2R, az = azDeg * D2R, lat = latDeg * D2R;
    const sinDec = Math.sin(alt) * Math.sin(lat) + Math.cos(alt) * Math.cos(lat) * Math.cos(az);
    const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
    const cosDec = Math.cos(dec);
    if (Math.abs(Math.cos(lat)) < 1e-8 || cosDec < 1e-8) return null;
    const sinH = (-Math.sin(az) * Math.cos(alt)) / cosDec;
    const cosH = (Math.sin(alt) - Math.sin(lat) * sinDec) / (Math.cos(lat) * cosDec);
    const ha = Math.atan2(sinH, cosH) * R2D;
    return {
        dec: dec * R2D,
        ra: ((gmstDeg(d) + lonDeg - ha) % 360 + 360) % 360
    };
}

async function fetchEphemeris() {
    const now = new Date();
    const date = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
    const time = `${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}:${pad2(now.getUTCSeconds())}`;

    const params = new URLSearchParams({
        latitude: '0',
        longitude: '0',
        elevation: '0',
        from_date: date,
        to_date: date,
        time
    });

    const auth = Buffer.from(`${APP_ID}:${APP_SECRET}`).toString('base64');
    const url = `${API_URL}?${params.toString()}`;
    const res = await get(url, { Authorization: `Basic ${auth}` });

    if (res.status !== 200) {
        throw new Error(`API HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    }

    const json = JSON.parse(res.text);
    const entries = extractEntries(json);

    const result = {
        timestamp: now.toISOString(),
        source: 'AstronomyAPI v2',
        referenceLocation: { latitude: 0, longitude: 0 },
        bodies: {}
    };

    const d = daysFromJ2000(now.getTime());

    for (const entry of entries) {
        if (!entry.sample) continue;
        const name = entry.name;
        if (!BODIES.includes(name)) continue;

        const pos = entry.sample.position || entry.sample;
        const horizontal = pos.horizontal;

        if (!horizontal) continue;

        const alt = parseFloat(horizontal.altitude?.degrees || horizontal.altitude);
        const az = parseFloat(horizontal.azimuth?.degrees || horizontal.azimuth);

        if (!Number.isFinite(alt) || !Number.isFinite(az)) continue;

        // Calculamos la RA/Dec a partir de la posición horizontal de Greenwich
        // (lat 0, lon 0) y la hora exacta
        const eq = horizontalToEquatorial(alt, az, 0, 0, d);
        
        const bodyData = { name };
        
        if (eq && Number.isFinite(eq.ra) && Number.isFinite(eq.dec)) {
            bodyData.equatorial = { ra: eq.ra, dec: eq.dec };
        }
        
        // Guardamos el horizontal de Greenwich como respaldo
        bodyData.horizontalGreenwich = { alt, az };

        // Distancia
        const dist = pos.distance || (entry.sample.positions && entry.sample.positions.distance);
        if (dist && dist.astronomical) {
            bodyData.distanceAU = parseFloat(dist.astronomical);
        }

        result.bodies[name] = bodyData;
    }

    return result;
}

(async () => {
    console.log('Iniciando actualización Nebula (' + new Date().toISOString() + ')…');

    if (!APP_ID || !APP_SECRET) {
        console.error('Faltan NEBULA_APP_ID / NEBULA_APP_SECRET en secrets. No se actualiza.');
        process.exit(0);
    }

    try {
        const data = await fetchEphemeris();
        const count = Object.keys(data.bodies).length;
        fs.writeFileSync('nebula-astro.json', JSON.stringify(data, null, 2));
        console.log(`nebula-astro.json actualizado: ${count} cuerpos`);
    } catch (e) {
        console.error('Error:', e.message);
    }

    process.exit(0);
})();
