/**
 * app.js - fixed version
 * Express + Postgres service for collars with composite sessions
 *
 * Endpoints:
 *  POST /collars    -> create collar (optional session:true), or update (requires collar_id+session_id)
 *  GET  /collars
 *  GET  /collars/:id
 *  GET  /dog/:id
 *  POST /chunks     -> ingest chunk (client sends collar_id + chunk_json only)
 *  GET  /metrics/:id
 *
 * Notes:
 *  - chunk_json must include imu_data (base64)
 *  - POST /collars with { session: true } will create+activate a new session and return it
 */
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;


const pool = new Pool({ connectionString: DATABASE_URL });

const app = express();

// Enable CORS for all origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

app.use(bodyParser.json({ limit: '20mb' }));

/* -----------------------------
   StepCounter (same algorithm)
   ----------------------------- */
class StepCounter {
  constructor() {
    this.SAMPLE_FPS = 100;
    this.FC_GRAVITY = 0.10;
    this.FC_DV = 0.20;
    this.F_MIN = 2.25;
    this.F_MAX = 3.75;
    this.ZL_WINDOW_SEC = 20;
    this.ZL_WINDOW_SAMPLES = this.ZL_WINDOW_SEC * this.SAMPLE_FPS;
    this.PERIOD_WIN = 10;
    this.PERIOD_MIN_INBAND = 7;

    this.g_est = { x: 0, y: 0, z: 1 };
    this.dv_filt = 0;
    this.dv_ring = new Array(this.ZL_WINDOW_SAMPLES).fill(0);
    this.dv_head = 0;
    this.dv_count = 0;
    this.last_dv_minus_zero = 0;
    this.last_candidate_ts = 0;
    this.in_band_flags = new Array(this.PERIOD_WIN).fill(false);
    this.in_band_idx = 0;
    this.in_band_count = 0;
    this.step_count = 0;

    this.a_grav = Math.exp(-2 * Math.PI * this.FC_GRAVITY / this.SAMPLE_FPS);
    this.a_dv = Math.exp(-2 * Math.PI * this.FC_DV / this.SAMPLE_FPS);
  }

  normalize(v) {
    const n = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (n < 1e-6) return { x: 0, y: 0, z: 1 };
    return { x: v.x / n, y: v.y / n, z: v.z / n };
  }

  rotateFromTo(p, from, to) {
    const f = this.normalize(from);
    const t = this.normalize(to);
    const dotRaw = f.x * t.x + f.y * t.y + f.z * t.z;
    const dot = Math.max(-1, Math.min(1, dotRaw));
    if (dot > 0.9999) return p;

    let k = {
      x: f.y * t.z - f.z * t.y,
      y: f.z * t.x - f.x * t.z,
      z: f.x * t.y - f.y * t.x
    };
    let kn = Math.sqrt(k.x * k.x + k.y * k.y + k.z * k.z);
    if (kn < 1e-6) return p;
    k.x /= kn;
    k.y /= kn;
    k.z /= kn;

    const angle = Math.acos(dot);
    const c = Math.cos(angle);
    const s = Math.sin(angle);

    const kxp = {
      x: k.y * p.z - k.z * p.y,
      y: k.z * p.x - k.x * p.z,
      z: k.x * p.y - k.y * p.x
    };
    const kdp = k.x * p.x + k.y * p.y + k.z * p.z;

    return {
      x: p.x * c + kxp.x * s + k.x * kdp * (1 - c),
      y: p.y * c + kxp.y * s + k.y * kdp * (1 - c),
      z: p.z * c + kxp.z * s + k.z * kdp * (1 - c)
    };
  }

  pushDV(v) {
    this.dv_ring[this.dv_head] = v;
    this.dv_head = (this.dv_head + 1) % this.ZL_WINDOW_SAMPLES;
    if (this.dv_count < this.ZL_WINDOW_SAMPLES) this.dv_count++;
  }

