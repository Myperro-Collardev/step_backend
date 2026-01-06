# Smart Collar Backend - Sheep Step Counter + Firebase

Simplified backend service for processing IMU sensor data to calculate steps using the Jiang et al. (2023) sheep step counting algorithm, and sending results to Firebase Realtime Database.

## Features

### Core Functionality
- **Step Counting**: Jiang et al. (2023) algorithm with 16 configurable parameters
- **Temperature Processing**: Extract and average temperature readings from sensor data
- **Firebase Integration**: Real-time updates to Firebase database
- **Stateless Processing**: No database required, purely calculation-focused

### Algorithm Features (Jiang et al. 2023)
- Peak and valley detection with configurable window sizes
- Running behavior detection and specialized counting
- Leg shaking detection and filtering
- Moving average filter for noise reduction
- Gyroscope variance analysis
- Sample rate: 32 Hz (configurable)

## Tech Stack
- **Runtime**: Node.js
- **Framework**: Express.js
- **Cloud Storage**: Firebase Realtime Database
- **Algorithm**: Sheep step counting (Jiang et al. 2023)

## Installation

```bash
git clone https://github.com/harshdalmia/step_backend.git
cd step_backend
npm install
```

### Dependencies

Install required packages:

```bash
npm install express body-parser firebase-admin dotenv
```

## Firebase Setup

