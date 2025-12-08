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
   StepCounter (Sheep Algorithm - Jiang et al. 2023)
   ----------------------------- */
class StepCounter {
  constructor(params = {}) {
    // Sheep-specific algorithm parameters (from Jiang et al. 2023)
    this.PEAK_THRESHOLD = params.peak_threshold || 12.0;
    this.PEAK_WINDOW_N = params.peak_window_n || 4;
    this.VALLEY_WINDOW_N = 2;
    this.FILTER_WINDOW_SIZE = params.filter_window_size || 5;
    this.PROCESS_WINDOW_SAMPLES = params.process_window_samples || 100;
    this.RUN_START_THRESHOLD = params.run_start_threshold || 30.0;
    this.SHAKE_START_THRESHOLD = params.shake_start_threshold || 12.0;
    
    // Running behavior thresholds
    this.RUN_END_THRESHOLD_HIGH = 20.0;
    this.RUN_END_THRESHOLD_LOW = 12.0;
    this.RUN_PEAK_VALLEY_DIFF = 20.0;
    this.RUN_SCALING_FACTOR = 2.1;
    this.BASELINE_STEP_SAMPLES = 29;
    
    // Leg shaking thresholds
    this.SHAKE_PEAK_VALLEY_DIFF = 12.0;
    this.SHAKE_REGIONAL_PEAK_MAX = 39.0;
    this.SHAKE_VARIANCE_THRESHOLD = 10.0;

    // Moving average filter for acceleration
    this.filterBuffer = new Array(this.FILTER_WINDOW_SIZE).fill(0);
    this.filterIndex = 0;
    this.filterSum = 0;
    this.filterCount = 0;

    // Acceleration buffer for peak detection
    this.accBuffer = [];
    this.gyroBuffer = [];
    
    // Peak and valley storage
    this.peaks = [];
    this.valleys = [];
    
    // Step counting state
    this.step_count = 0;
    this.running_steps = 0;
    this.leg_shake_removed = 0;
    this.sample_index = 0;
  }

  // Moving average filter
  filterProcess(input) {
    this.filterSum -= this.filterBuffer[this.filterIndex];
    this.filterBuffer[this.filterIndex] = input;
    this.filterSum += input;
    this.filterIndex = (this.filterIndex + 1) % this.FILTER_WINDOW_SIZE;
    if (this.filterCount < this.FILTER_WINDOW_SIZE) this.filterCount++;
    return this.filterSum / this.filterCount;
  }

  // Calculate combined acceleration (magnitude)
  calculateCombinedAcceleration(ax, ay, az) {
    return Math.sqrt(ax * ax + ay * ay + az * az);
  }

  // Detect peaks using window method
  detectPeaksAndValleys(filteredAcc, index) {
    const centerIdx = this.accBuffer.length - 1;
    const centerVal = filteredAcc;

    // Need enough history for window
    if (this.accBuffer.length < this.PEAK_WINDOW_N * 2 + 1) return;

    // Check if this is a peak
    let isPeak = centerVal > this.PEAK_THRESHOLD;
    if (isPeak) {
      // Check left and right windows
      for (let i = 1; i <= this.PEAK_WINDOW_N; i++) {
        const leftIdx = centerIdx - i;
        if (leftIdx >= 0 && this.accBuffer[leftIdx] >= centerVal) {
          isPeak = false;
          break;
        }
      }
    }

    if (isPeak) {
      this.peaks.push({ value: centerVal, index: index });
    }

    // Check if this is a valley
    let isValley = true;
    for (let i = 1; i <= this.VALLEY_WINDOW_N; i++) {
      const leftIdx = centerIdx - i;
      const rightIdx = centerIdx + i;
      if (leftIdx >= 0 && this.accBuffer[leftIdx] <= centerVal) {
        isValley = false;
        break;
      }
      if (rightIdx < this.accBuffer.length && this.accBuffer[rightIdx] <= centerVal) {
        isValley = false;
        break;
      }
    }

    if (isValley) {
      this.valleys.push({ value: centerVal, index: index });
    }
  }

  // Detect and count running behavior
  detectAndCountRunning() {
    let runStart = -1;
    let runEnd = -1;

    for (let i = 0; i < this.peaks.length; i++) {
      if (this.peaks[i].value > this.RUN_START_THRESHOLD && runStart === -1) {
        runStart = i;
      }

      if (runStart !== -1 && 
          (this.peaks[i].value < this.RUN_END_THRESHOLD_HIGH || 
           this.peaks[i].value < this.RUN_END_THRESHOLD_LOW)) {
        runEnd = i;
        break;
      }
    }

    if (runStart !== -1 && runEnd !== -1) {
      let isRunning = true;
      for (let i = runStart; i < runEnd && i < this.valleys.length; i++) {
        const peakValDiff = this.peaks[i].value - this.valleys[i].value;
        if (peakValDiff >= this.peaks[i].value - this.RUN_PEAK_VALLEY_DIFF) {
          isRunning = false;
          break;
        }
      }

      if (isRunning) {
        const windowSize = this.peaks[runEnd].index - this.peaks[runStart].index;
        const calculatedSteps = (windowSize * this.RUN_SCALING_FACTOR) / this.BASELINE_STEP_SAMPLES;
        const runSteps = Math.round(calculatedSteps);
        this.running_steps += runSteps;

        // Mark these peaks as processed
        for (let i = runStart; i <= runEnd; i++) {
          this.peaks[i].value = 0;
        }
      }
    }
  }

