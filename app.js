/**
 * app.js - Simplified Step Counter + Firebase
 * Calculate steps from IMU data and send to Firebase
 * 
 * Endpoint:
 *  POST /process-chunk -> Calculate steps and temperature, send to Firebase
 *  GET /health -> Health check
 * 
 * Firebase Rules: Public read/write enabled (no authentication required)
 */
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');

const PORT = process.env.PORT || 3000;

// Firebase REST API URLs (public read/write)
const FIREBASE_STEPS_URL = process.env.FIREBASE_STEPS_URL || 'https://myperro-gps-default-rtdb.firebaseio.com/Health/Steps.json';
const FIREBASE_TEMP_URL = process.env.FIREBASE_TEMP_URL || 'https://myperro-gps-default-rtdb.firebaseio.com/Health/Temp.json';

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
    this.SAMPLE_RATE_HZ = params.sample_rate_hz || 32;
    this.SAMPLE_PERIOD_MS = 1000 / this.SAMPLE_RATE_HZ;
    
    this.PEAK_THRESHOLD = params.peak_threshold || 12.0;
    this.PEAK_WINDOW_N = params.peak_window_n || 4;
    this.VALLEY_WINDOW_N = params.valley_window_n || 2;
    this.FILTER_WINDOW_SIZE = params.filter_window_size || 5;
    this.PROCESS_WINDOW_SAMPLES = params.process_window_samples || 100;
    
    // Running behavior thresholds
    this.RUN_START_THRESHOLD = params.run_start_threshold || 30.0;
    this.RUN_END_THRESHOLD_HIGH = params.run_end_threshold_high || 20.0;
    this.RUN_END_THRESHOLD_LOW = params.run_end_threshold_low || 12.0;
    this.RUN_PEAK_VALLEY_DIFF = params.run_peak_valley_diff || 20.0;
    this.RUN_SCALING_FACTOR = params.run_scaling_factor || 2.1;
    this.BASELINE_STEP_SAMPLES = params.baseline_step_samples || 29;
    
    // Leg shaking thresholds
    this.SHAKE_START_THRESHOLD = params.shake_start_threshold || 12.0;
    this.SHAKE_PEAK_VALLEY_DIFF = params.shake_peak_valley_diff || 12.0;
    this.SHAKE_REGIONAL_PEAK_MAX = params.shake_regional_peak_max || 39.0;
    this.SHAKE_VARIANCE_THRESHOLD = params.shake_variance_threshold || 10.0;

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
    const n = this.accBuffer.length;
    
    // Need enough history for window (check center point at n - PEAK_WINDOW_N - 1)
    if (n < this.PEAK_WINDOW_N * 2 + 1) return;

    const centerIdx = n - this.PEAK_WINDOW_N - 1;
    if (centerIdx < this.PEAK_WINDOW_N) return;
    
    const centerVal = this.accBuffer[centerIdx];

    // Peak detection: center must be maximum in window
    let isPeak = centerVal > this.PEAK_THRESHOLD;
    if (isPeak) {
      for (let i = -this.PEAK_WINDOW_N; i <= this.PEAK_WINDOW_N; i++) {
        if (i === 0) continue;
        const idx = centerIdx + i;
        if (idx >= 0 && idx < n) {
          if (this.accBuffer[idx] >= centerVal) {
            isPeak = false;
            break;
          }
        }
      }
    }

    if (isPeak) {
      this.peaks.push({ 
        value: centerVal, 
        index: this.sample_index - (n - centerIdx),
        processed: false 
      });
    }

    // Valley detection: center must be minimum in window
    let isValley = true;
    for (let i = -this.VALLEY_WINDOW_N; i <= this.VALLEY_WINDOW_N; i++) {
      if (i === 0) continue;
      const idx = centerIdx + i;
      if (idx >= 0 && idx < n) {
        if (this.accBuffer[idx] <= centerVal) {
          isValley = false;
          break;
        }
      }
    }

    if (isValley) {
      this.valleys.push({ 
        value: centerVal, 
        index: this.sample_index - (n - centerIdx) 
      });
    }
  }

  // Detect and count running behavior
  detectAndCountRunning() {
    let runStart = -1;
    let runEnd = -1;

    for (let i = 0; i < this.peaks.length; i++) {
      if (this.peaks[i].processed) continue;
      
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

    if (runStart !== -1 && runEnd !== -1 && runEnd > runStart) {
      let isRunning = true;
      for (let i = runStart; i < Math.min(runEnd, this.valleys.length); i++) {
        if (i < this.peaks.length && i < this.valleys.length) {
          const peakValDiff = this.peaks[i].value - this.valleys[i].value;
          if (peakValDiff >= this.peaks[i].value - this.RUN_PEAK_VALLEY_DIFF) {
            isRunning = false;
            break;
          }
        }
      }

      if (isRunning) {
        const windowSize = this.peaks[runEnd].index - this.peaks[runStart].index;
        const calculatedSteps = (windowSize * this.RUN_SCALING_FACTOR) / this.BASELINE_STEP_SAMPLES;
        const runSteps = Math.round(calculatedSteps);
        this.running_steps += runSteps;

        // Mark these peaks as processed
        for (let i = runStart; i <= runEnd; i++) {
          if (i < this.peaks.length) {
            this.peaks[i].processed = true;
          }
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
      
      // Process every second (SAMPLE_RATE_HZ samples) or when buffer reaches max
      if (this.accBuffer.length >= this.SAMPLE_RATE_HZ || 
          this.accBuffer.length >= this.PROCESS_WINDOW_SAMPLES) {
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
   Routes
   ----------------------------- */

/**
 * POST /process-chunk
 * Process IMU chunk, calculate steps, send to Firebase
 */
app.post('/process-chunk', async (req, res) => {
  try {
    const { data } = req.body;

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: "data object required" });
    }

    const chunkKeyName = Object.keys(data)[0];
    const chunkObj = data[chunkKeyName];

    // Decode IMU data
    const decoded = decodeChunkJson(chunkObj);

    // Calculate steps
    const sc = new StepCounter();
    const steps = sc.processChunk(decoded.samples);

    // Process temperature
    const temperature_list = [];
    if (decoded.temp_data && decoded.temp_data.length > 0 && decoded.temp_first_timestamp) {
      let t0 = new Date(decoded.temp_first_timestamp).getTime();
      const intervalMs = 1000;

      decoded.temp_data.forEach((tempValue, index) => {
        temperature_list.push({
          temp_c: tempValue,
          timestamp: new Date(t0 + index * intervalMs).toISOString()
        });
      });
    }

    const temp_avg = temperature_list.length > 0
      ? temperature_list.reduce((sum, t) => sum + t.temp_c, 0) / temperature_list.length
      : null;

    // Send to Firebase using REST API (PUT requests)
    await fetch(FIREBASE_STEPS_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(steps)
    });

    await fetch(FIREBASE_TEMP_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(temp_avg)
    });

    console.log(`[Firebase] Updated Steps=${steps}, Temp=${temp_avg?.toFixed(2)}`);

    return res.json({
      ok: true,
      steps: steps,
      temperature: temp_avg,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error("POST /process-chunk error", err);
    return res.status(500).json({ error: err.message });
  }
});/**
 * GET /health
 */
app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    ok: true,
    uptime: process.uptime(),
    memory: {
      rss_mb: Math.round(memUsage.rss / 1024 / 1024),
      heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024)
    }
  });
});

/* -----------------------------
   Start server
   ----------------------------- */
app.listen(PORT, () => {
  console.log(`Step Counter + Firebase backend listening on port ${PORT}`);
});