1. **Create Firebase Project**: Go to [Firebase Console](https://console.firebase.google.com/)
2. **Generate Service Account Key**:
   - Go to Project Settings → Service Accounts
   - Click "Generate New Private Key"
   - Save as `serviceAccountKey.json` in project root
3. **Enable Realtime Database**: 
   - Go to Realtime Database in Firebase Console
   - Create database
   - Copy database URL
4. **Set Database Rules** (Public Read/Write):
   - Go to Realtime Database → Rules tab
   - Update rules to:
   ```json
   {
     "rules": {
       ".read": true,
       ".write": true
     }
   }
   ```
   - **Note**: Public read/write rules are enabled for easy access. For production, implement proper security rules.

## Environment Configuration

Create a `.env` file in the root directory:

```env
# Firebase Configuration
FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccountKey.json
FIREBASE_DATABASE_URL=https://myperro-gps-default-rtdb.firebaseio.com

# Server Configuration
PORT=3000
```

**Firebase Database Structure:**
```
Health/
  ├── Steps: <number>
  └── Temp: <number>
```

## Run the Server

```bash
node app.js
```

The server will start on `http://localhost:3000` (or your configured PORT).
## API Documentation

### Collar Management

#### `POST /collars`
Create or update collar with dog metadata.

**Request Body:**
```json
{
  "collar_id": "C001",           // Required
  "dog_name": "Bruno",
  "breed": "Labrador",
  "age": 5,
  "height": 60,
  "weight": 35,
  "sex": "Male",
  "coat_type": "Short",
  "temperature_irgun": 38.5,
  "collar_orientation": "Normal",
  "medical_info": "No allergies",
  "remarks": "Very active dog",
  "new_session": true            // Optional: creates new session
}
```

**Behavior:**
- `new_session: true` → Updates collar + creates new session with dog metadata snapshot
- `new_session: false/omitted` → Only updates collar details

**Response:**
```json
{
  "ok": true,
  "collar": { 
---

### Data Ingestion

#### `PUT /chunks`
Process IMU chunk and calculate steps using Jiang et al. (2023) algorithm.

**Request Body:**
```json
{
  "new_session": true,           // Optional: create session inline
  "data": {
    "chunk_00000000": {
      "collar_id": "C001",       // Required
      "imu_data": "BASE64...",   // Required: 32-byte samples
      "temp_data": [29.5, 29.4], // Optional: temperature array
      "temp_first_timestamp": "2025-12-08T10:00:00Z",
      "real_time": "2025-12-08T10:00:00Z",
      "start_sample": 0,
      "chunk_key": "chunk_00000000"
    }
  }
}
```

**IMU Data Format:**
Each sample is 32 bytes:
- `sample_number` (4 bytes, uint32)
- `timestamp_ms_dev` (4 bytes, uint32)
- `ax, ay, az` (12 bytes, 3 floats)
- `gx, gy, gz` (12 bytes, 3 floats)

**Behavior:**
- Requires active session (returns 400 if missing and `new_session` not set)
- Prevents duplicate processing using `last_sample_number` tracking
- Only processes samples with `sample_number > last_processed`
- Updates session step counter and persists to DB

**Response:**
```json
{
  "ok": true,
  "session_id_used": "111",
  "chunk_id": 42,
  "outputMetric": {
    "steps_in_chunk": 32,
    "cumulative_steps": 1250,
    "samples_processed": 100,
    "total_samples_in_chunk": 100,
    "last_sample_number": 3200,
    "temp_avg_c": 29.55,
    "session_id_used": "111",
    "received_at": "2025-12-08T12:30:00Z"
  }
}
```

**Error Response (no active session):**
```json
{
  "error": "No active session. Call PUT /chunks with {new_session: true} to start a new session."
}
```age": 5,
  "temperature_list": [
    { "temp_c": 29.5, "timestamp": "2025-12-08T10:00:00Z" },
    { "temp_c": 29.6, "timestamp": "2025-12-08T10:00:01Z" }
  ],
  "output_metric": { /* all sessions */ }
}
```

---

### Session Management

#### `GET /sessions/:collar_id`
List all sessions for a collar (active and inactive).

**Response:**
```json
{
  "ok": true,
  "collar_id": "C001",
  "sessions": [
    {
      "session_id": "111",
      "active": true,
      "created_by": "user_request",
      "dog_metadata": {
        "dog_name": "Bruno",
        "breed": "Labrador",
        "age": 5,
        "weight": 35
      },
      "created_at": "2025-12-08T10:00:00Z",
      "chunk_count": 150,
      "total_steps": 1250,
      "last_chunk_at": "2025-12-08T12:30:00Z"
    }
  ],
  "total_sessions": 1
}
```

---

#### `GET /sessions/:collar_id/:session_id`
Get detailed session information and statistics.

**Response:**
```json
---

### Step Counter Algorithm Parameters

#### `POST /step-counter-params`
Configure algorithm parameters for a session (supports partial updates).

**Request Body:**
```json
{
  "collar_id": "C001",           // Required
  "session_id": "111",           // Required
  
  // All parameters below are optional
  // Only provided fields will be updated
  "sample_rate_hz": 32,
  "peak_threshold": 12.0,
  "peak_window_n": 4,
  "valley_window_n": 2,
  "filter_window_size": 5,
  "process_window_samples": 100,
  "run_start_threshold": 30.0,
  "run_end_threshold_high": 20.0,
  "run_end_threshold_low": 12.0,
  "run_peak_valley_diff": 20.0,
  "run_scaling_factor": 2.1,
  "baseline_step_samples": 29,
  "shake_start_threshold": 12.0,
  "shake_peak_valley_diff": 12.0,
  "shake_regional_peak_max": 39.0,
  "shake_variance_threshold": 10.0
}
```

**Response:**
```json
{
  "ok": true,
  "params": { /* all 16 parameters */ }
}
```

**Notes:**
- If record doesn't exist: creates with defaults + provided params
- If record exists: updates **only** the fields you provide
- Clears in-memory cache to reload params on next chunk

---

#### `GET /step-counter-params/:collar_id?session_id=xxx`
Get algorithm parameters for a session.

**Query Parameters:**
- `session_id` (optional): uses active session if not provided

**Response:**
```json
{
  "ok": true,
  "params": {
    "collar_id": "C001",
    "session_id": "111",
    "peak_threshold": 12.0,
    "peak_window_n": 4,
    /* ... all 16 parameters ... */
  },
  "status": "stored"  // or "defaults" if no record exists
}
```

---

### Collar Configuration

#### `POST /config`
Add configuration record for a session.

**Request Body:**
```json
{
  "collar_id": "C001",
  "session_id": "111",
  "emissivity": 0.95,
  "ssid": "WiFiNetwork",
  "password": "secret123",
  "changed_by": "admin"
}
```

**Response:**
```json
{
  "ok": true,
  "config": {
    "id": 1,
    "collar_id": "C001",
    "session_id": "111",
    "emissivity": 0.95,
    "changed_at": "2025-12-08T12:00:00Z"
  }
}
---

## Project Structure

```
step_backend/
├── app.js                    # Main application (step counter + Firebase)
├── serviceAccountKey.json    # Firebase credentials (not committed)
├── package.json              # Dependencies
├── README.md                 # This documentation
└── .env                      # Environment variables (not committed)
```

---

## Algorithm Parameters

The Jiang et al. (2023) algorithm uses 16 configurable parameters (all have defaults):

| Parameter | Default | Description |
|-----------|---------|-------------|
| `sample_rate_hz` | 32 | Sampling frequency |
| `peak_threshold` | 12.0 | Minimum peak value |
| `peak_window_n` | 4 | Peak detection window |
| `valley_window_n` | 2 | Valley detection window |
| `filter_window_size` | 5 | Moving average window |
| `process_window_samples` | 100 | Processing batch size |
| `run_start_threshold` | 30.0 | Running detection start |
| `run_end_threshold_high` | 20.0 | Running end (high) |
| `run_end_threshold_low` | 12.0 | Running end (low) |
| `run_peak_valley_diff` | 20.0 | Running peak-valley diff |
| `run_scaling_factor` | 2.1 | Running step multiplier |
| `baseline_step_samples` | 29 | Baseline samples per step |
| `shake_start_threshold` | 12.0 | Shake detection start |
| `shake_peak_valley_diff` | 12.0 | Shake peak-valley diff |
| `shake_regional_peak_max` | 39.0 | Max shake peak value |
| `shake_variance_threshold` | 10.0 | Gyro variance threshold |

---

## Algorithm Reference

**Based on:** Jiang, S., et al. (2023). "Sheep step counting algorithm using tri-axial accelerometer and gyroscope data."

**Citation:** This implementation follows the sheep step counting methodology described in Jiang et al. (2023), adapted for dog collar applications with configurable parameters.

---

## License

MIT

---

## Support

For issues or questions, please open an issue on GitHub:
https://github.com/harshdalmia/step_backend/issuesesponse:**
```json
{
  "ok": true,
  "config": { /* latest config record */ },
  "session_id": "111"
}
```

---

### Admin & Monitoring

---

## Troubleshooting

### Firebase Connection Issues
- Verify `serviceAccountKey.json` path in `.env`
- Check Firebase Database URL format
- Ensure Realtime Database is enabled in Firebase Console
- Verify database rules are set to public read/write (see Firebase Setup section)

### Step Count Issues
- Check IMU data is properly base64 encoded
- Verify 32-byte sample format
- Review algorithm parameters if needed
- Check accelerometer data is in correct units (m/s²)

### Temperature Issues
- Ensure `temp_data` array is provided
- Verify `temp_first_timestamp` is valid ISO timestamp
- Check temperature values are reasonable (degrees Celsius)

---

## Algorithm Reference

**Based on:** Jiang, S., et al. (2023). "Sheep step counting algorithm using tri-axial accelerometer and gyroscope data."

**Citation:** This implementation follows the sheep step counting methodology described in Jiang et al. (2023), adapted for real-time processing with Firebase integration.

---

## License

MIT

---

## Support

For issues or questions, please open an issue on GitHub:
https://github.com/harshdalmia/step_backend/issues
}
```

---

#### `POST /admin/cleanup-sessions`
Manually trigger memory cleanup (does NOT delete DB records).

**Response:**
```json
{
  "ok": true,
  "message": "Memory caches cleared for inactive sessions. All DB records preserved.",
  "sessions_before": 10,
  "sessions_after": 5,
  "cleaned_up": 5
}
```

---

## Architecture Overview

### Session Lifecycle
1. **Create Session**: `POST /collars` with `new_session: true`
2. **Upload Chunks**: `PUT /chunks` (requires active session)
3. **Monitor Progress**: `GET /sessions/:collar_id/:session_id`
4. **New Session**: Previous session becomes inactive, new one is activated

**Rules:**
- Only ONE active session per collar at a time
- Each session stores dog metadata snapshot at creation
- Step counts are session-scoped and cumulative
- Sessions identified by `collar_id:session_id` composite key

### Memory Management
- **In-Memory Caches**: stepCounterBySession, lastSampleNumberBySession
- **Cleanup Interval**: Every 30 minutes
- **Inactivity Threshold**: 1 hour (sessions not accessed cleared from memory)
- **DB Preservation**: Database records are NEVER deleted
- **Recovery**: On restart/cache miss, state recovered from DB

### Duplicate Prevention
- Tracks `last_sample_number` per session
- Filters out samples with `sample_number ≤ last_processed`
- Persists `last_sample_number` in DB for crash recovery
- Prevents double-counting after server restart or memory cleanup

### Temperature Processing
- Each chunk includes `temp_data[]` and `temp_first_timestamp`
- Reconstructed timestamps: `timestamp_i = temp_first_timestamp + i × 1000ms`
- 1-second interval between temperature samples

### Step Counting Algorithm (Jiang et al. 2023)
**Processing Pipeline:**
1. Calculate combined acceleration magnitude: `√(ax² + ay² + az²)`
2. Apply moving average filter (window size: 5 samples)
3. Detect peaks using window method (window size: 4 samples)
4. Detect valleys using window method (window size: 2 samples)
5. Identify running behavior (threshold: 30.0, scaling: 2.1×)
6. Filter leg shaking using gyro variance (threshold: 10.0)
7. Count normal steps (threshold: 12.0)

**Key Features:**
- 16 configurable parameters per session
- Sample rate: 32 Hz (configurable)
- Processing window: 100 samples
- Peak threshold: 12.0 (configurable)
- Running detection with specialized counting
- Gyroscope-based shake filtering

---

## Database Schema

### Tables
- **`collars`**: Collar profiles, dog metadata, output metrics
- **`collar_sessions`**: Session records with dog snapshots, active flag
- **`collar_chunks`**: IMU chunks, temperature data, per-chunk metrics
- **`step_counter_params`**: Algorithm parameters per session
- **`collar_config_history`**: Configuration history per session

### Key Relationships
- `collars` ← `collar_sessions` (one-to-many)
- `collar_sessions` ← `collar_chunks` (one-to-many)
- `collar_sessions` ← `step_counter_params` (one-to-one)
- `collar_sessions` ← `collar_config_history` (one-to-many)
```equires an active session; pass `new_session: true` to start one inline. If no active session exists and `new_session` is not sent, the request fails.
- Steps are counted per `collar_id + session_id` using an in-memory StepCounter seeded from DB totals.
- Persists per-session metrics on the collar under `output_metric.sessions[session_id]` and updates `output_metric.last_session_id`.