  zeroLine() {
    if (this.dv_count === 0) return 0.0;
    let vmin = this.dv_ring[0];
    let vmax = this.dv_ring[0];
    for (let i = 1; i < this.dv_count; ++i) {
      const v = this.dv_ring[i];
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
    return 0.5 * (vmax + vmin);
  }

  periodicityPush(inband) {
    if (this.in_band_flags[this.in_band_idx]) this.in_band_count--;
    this.in_band_flags[this.in_band_idx] = !!inband;
    if (inband) this.in_band_count++;
    this.in_band_idx = (this.in_band_idx + 1) % this.PERIOD_WIN;
  }

  processSample(sample) {
    const now_ms = sample.ts;
    const a_raw = { x: sample.ax, y: sample.ay, z: sample.az };

    this.g_est.x = this.a_grav * this.g_est.x + (1 - this.a_grav) * a_raw.x;
    this.g_est.y = this.a_grav * this.g_est.y + (1 - this.a_grav) * a_raw.y;
    this.g_est.z = this.a_grav * this.g_est.z + (1 - this.a_grav) * a_raw.z;

    const a_rot = this.rotateFromTo(a_raw, this.g_est, { x: 0, y: 0, z: 1 });
    const dv = a_rot.z;

    this.dv_filt = this.a_dv * this.dv_filt + (1 - this.a_dv) * dv;

    this.pushDV(this.dv_filt);
    const zline = this.zeroLine();

    const dv_minus_zero = this.dv_filt - zline;
    const falling_cross = this.last_dv_minus_zero > 0.0 && dv_minus_zero <= 0.0;
    this.last_dv_minus_zero = dv_minus_zero;

    if (falling_cross && this.dv_count >= 50) {
      let inband = false;
      if (this.last_candidate_ts !== 0) {
        const dt_s = (now_ms - this.last_candidate_ts) / 1000.0;
        const f_hz = dt_s > 1e-3 ? 1.0 / dt_s : 999.0;
        inband = f_hz >= this.F_MIN && f_hz <= this.F_MAX;
      }
      this.periodicityPush(inband);
      if (inband && this.in_band_count >= this.PERIOD_MIN_INBAND) {
        this.step_count++;
      }
      this.last_candidate_ts = now_ms;
    }
  }

  processChunk(samples) {
    for (const s of samples) this.processSample(s);
    return this.step_count;
  }
}

/* -----------------------------
   In-memory maps for state (per-collar)
   ----------------------------- */
const stepCounterByCollar = new Map();
const mappingByCollar = new Map();

/* -----------------------------
   Sessions helpers (collar_sessions table)
   ----------------------------- */
async function generateAndInsertSession(collar_id, created_by = 'api', dogMetadata = {}) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT session_id FROM collar_sessions WHERE collar_id = $1',
      [collar_id]
    );
    const used = new Set(rows.map(r => r.session_id));

    let session_id = null;
    for (let k = 1; k <= 9; k++) {
      const t = String(k).repeat(3);
      if (!used.has(t)) {
        session_id = t;
        break;
      }
    }
    if (!session_id) {
      session_id = crypto.randomBytes(12).toString('hex');
    }

    await client.query('BEGIN');
    await client.query(
      'UPDATE collar_sessions SET active = FALSE WHERE collar_id = $1',
      [collar_id]
    );
    await client.query(
      'INSERT INTO collar_sessions (collar_id, session_id, active, created_by, dog_metadata, created_at) VALUES ($1,$2,TRUE,$3,$4,NOW())',
      [collar_id, session_id, created_by, JSON.stringify(dogMetadata)]
    );
    await client.query('COMMIT');
    return session_id;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function getActiveSessionForCollar(collar_id) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT session_id FROM collar_sessions WHERE collar_id = $1 AND active = TRUE LIMIT 1',
      [collar_id]
    );
    return rows.length ? rows[0].session_id : null;
  } finally {
    client.release();
  }
}

async function validateCompositeSession(collar_id, session_id) {
  if (!collar_id || !session_id) return false;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT 1 FROM collar_sessions WHERE collar_id = $1 AND session_id = $2 LIMIT 1',
      [collar_id, session_id]
    );
    return rows.length > 0;
  } finally {
    client.release();
  }
}

/* -----------------------------
   Decode chunk JSON (base64 -> samples)
   ----------------------------- */
