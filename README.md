Dog Collar Backend - Express + PostgreSQL + IMU Processing

Backend for the smart dog collar system: collars + sessions, IMU chunk ingestion, per-session step counting, and temperature history.

Features
- Collar CRUD with dog metadata snapshots per session
- Explicit session lifecycle (one active session per collar)
- IMU chunk ingestion with per-session step counting
- Temperature reconstruction from chunk timestamps
- Per-session output metrics persisted on collars

Tech Stack
- Node.js
- Express
- PostgreSQL
- Custom IMU decoder
- In-memory StepCounter (seeded from DB per session)

Installation
```bash
git clone https://github.com/your-username/dog-collar-backend.git
cd dog-collar-backend
npm install
```

Environment
```
DATABASE_URL=your-postgres-connection-url
PORT=3000
```

Run the server
```bash
node app.js
```

API Endpoints
1) POST /collars
- Creates or updates a collar.
- When `new_session: true`, updates dog details, captures a snapshot for the session, creates/activates the session, and returns `session_id`.
- When `new_session` is omitted/false, only collar details are updated (no new session).

Example (create/update + new session)
```json
{
  "collar_id": "C001",
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
  "new_session": true
}
```

Response
```json
{
  "ok": true,
  "collar": { "collar_id": "C001", "dog_name": "Bruno", "age": 5, ... },
  "session_id": "111",
  "message": "Dog details updated and new session created with snapshot."
}
```

2) PUT /chunks
- Ingests an IMU + temperature chunk.
- Requires an active session; pass `new_session: true` to start one inline. If no active session exists and `new_session` is not sent, the request fails.
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