Example (start new session + upload chunk)
```json
{
  "new_session": true,
  "data": {
    "chunk_00000000": {
      "collar_id": "C001",
      "imu_data": "BASE64_STRING",
      "temp_data": [29.5, 29.4],
      "temp_first_timestamp": "2025-12-05T20:21:26Z",
      "real_time": "2025-12-05T20:21:26Z",
      "start_sample": 0
    }
  }
}
```

Example (use existing active session)
```json
{
  "data": {
    "chunk_00000001": {
      "collar_id": "C001",
      "imu_data": "BASE64_STRING",
      "temp_data": [29.7, 29.6],
      "temp_first_timestamp": "2025-12-05T20:22:26Z",
      "real_time": "2025-12-05T20:22:26Z",
      "start_sample": 1000
    }
  }
}
```

Response
```json
{
  "ok": true,
  "session_id_used": "111",
  "chunk_id": 42,
  "outputMetric": {
    "steps_in_chunk": 32,
    "cumulative_steps": 180,
    "temp_avg_c": 29.55,
    "session_id_used": "111",
    "received_at": "2025-12-05T20:22:28Z"
  }
}
```

3) GET /collars
- Lists collars with basic info.
- `output_metric` contains the per-session map and last session id (example: `{ "last_session_id": "111", "sessions": { "111": { "steps": 180, "last_chunk_id": 42, "last_update": "..." } } }`).