  // Detect and remove leg shaking
  detectAndRemoveLegShaking() {
    let shakeStart = -1;
    let shakeEnd = -1;

    for (let i = 0; i < this.peaks.length; i++) {
      if (this.peaks[i].value === 0) continue;

      if (this.peaks[i].value > this.SHAKE_START_THRESHOLD && shakeStart === -1) {
        shakeStart = i;
      }

      if (shakeStart !== -1 && this.peaks[i].value < this.SHAKE_START_THRESHOLD) {
        shakeEnd = i;

        let isShaking = true;
        for (let j = shakeStart; j < shakeEnd; j++) {
          if (this.peaks[j].value > this.SHAKE_REGIONAL_PEAK_MAX) {
            isShaking = false;
            break;
          }
        }

        if (isShaking) {
          for (let j = shakeStart; j < shakeEnd && j < this.valleys.length; j++) {
            const peakValDiff = this.peaks[j].value - this.valleys[j].value;
            if (peakValDiff >= this.peaks[j].value - this.SHAKE_PEAK_VALLEY_DIFF) {
              isShaking = false;
              break;
            }
          }
        }

        // Check gyro variance
        if (isShaking && this.gyroBuffer.length > 10) {
          const variance = this.calculateVariance(this.gyroBuffer);
          if (variance > this.SHAKE_VARIANCE_THRESHOLD) {
            isShaking = false;
          }
        }

        if (isShaking) {
          const removedPeaks = shakeEnd - shakeStart;
          this.leg_shake_removed += removedPeaks;

          for (let j = shakeStart; j < shakeEnd; j++) {
            this.peaks[j].value = 0;
          }
        }

        shakeStart = -1;
        shakeEnd = -1;
      }
    }
  }

  // Calculate variance
  calculateVariance(buffer) {
    if (buffer.length < 2) return 0;
    const mean = buffer.reduce((a, b) => a + b, 0) / buffer.length;
    const variance = buffer.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / buffer.length;
    return variance;
  }

  // Count normal steps
  countNormalSteps() {
    let stepCount = 0;
    for (let i = 0; i < this.peaks.length; i++) {
      if (this.peaks[i].value > this.PEAK_THRESHOLD) {
        stepCount++;
      }
    }
    return stepCount;
  }

  // Process accumulated data
  processAccumulatedData() {
    if (this.peaks.length === 0) return;

    this.detectAndCountRunning();
    this.detectAndRemoveLegShaking();
    const normalSteps = this.countNormalSteps();
    
    this.step_count += normalSteps;

    // Clear buffers
    this.peaks = [];
    this.valleys = [];
  }

  // Process chunk of samples
  processChunk(samples) {
    for (const sample of samples) {
      // Calculate combined acceleration
      const combinedAcc = this.calculateCombinedAcceleration(sample.ax, sample.ay, sample.az);
      
      // Apply moving average filter
      const filteredAcc = this.filterProcess(combinedAcc);
      
      // Store in buffer
      this.accBuffer.push(filteredAcc);
      this.gyroBuffer.push(sample.gx || 0);
      
      // Detect peaks and valleys
      this.detectPeaksAndValleys(filteredAcc, this.sample_index);
      
      this.sample_index++;
      
      // Process when buffer reaches window size
      if (this.accBuffer.length >= this.PROCESS_WINDOW_SAMPLES) {
        this.processAccumulatedData();
        
        // Keep last PEAK_WINDOW_N samples for continuity
        this.accBuffer = this.accBuffer.slice(-this.PEAK_WINDOW_N);
        this.gyroBuffer = this.gyroBuffer.slice(-this.PEAK_WINDOW_N);
      }
    }
    
    return this.step_count;
  }
}

/* -----------------------------
   In-memory maps for state (per-collar)
   ----------------------------- */
// Track steps per active session (keyed by `${collar_id}:${session_id}`)
const stepCounterBySession = new Map();
const mappingByCollar = new Map();

// Buffer previous chunk's samples for each session
const lastChunkSamplesBySession = new Map();