function decodeChunkJson(chunkObj) {
  if (!chunkObj || !chunkObj.imu_data) {
    throw new Error('chunk JSON missing imu_data');
  }
  const buf = Buffer.from(chunkObj.imu_data, 'base64');
  const BYTES_PER_SAMPLE = 32;
  if (buf.length % BYTES_PER_SAMPLE !== 0) {
    console.warn('imu_data length not multiple of 32:', buf.length);
  }
  const numSamples = Math.floor(buf.length / BYTES_PER_SAMPLE);
  const samples = [];
  let off = 0;
  for (let i = 0; i < numSamples; ++i) {
    const sample_number = buf.readUInt32LE(off); off += 4;
    const timestamp_ms_dev = buf.readUInt32LE(off); off += 4;
    const ax = buf.readFloatLE(off); off += 4;
    const ay = buf.readFloatLE(off); off += 4;
    const az = buf.readFloatLE(off); off += 4;
    const gx = buf.readFloatLE(off); off += 4;
    const gy = buf.readFloatLE(off); off += 4;
    const gz = buf.readFloatLE(off); off += 4;
    samples.push({
      sample_number,
      timestamp_ms_dev,
      ax,
      ay,
      az,
      gx,
      gy,
      gz
    });
  }
  return {
    samples,
    temp_data: Array.isArray(chunkObj.temp_data) ? chunkObj.temp_data.slice() : [],
    temp_first_timestamp: chunkObj.temp_first_timestamp || null,
    real_time: chunkObj.real_time || null,
    start_sample:
      typeof chunkObj.start_sample !== 'undefined'
        ? Number(chunkObj.start_sample)
        : null,
    chunk_key: chunkObj.chunk_key || null,
    raw_base64_json: JSON.stringify(chunkObj)
  };
}

/* -----------------------------
   Map samples to timestamps
   ----------------------------- */
function mapSamplesToTimestamps(decoded, persistedMapping) {
  const nominalPeriodMs = 10;
  let mapping = null;
  if (decoded.real_time && decoded.start_sample !== null) {
    const realEpoch = Date.parse(decoded.real_time);
    if (!Number.isNaN(realEpoch)) {
      mapping = {
        start_sample: decoded.start_sample,
        real_time_epoch_ms: realEpoch,
        nominalPeriodMs
      };
    }
  }
  const useMapping = mapping || persistedMapping || null;
  const mapped = decoded.samples.map(s => {
    let ts;
    if (useMapping) {
      const dtSamples = s.sample_number - useMapping.start_sample;
      ts = useMapping.real_time_epoch_ms + dtSamples * useMapping.nominalPeriodMs;
    } else {
      ts = s.timestamp_ms_dev;
    }
    return {
      ts,
      ax: s.ax,
      ay: s.ay,
      az: s.az,
      gx: s.gx,
      gy: s.gy,
      gz: s.gz,
      sample_number: s.sample_number
    };
  });
  return { mapped, mapping };
}

/* -----------------------------
   DB helpers: collars + chunks + output metric
   ----------------------------- */