4) GET /collars/:collar_id
- Returns collar details and reconstructed temperatures.
- Optional query `session_id` filters data to that session and validates the composite (404 if the session does not belong to the collar).
- When `session_id` is provided:
  - `session_steps` is the sum of `steps_in_chunk` for that session.
  - `temperature_list` is filtered to that session only.
  - `output_metric` is scoped to the requested session: `{ steps, session_id, session_block }` where `session_block` comes from `output_metric.sessions[session_id]`.
- Without `session_id`, all temperatures are returned and `output_metric` is the stored collar-level blob.

Example
```http
GET /collars/C001?session_id=111
```

Example response (session scoped)
```json
{
  "collar_id": "C001",
  "dog_name": "Bruno",
  "temperature_list": [
    { "temp_c": 29.5, "timestamp": "2025-12-05T20:21:26Z" },
    { "temp_c": 29.4, "timestamp": "2025-12-05T20:21:27Z" }
  ],
  "session_steps": 180,
  "output_metric": {
    "steps": 180,
    "session_id": "111",
    "session_block": {
      "steps": 180,
      "last_chunk_id": 42,
      "last_update": "2025-12-05T20:22:28Z"
    }
  }
}
```

Session lifecycle
- Only one active session per collar.
- Start a session via `POST /collars` with `new_session: true` or `PUT /chunks` with `new_session: true` (if a collar exists).
- Chunk uploads are rejected if no active session exists and `new_session` is not sent.

Temperature processing
- Each chunk includes `temp_data[]` and `temp_first_timestamp`.
- Reconstructed timestamps: $timestamp_i = temp\_first\_timestamp + i \times 1000\,ms$.

Step counting (per session)
- IMU samples are decoded, mapped to timestamps using `real_time` + `start_sample` when available.
- Algorithm: gravity smoothing, rotate to global Z, DV filtering, zero-line estimation, falling zero-cross detection, frequency gate (2.25-3.75 Hz), then increment.
- Counter key is `collar_id:session_id`; on restart, the counter seeds from DB by summing `steps_in_chunk` for that session.

Data model (simplified)
- `collars`: collar profile, `output_metric` JSON (includes `last_session_id` and `sessions` map), mapping_json for timestamp alignment.
- `collar_sessions`: one row per session with `active` flag and dog metadata snapshot at creation.
- `collar_chunks`: chunk payloads, `session_id`, temperature array, and per-chunk metrics (including `steps_in_chunk`).

Project Structure
```
app.js          # Main application file with all endpoints and logic
server.js       # Basic server setup (alternative entry point)
package.json    # Dependencies and scripts
README.md       # Documentation
.env            # Environment variables (not committed)
```
