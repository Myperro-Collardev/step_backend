🐶 Dog Collar Backend — Express + PostgreSQL + IMU Processing

Full API + Architecture Documentation

📌 Overview

This backend provides:

Collar creation & management

Composite session system (multiple sessions per collar)

IMU chunk ingestion (accelerometer + gyro + temperature)

Step counting algorithm (zero-cross, gravity alignment, filtering)

Temperature history expansion

Per-chunk and cumulative metrics

Timestamp alignment (real_time + start_sample mapping)

🏗 Tech Stack

Node.js + Express

PostgreSQL (Neon / RDS / Local)

In-memory StepCounter per collar

Base64 → IMU binary decoder

Chunk storage + metrics pipeline

🚀 API Endpoints
1️⃣ POST /collars — Create or Update Collar
Create collar
curl "http://localhost:3000/collars" `
  -Method POST `
  -Headers @{ "Content-Type" = "application/json" } `
  -Body '{
    "collar_id": "C001",
    "dog_name": "Bruno",
    "breed": "Labrador"
  }'

Create collar + new session
curl "http://localhost:3000/collars" `
  -Method POST `
  -Headers @{ "Content-Type" = "application/json" } `
  -Body '{
    "collar_id": "C001",
    "new_session": true
  }'

Behavior
Scenario	Result
Collar does not exist	Created
Collar exists	Updated (only dog_name unless extended)
new_session = true	New session created + returned
2️⃣ PUT /chunks — Upload IMU + Temperature Chunk
Normal chunk upload (uses active session)
curl "http://localhost:3000/chunks" `
  -Method PUT `
  -Headers @{ "Content-Type" = "application/json" } `
  -Body '{
    "data": {
      "chunk_00000000": {
        "collar_id": "C001",
        "imu_data": "BASE64_DATA_HERE",
        "temp_data": [29.57, 29.51, 29.37],
        "temp_first_timestamp": "2025-12-05T20:21:26+05:30"
      }
    }
  }'

Create new session + upload chunk
{
  "new_session": true,
  "data": {
    "chunk_xxxx": {
      "collar_id": "C001",
      "imu_data": "...",
      "temp_data": [...],
      "temp_first_timestamp": "..."
    }
  }
}

Error if no session exists
{
  "error": "No active session. Call PUT /chunks with {new_session: true}"
}

3️⃣ GET /collars/:collar_id — Full Collar + Temperature History
curl "http://localhost:3000/collars/C001"

Example Response
{
  "collar_id": "C001",
  "dog_name": "Bruno",
  "breed": "Labrador",
  "temperature_list": [
    { "temp_c": 29.57, "timestamp": "2025-12-05T20:21:26Z" },
    { "temp_c": 29.51, "timestamp": "2025-12-05T20:21:27Z" },
    { "temp_c": 29.37, "timestamp": "2025-12-05T20:21:28Z" }
  ]
}

4️⃣ GET /collars — List All Collars
curl http://localhost:3000/collars

5️⃣ GET /dog/:collar_id — Dog Profile Only
curl http://localhost:3000/dog/C001

6️⃣ GET /metrics/:collar_id — Steps + Latest Chunk Data

(If implemented in your version)

🧠 System Behavior Summary
⭐ Session Handling Logic
Action	Creates New Session?	Notes
POST /collars	❌	Unless new_session=true
POST /collars { new_session: true }	✅	New active session returned
PUT /chunks	❌	Rejects if no active session
PUT /chunks { new_session: true }	✅	Creates new session before processing
⭐ Temperature Handling

Each chunk may include:

temp_data[]

temp_first_timestamp

Backend expands:

timestamp = temp_first_timestamp + index * 1 second


All temps from all chunks aggregated into:

temperature_list[]


Returned in GET /collars/:id.

⭐ Step Counter Pipeline

Base64 decode → IMU sample array

Gravity smoothing filter

Rotational alignment to Z-axis

DV filtering

Zero-line sliding window

Falling zero-cross detection

Frequency check (2.25–3.75 Hz)

Require minimum in-band streak

Increase cumulative step_count

Database stores:

steps in chunk

cumulative steps

last_chunk_id

last_update timestamp

🗄 Database Writes
Operation	Table
Collar create/update	collars
New session	collar_sessions
Chunk ingestion	collar_chunks
Step metric update	collars.output_metric
🔧 Local Development
Install dependencies
npm install

Run Server
node app.js


Make sure your environment has:

DATABASE_URL=postgresql://...
PORT=3000

📦 Project Structure
/app.js
/README.md
/package.json

🧩 Future Improvements (Optional)

Swagger / OpenAPI documentation

Admin dashboard for viewing collars + sessions

Charting step history + temperature history

Add Redis cache for StepCounters

Merge sessions and chunks into timeline view