async function upsertCollarCreateOnly(collarBody) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO collars (
         collar_id, dog_name, breed, coat_type, height, weight, sex, age,
         temperature_irgun, collar_orientation, medical_info, remarks, created_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       ON CONFLICT (collar_id) DO UPDATE SET
         dog_name = COALESCE(EXCLUDED.dog_name, collars.dog_name),
         breed = COALESCE(EXCLUDED.breed, collars.breed),
         coat_type = COALESCE(EXCLUDED.coat_type, collars.coat_type),
         height = COALESCE(EXCLUDED.height, collars.height),
         weight = COALESCE(EXCLUDED.weight, collars.weight),
         sex = COALESCE(EXCLUDED.sex, collars.sex),
         age = COALESCE(EXCLUDED.age, collars.age),
         temperature_irgun = COALESCE(EXCLUDED.temperature_irgun, collars.temperature_irgun),
         collar_orientation = COALESCE(EXCLUDED.collar_orientation, collars.collar_orientation),
         medical_info = COALESCE(EXCLUDED.medical_info, collars.medical_info),
         remarks = COALESCE(EXCLUDED.remarks, collars.remarks),
         updated_at = NOW()
       RETURNING *;`,
      [
        collarBody.collar_id,
        collarBody.dog_name ?? null,
        collarBody.breed ?? null,
        collarBody.coat_type ?? null,
        collarBody.height ?? null,
        collarBody.weight ?? null,
        collarBody.sex ?? null,
        collarBody.age ?? null,
        collarBody.temperature_irgun ?? null,
        collarBody.collar_orientation ?? null,
        collarBody.medical_info ?? null,
        collarBody.remarks ?? null
      ]
    );
    return res.rows[0];
  } finally {
    client.release();
  }
}

async function updateCollarFieldsWithSessionAuth(collarBody, session_id) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `UPDATE collars SET
         dog_name=$2,
         breed=$3,
         coat_type=$4,
         height=$5,
         weight=$6,
         sex=$7,
         age=$8,
         temperature_irgun=$9,
         collar_orientation=$10,
         medical_info=$11,
         remarks=$12,
         updated_at=NOW()
       WHERE collar_id=$1
       RETURNING *;`,
      [
        collarBody.collar_id,
        collarBody.dog_name || null,
        collarBody.breed || null,
        collarBody.coat_type || null,
        collarBody.height || null,
        collarBody.weight || null,
        collarBody.sex || null,
        collarBody.age || null,
        collarBody.temperature_irgun || null,
        collarBody.collar_orientation || null,
        collarBody.medical_info || null,
        collarBody.remarks || null
      ]
    );
    return res.rows[0];
  } finally {
    client.release();
  }
}

async function insertChunkRow(collar_id, session_id, decoded, summary, outputMetric) {
  const client = await pool.connect();
  try {
    const q = `INSERT INTO collar_chunks (
      collar_id, session_id, chunk_key, start_sample, num_samples, nominal_period_ms,
      real_time_iso, temp_first_timestamp, temp_data,
      raw_base64_json, raw_imu_base64, sensor_summary, output_metric, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()) RETURNING *;`;

    const chunkKey =
      decoded && decoded.samples.length
        ? `chunk_${decoded.samples[0].sample_number}`
        : `chunk_${Date.now()}`;

    const vals = [
      collar_id,
      session_id,
      chunkKey,
      decoded.start_sample,
      decoded.samples.length,
      10,
      decoded.real_time,
      decoded.temp_first_timestamp,
      JSON.stringify(decoded.temp_data || []),
      decoded.raw_base64_json,
      decoded.raw_base64_json
        ? JSON.parse(decoded.raw_base64_json).imu_data
        : null,
      JSON.stringify(summary || {}),
      JSON.stringify(outputMetric || {})
    ];

    const r = await client.query(q, vals);
    return r.rows[0];
  } finally {
    client.release();
  }
}

async function updateCollarOutputMetric(collar_id, outputMetric) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE collars
         SET output_metric = COALESCE(output_metric, '{}'::jsonb) || $2::jsonb,
             updated_at = NOW()
       WHERE collar_id = $1`,
      [collar_id, JSON.stringify(outputMetric)]
    );
  } finally {
    client.release();
  }
}

/* -----------------------------
   Routes
   ----------------------------- */

/**
 * POST /collars
 * Create collar if missing. If body.session === true, create & activate session and return session_id.
 * For updates: client must include session_id and it must be valid for this collar (composite).
 */
// app.post('/collars', async (req, res) => {
//   try {
//     const body = req.body;
//     if (!body || !body.collar_id) {
//       return res.status(400).json({ error: 'collar_id required' });
//     }

//     // If caller provided session_id -> treat as authenticated update
//     if (body.session_id) {
//       const ok = await validateCompositeSession(body.collar_id, body.session_id);
//       if (!ok) {
//         return res.status(401).json({ error: 'invalid collar_id/session_id' });
//       }
//       const updated = await updateCollarFieldsWithSessionAuth(body, body.session_id);
//       return res.json({ ok: true, collar: updated });
//     }

//     // Else: create collar if missing
//     const collar = await upsertCollarCreateOnly(body);

//     // If caller explicitly asks for a session to be created and activated now
//     if (body.session === true) {
//       const session_id = await generateAndInsertSession(collar.collar_id, 'api_create');
//       return res.json({ ok: true, collar, session_id });
//     }