// Sum all steps_in_chunk for a given collar+session from the DB
async function getSessionStepTotal(collar_id, session_id) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM((output_metric->>'steps_in_chunk')::numeric), 0) AS total
       FROM collar_chunks
      WHERE collar_id = $1 AND session_id = $2`,
    [collar_id, session_id]
  );
  return Number(rows[0].total || 0);
}

async function getStepCounterParams(collar_id, session_id) {
  const { rows } = await pool.query(
    `SELECT peak_threshold, peak_window_n, filter_window_size, 
            process_window_samples, run_start_threshold, shake_start_threshold
     FROM step_counter_params
     WHERE collar_id = $1 AND session_id = $2
     LIMIT 1`,
    [collar_id, session_id]
  );
  return rows.length > 0 ? rows[0] : {};
}

async function getOrInitStepCounter(collar_id, session_id) {
  const key = `${collar_id}:${session_id}`;
  let sc = stepCounterBySession.get(key);
  if (sc) return sc;

  // Fetch params from DB for this session
  const params = await getStepCounterParams(collar_id, session_id);
  sc = new StepCounter(params);
  // Seed from DB so restarts preserve counts
  sc.step_count = await getSessionStepTotal(collar_id, session_id);
  stepCounterBySession.set(key, sc);
  return sc;
}

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

async function updateCollarOutputMetric(collar_id, session_id, sessionMetric) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE collars
         SET output_metric = jsonb_set(
               jsonb_set(COALESCE(output_metric, '{}'::jsonb),
                         ARRAY['sessions', $2], $3::jsonb, true),
               ARRAY['last_session_id'], to_jsonb($2)),
             updated_at = NOW()
       WHERE collar_id = $1`,
      [collar_id, session_id, JSON.stringify(sessionMetric)]
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

    // If sessionId provided, ensure it exists for this collar
    if (sessionId) {
      const { rows: sessionRows } = await pool.query(
        'SELECT 1 FROM collar_sessions WHERE collar_id = $1 AND session_id = $2 LIMIT 1',
        [cid, sessionId]
      );
      if (sessionRows.length === 0) {
        return res.status(404).json({ error: 'session not found for this collar' });
      }
    }

    // Session-scoped steps (sum of steps_in_chunk for this session)
    let session_steps = null;
    if (sessionId) {
      session_steps = await getSessionStepTotal(cid, sessionId);
    }

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

    // Build response with optional session-scoped steps
    const responsePayload = {
      ...collar,
      temperature_list
    };

    if (session_steps !== null) {
      responsePayload.session_steps = session_steps;

      // If stored per-session metrics exist, surface that session's block
      const sessionsMetric = (collar.output_metric || {}).sessions || {};
      const sessionBlock = sessionsMetric[sessionId] || {};

      responsePayload.output_metric = {
        ...collar.output_metric,
        steps: session_steps,
        session_id: sessionId,
        session_block: sessionBlock
      };
    }

    return res.json(responsePayload);

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

    // Per-session step counter (persists across restarts using DB seed)
    const sc = await getOrInitStepCounter(collar_id, session_id);


      // --- Step counting over two consecutive chunks ---
      const sessionKey = `${collar_id}:${session_id}`;
      let combinedSamples = [];
      if (lastChunkSamplesBySession.has(sessionKey)) {
        // Combine previous chunk's samples with current
        const prevSamples = lastChunkSamplesBySession.get(sessionKey);
        combinedSamples = prevSamples.concat(mapped);
      } else {
        // First chunk, just use current samples
        combinedSamples = mapped;
      }
      const before = sc.step_count;
      sc.processChunk(combinedSamples);
      const after = sc.step_count;

      // Update buffer: store only current chunk's samples for next time
      lastChunkSamplesBySession.set(sessionKey, mapped);

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

    // Persist latest session steps onto collar keyed by collar+session
    await updateCollarOutputMetric(collar_id, session_id, {
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
   Step Counter Params Routes
   ----------------------------- */

/**
 * POST /step-counter-params
 * Insert/update step counter parameters for a session (Sheep Algorithm - Jiang et al. 2023)
 * Body: { collar_id, session_id, peak_threshold, peak_window_n, filter_window_size, 
 *         process_window_samples, run_start_threshold, shake_start_threshold }
 */
app.post('/step-counter-params', async (req, res) => {
  try {
    const {
      collar_id, session_id,
      peak_threshold = 12.0,
      peak_window_n = 4,
      filter_window_size = 5,
      process_window_samples = 100,
      run_start_threshold = 30.0,
      shake_start_threshold = 12.0
    } = req.body;

    if (!collar_id || !session_id) {
      return res.status(400).json({ error: 'collar_id and session_id required' });
    }

    // Validate session exists for this collar
    const isValid = await validateCompositeSession(collar_id, session_id);
    if (!isValid) {
      return res.status(404).json({ error: 'Invalid collar_id/session_id combination' });
    }

    // Upsert: update if exists, else insert
    const { rows } = await pool.query(
      `INSERT INTO step_counter_params
        (collar_id, session_id, peak_threshold, peak_window_n, filter_window_size, 
         process_window_samples, run_start_threshold, shake_start_threshold, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
       ON CONFLICT (collar_id, session_id)
       DO UPDATE SET
         peak_threshold = EXCLUDED.peak_threshold,
         peak_window_n = EXCLUDED.peak_window_n,
         filter_window_size = EXCLUDED.filter_window_size,
         process_window_samples = EXCLUDED.process_window_samples,
         run_start_threshold = EXCLUDED.run_start_threshold,
         shake_start_threshold = EXCLUDED.shake_start_threshold,
         updated_at = NOW()
       RETURNING *`,
      [collar_id, session_id, peak_threshold, peak_window_n, filter_window_size, 
       process_window_samples, run_start_threshold, shake_start_threshold]
    );

    // Clear from cache so next chunk will reload fresh params
    const key = `${collar_id}:${session_id}`;
    stepCounterBySession.delete(key);

    return res.json({ ok: true, params: rows[0] });
  } catch (err) {
    console.error('POST /step-counter-params error', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /step-counter-params/:collar_id
 * Get step counter parameters for a session
 * Query params: session_id (optional - uses active session if not provided)
 */
app.get('/step-counter-params/:collar_id', async (req, res) => {
  try {
    const { collar_id } = req.params;
    let { session_id } = req.query;

    if (!collar_id) {
      return res.status(400).json({ error: 'collar_id required' });
    }

    // If no session_id provided, get active session
    if (!session_id) {
      session_id = await getActiveSessionForCollar(collar_id);
      if (!session_id) {
        return res.status(404).json({ error: 'No active session found for this collar' });
      }
    }

    const { rows } = await pool.query(
      `SELECT * FROM step_counter_params
       WHERE collar_id = $1 AND session_id = $2
       LIMIT 1`,
      [collar_id, session_id]
    );

    if (rows.length === 0) {
      // Return defaults if no record exists
      return res.json({
        ok: true,
        params: {
          collar_id,
          session_id,
          peak_threshold: 12.0,
          peak_window_n: 4,
          filter_window_size: 5,
          process_window_samples: 100,
          run_start_threshold: 30.0,
          shake_start_threshold: 12.0,
          status: 'defaults'
        }
      });
    }

    return res.json({ ok: true, params: rows[0], status: 'stored' });
  } catch (err) {
    console.error('GET /step-counter-params error', err);
    return res.status(500).json({ error: err.message });
  }
});

/* -----------------------------
   Config History Routes
   ----------------------------- */

/**
 * POST /config
 * Insert new config record for a session
 * Body: { collar_id, session_id, emissivity, ssid, password }
 */
app.post('/config', async (req, res) => {
  try {
    const { collar_id, session_id, emissivity, ssid, password, changed_by } = req.body;

    if (!collar_id || !session_id) {
      return res.status(400).json({ error: 'collar_id and session_id required' });
    }

    // Validate session exists for this collar
    const isValid = await validateCompositeSession(collar_id, session_id);
    if (!isValid) {
      return res.status(404).json({ error: 'Invalid collar_id/session_id combination' });
    }

    const { rows } = await pool.query(
      `INSERT INTO collar_config_history 
       (collar_id, session_id, emissivity, ssid, password, changed_by, changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [collar_id, session_id, emissivity || null, ssid || null, password || null, changed_by || 'api']
    );

    return res.json({ ok: true, config: rows[0] });
  } catch (err) {
    console.error('POST /config error', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /config/:collar_id
 * Get latest config for active session (or specific session if session_id provided)
 * Query params: session_id (optional)
 */
app.get('/config/:collar_id', async (req, res) => {
  try {
    const { collar_id } = req.params;
    let { session_id } = req.query;

    if (!collar_id) {
      return res.status(400).json({ error: 'collar_id required' });
    }

    // If no session_id provided, get active session
    if (!session_id) {
      session_id = await getActiveSessionForCollar(collar_id);
      if (!session_id) {
        return res.status(404).json({ error: 'No active session found for this collar' });
      }
    }

    // Get latest config for the session
    const { rows } = await pool.query(
      `SELECT * FROM collar_config_history
       WHERE collar_id = $1 AND session_id = $2
       ORDER BY changed_at DESC
       LIMIT 1`,
      [collar_id, session_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No config found for this session' });
    }

    return res.json({ ok: true, config: rows[0], session_id });
  } catch (err) {
    console.error('GET /config/:collar_id error', err);
    return res.status(500).json({ error: err.message });
  }
});


/* -----------------------------
   Start server
   ----------------------------- */
app.listen(PORT, () => {
  console.log(`Collar backend listening on ${PORT}`);
});
