// =====================================================================
// actualizar-nebula.js — Obtiene posiciones ecuatoriales (RA/Dec) de
// Sol, Luna y planetas desde AstronomyAPI v2 y guarda en nebula-astro.json
// para que la app los consuma sin gastar cuota ni exponer credenciales.
// =====================================================================
const fs = require('fs');
const https = require('https');

const APP_ID = process.env.NEBULA_APP_ID || '';
const APP_SECRET = process.env.NEBULA_APP_SECRET || '';
const API_URL = 'https://api.astronomyapi.com/api/v2/bodies/positions';

// Cuerpos que pedimos a la API (los mismos que usa la app)
const BODIES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'];

function pad2(n) { return String(n).padStart(2, '0'); }

function get(url, headers) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: Object.assign({ 'user-agent': 'Nebula-GitHub-Action/1.0' }, headers || {}) }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(get(res.headers.location, headers));
            }
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, text: data }));
        }).on('error', reject).setTimeout(15000, () => { this.destroy(new Error('timeout')); });
    });
}

function apiGet(path, auth) {
    return get('https://api.astronomyapi.com' + path + (path.includes('?') ? '&' : '?') + 'key=' + auth)
        .then(r => JSON.parse(r.text));
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

// Intenta extraer RA/Dec (ecuatorial) del sample; si no viene, intenta derivar de horizontal
function toEquatorial(sample) {
    const pos = sample.position || sample;
    // Prioridad 1: equatorial directo si la API lo devuelve
    if (pos.equatorial) {
        const ra = parseFloat(pos.equatorial.rightAscension?.degrees || pos.equatorial.ra?.degrees || pos.equatorial.ra);
        const dec = parseFloat(pos.equatorial.declination?.degrees || pos.equatorial.dec?.degrees || pos.equatorial.dec);
        if (Number.isFinite(ra) && Number.isFinite(dec)) return { ra, dec };
    }
    // Prioridad 2: horizontal + ubicación conocida -> convertir a ecuatorial
    // Usamos Greenwich (lat 0, lon 0) como referencia si no hay otra
    if (pos.horizontal) {
        const alt = parseFloat(pos.horizontal.altitude?.degrees || pos.horizontal.altitude);
        const az = parseFloat(pos.horizontal.azimuth?.degrees || pos.horizontal.azimuth);
        const lat = parseFloat(pos.latitude?.degrees || 0);
        const lon = parseFloat(pos.longitude?.degrees || 0);
        if (Number.isFinite(alt) && Number.isFinite(az)) {
            // Conversión horizontal -> ecuatorial (fórmula estándar)
            const D2R = Math.PI / 180, R2D = 180 / Math.PI;
            const a = alt * D2R, z = az * D2R, latR = lat * D2R;
            const sinDec = Math.sin(a) * Math.sin(latR) + Math.cos(a) * Math.cos(latR) * Math.cos(z);
            const dec = Math.asin(Math.max(-1, Math.min(1, sinDec))) * R2D;
            const cosDec = Math.cos(dec * D2R);
            if (cosDec > 1e-6 && Math.abs(Math.cos(latR)) > 1e-6) {
                const sinH = (-Math.sin(z) * Math.cos(a)) / cosDec;
                const cosH = (Math.sin(a) - Math.sin(latR) * sinDec) / (Math.cos(latR) * cosDec);
                const ha = Math.atan2(sinH, cosH) * R2D;
                // Necesitamos LST (Greenwich) - no la tenemos del sample sin fecha/hora exacta
                // Como fallback, devolvemos solo horizontal si no podemos derivar RA
            }
        }
    }
    return null;
}

async function fetchEphemeris() {
    const now = new Date();
    const date = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
    const time = `${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}:${pad2(now.getUTCSeconds())}`;

    const params = new URLSearchParams({
        latitude: '0',          // Greenwich como referencia
        longitude: '0',
        elevation: '0',
        from_date: date,
        to_date: date,
        time,
        // Pedimos coordenadas ecuatoriales si la API lo soporta (parámetro no documentado pero probado)
        format: 'json'
    });

    const auth = Buffer.from(`${APP_ID}:${APP_SECRET}`).toString('base64');

    const url = `${API_URL}?${params.toString()}`;
    const res = await get(url, { Authorization: `Basic ${auth}` });

    if (res.status !== 200) {
        const errMsg = `API HTTP ${res.status}: ${res.text.slice(0, 200)}`;
        throw new Error(errMsg);
    }

    const json = JSON.parse(res.text);
    const entries = extractEntries(json);

    const result = {
        timestamp: now.toISOString(),
        source: 'AstronomyAPI v2',
        referenceLocation: { latitude: 0, longitude: 0 },
        bodies: {}
    };

    for (const entry of entries) {
        if (!entry.sample) continue;
        const name = entry.name;
        if (!BODIES.includes(name)) continue;

        const pos = entry.sample.position || entry.sample;
        const equatorial = pos.equatorial;
        const horizontal = pos.horizontal;

        const bodyData = { name };

        // Si vino ecuatorial directo, úsalo
        if (equatorial) {
            const ra = parseFloat(equatorial.rightAscension?.degrees || equatorial.ra?.degrees || equatorial.ra);
            const dec = parseFloat(equatorial.declination?.degrees || equatorial.dec?.degrees || equatorial.dec);
            if (Number.isFinite(ra) && Number.isFinite(dec)) {
                bodyData.equatorial = { ra, dec };
            }
        }

        // Siempre guardamos horizontal de Greenwich como respaldo
        if (horizontal) {
            const alt = parseFloat(horizontal.altitude?.degrees || horizontal.altitude);
            const az = parseFloat(horizontal.azimuth?.degrees || horizontal.azimuth);
            if (Number.isFinite(alt) && Number.isFinite(az)) {
                bodyData.horizontalGreenwich = { alt, az };
            }
        }

        // Distancia si viene
        const dist = pos.distance || (entry.sample.positions && entry.sample.positions.distance);
        if (dist && dist.astronomical) {
            bodyData.distanceAU = parseFloat(dist.astronomical);
        }

        // Magnitud aparente si viene
        if (pos.apparentMagnitude !== undefined) {
            bodyData.magnitude = parseFloat(pos.apparentMagnitude);
        } else if (pos.magnitude !== undefined) {
            bodyData.magnitude = parseFloat(pos.magnitude);
        }

        if (bodyData.equatorial || bodyData.horizontalGreenwich) {
            result.bodies[name] = bodyData;
        }
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
        console.log(`nebula-astro.json actualizado: ${count} cuerpos (${Object.keys(data.bodies).join(', ')})`);
    } catch (e) {
        console.error('Error:', e.message);
        // No fallar el workflow: el JSON anterior sigue vigente
    }

    process.exit(0);
})();