//     return res.json({ ok: true, collar });
//   } catch (err) {
//     console.error('POST /collars error', err);
//     return res.status(500).json({ error: err.message });
//   }
// });
app.post('/collars', async (req, res) => {
  try {
    const body = req.body;
    if (!body || !body.collar_id) {
      return res.status(400).json({ error: 'collar_id required' });
    }

    // ⭐ Create new session when user explicitly asks
    if (body.new_session === true || body.new_session === "true" || body.new_session === 1) {
      // FIRST: Update collar with new dog details
      const collar = await upsertCollarCreateOnly(body);

      // THEN: Capture dog details as snapshot for this session
      const dogMetadata = {
        dog_name: collar.dog_name,
        breed: collar.breed,
        age: collar.age,
        height: collar.height,
        weight: collar.weight,
        sex: collar.sex,
        coat_type: collar.coat_type,
        temperature_irgun: collar.temperature_irgun,
        collar_orientation: collar.collar_orientation,
        medical_info: collar.medical_info,
        remarks: collar.remarks
      };

      // Create new session with updated dog metadata snapshot
      const session_id = await generateAndInsertSession(body.collar_id, 'user_request', dogMetadata);
      return res.json({
        ok: true,
        collar,
        session_id,
        message: 'Dog details updated and new session created with snapshot.'
      });
    }

    // Default: Update collar details WITHOUT creating a new session
    const collar = await upsertCollarCreateOnly(body);
    return res.json({ ok: true, collar, message: 'Dog details updated' });

  } catch (err) {
    console.error('POST /collars error', err);
    return res.status(500).json({ error: err.message });
  }
});


// GET /collars
app.get('/collars', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT collar_id, dog_name, breed, created_at, output_metric FROM collars ORDER BY created_at DESC'
    );
    return res.json(rows);
  } catch (err) {
    console.error('GET /collars error', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /collars/:collar_id
// app.get('/collars/:collar_id', async (req, res) => {
//   try {
//     const cid = req.params.collar_id;
//     const { rows } = await pool.query(
//       'SELECT * FROM collars WHERE collar_id = $1',
//       [cid]
//     );
//     if (rows.length === 0) {
//       return res.status(404).json({ error: 'not found' });
//     }
//     return res.json(rows[0]);
//   } catch (err) {
//     console.error('GET /collars/:collar_id error', err);
//     return res.status(500).json({ error: err.message });
//   }
// });

// // GET /dog/:collar_id
// app.get('/dog/:collar_id', async (req, res) => {
//   try {
//     const cid = req.params.collar_id;
//     const { rows } = await pool.query(
//       `SELECT collar_id, dog_name, breed, coat_type,
//               height, weight, sex, medical_info, remarks
//        FROM collars WHERE collar_id = $1`,
//       [cid]
//     );
//     if (rows.length === 0) {
//       return res.status(404).json({ error: 'not found' });
//     }
//     return res.json(rows[0]);
//   } catch (err) {
//     console.error('GET /dog/:collar_id error', err);
//     return res.status(500).json({ error: err.message });
//   }
// });

app.get('/collars/:collar_id', async (req, res) => {
  try {
    const cid = req.params.collar_id;
    const sessionId = req.query.session_id;  // Optional: filter by session

    // Fetch collar basic data
    const collarRes = await pool.query(
      'SELECT * FROM collars WHERE collar_id = $1',
      [cid]
    );

    if (collarRes.rows.length === 0) {
      return res.status(404).json({ error: 'not found' });
    }

    const collar = collarRes.rows[0];

    // Fetch temperature readings - optionally filtered by session_id
    let chunksRes;
    if (sessionId) {
      // Get temperature data ONLY for this specific session
      chunksRes = await pool.query(
        `SELECT temp_data, temp_first_timestamp
         FROM collar_chunks
         WHERE collar_id = $1 AND session_id = $2
         ORDER BY created_at ASC`,
        [cid, sessionId]
      );
    } else {
      // Get ALL temperature readings from chunks (backward compatibility)
      chunksRes = await pool.query(
        `SELECT temp_data, temp_first_timestamp
         FROM collar_chunks
         WHERE collar_id = $1
         ORDER BY created_at ASC`,
        [cid]
      );
    }

    const temperature_list = [];

    for (const chunk of chunksRes.rows) {
      const temps = chunk.temp_data || [];
      let t0 = chunk.temp_first_timestamp
        ? new Date(chunk.temp_first_timestamp).getTime()
        : null;

      // If timestamp missing, skip this chunk
      if (!t0) continue;

      // assume 1-second interval between samples
      const intervalMs = 1000;

      temps.forEach((tempValue, index) => {
        temperature_list.push({
          temp_c: tempValue,
          timestamp: new Date(t0 + index * intervalMs).toISOString()
        });
      });
    }

    return res.json({
      ...collar,
      temperature_list
    });

  } catch (err) {
    console.error("GET /collars/:collar_id error", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /chunks
 * New firmware format:
 * {
 *   "data": {
 *     "chunk_00000000": {
 *        "collar_id": "C001",
 *        "imu_data": "...",
 *        "temp_data": [...],
 *        "temp_first_timestamp": "...",
 *        "real_time": "...",
 *        "start_sample": 0
 *     }
 *   }
 * }
 */
app.put('/chunks', async (req, res) => {
  try {
    const { data, new_session } = req.body;

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: "data object required" });
    }

    const chunkKeyName = Object.keys(data)[0];
    const chunkObj = data[chunkKeyName];

    const collar_id = chunkObj.collar_id;
    if (!collar_id) {
      return res.status(400).json({ error: "collar_id missing inside chunk" });
    }

    // Check collar exists
    const { rows: collarRows } = await pool.query(
      "SELECT * FROM collars WHERE collar_id = $1",
      [collar_id]
    );

    if (collarRows.length === 0) {
      return res.status(404).json({
        error: "collar not found; create collar first"
      });
    }

    // Get existing active session
    let session_id = await getActiveSessionForCollar(collar_id);

    // ✔ Only create new session IF user explicitly asks
    if (new_session === true) {
      // Fetch current dog metadata from collar table
      const dogMetadata = {
        dog_name: collarRows[0].dog_name,
        breed: collarRows[0].breed,
        age: collarRows[0].age,
        height: collarRows[0].height,
        weight: collarRows[0].weight,
        sex: collarRows[0].sex,
        coat_type: collarRows[0].coat_type,
        temperature_irgun: collarRows[0].temperature_irgun,
        collar_orientation: collarRows[0].collar_orientation,
        medical_info: collarRows[0].medical_info,
        remarks: collarRows[0].remarks
      };
      session_id = await generateAndInsertSession(collar_id, "manual", dogMetadata);
    }

    // ❌ Do NOT create session automatically
    if (!session_id) {
      return res.status(400).json({
        error: "No active session. Call PUT /chunks with {new_session: true} to start a new session."
      });
    }

    // -----------------------
    // Decode + Process IMU
    // -----------------------
    const decoded = decodeChunkJson(chunkObj);
    const persistedMapping = collarRows[0].mapping_json || null;
    const { mapped, mapping } = mapSamplesToTimestamps(decoded, persistedMapping);

    if (mapping) {
      await pool.query(
        "UPDATE collars SET mapping_json=$2 WHERE collar_id=$1",
        [collar_id, mapping]
      );
      mappingByCollar.set(collar_id, mapping);
    }

    let sc = stepCounterByCollar.get(collar_id);
    if (!sc) {
      sc = new StepCounter();
      stepCounterByCollar.set(collar_id, sc);

      if (collarRows[0].output_metric?.steps) {
        sc.step_count = Number(collarRows[0].output_metric.steps);
      }
    }

    const before = sc.step_count;
    sc.processChunk(mapped);
    const after = sc.step_count;

    const outputMetric = {
      steps_in_chunk: after - before,
      cumulative_steps: sc.step_count,
      temp_avg_c: decoded.temp_data?.length
        ? decoded.temp_data.reduce((a, b) => a + b, 0) / decoded.temp_data.length
        : null,
      session_id_used: session_id,
      received_at: new Date().toISOString()
    };

    const chunkRow = await insertChunkRow(
      collar_id, session_id, decoded, {}, outputMetric
    );

    await updateCollarOutputMetric(collar_id, {
      steps: sc.step_count,
      last_chunk_id: chunkRow.id,
      last_update: new Date().toISOString()
    });

    return res.json({
      ok: true,
      session_id_used: session_id,
      chunk_id: chunkRow.id,
      outputMetric
    });

  } catch (err) {
    console.error("PUT /chunks error", err);
    return res.status(500).json({ error: err.message });
  }
});


/* -----------------------------
   Start server
   ----------------------------- */
app.listen(PORT, () => {
  console.log(`Collar backend listening on ${PORT}`);
});
