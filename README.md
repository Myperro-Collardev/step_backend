Dog Collar Backend — Express + PostgreSQL + IMU Processing

This backend powers a smart dog collar system with collar management, session tracking, IMU chunk ingestion, step counting, and temperature history reconstruction.

Features

- Create and update dog collars with detailed profiles (name, breed, age, weight, etc.)
- Session system (multiple sessions per collar with composite keys)
- Upload IMU chunks (accelerometer, gyro, temperature)
- Step counting using a custom algorithm
- Temperature timeline reconstruction
- Timestamp alignment using real_time + start_sample
- Per-chunk and cumulative metrics storage

Tech Stack

- Node.js
- Express
- PostgreSQL
- Custom IMU decoder
- In-memory StepCounter

Installation

```bash
git clone https://github.com/your-username/dog-collar-backend.git
cd dog-collar-backend
npm install
```

Create a `.env` file:

```
DATABASE_URL=your-postgres-connection-url
PORT=3000
```

Run the server:

```bash
node app.js
```

API Endpoints
1. POST /collars

Create or update a collar.
A new session is created only when new_session: true is included.

Example (Create collar with new session)
{
  "collar_id": "C001",
  "dog_name": "Bruno",
  "breed": "Labrador",
  "age": 3,
  "height": 60,
  "weight": 30,
  "sex": "Male",
  "coat_type": "Short",
  "temperature_irgun": 38.5,
  "collar_orientation": "Normal",
  "medical_info": "No allergies",
  "remarks": "Very active dog",
  "new_session": true
}

Example (Update existing collar)
{
  "collar_id": "C001",
  "dog_name": "Bruno",
  "age": 4,
  "weight": 32
}

2. PUT /chunks

Uploads an IMU + temperature chunk.

Requires an active session. Use new_session: true to create a new session.

Example (with new session)
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

Example (using existing session)
{
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

3. GET /collars

Returns a list of all collars with basic info.

Example Response
```json
[
  {
    "collar_id": "C001",
    "dog_name": "Bruno",
    "breed": "Labrador",
    "created_at": "2025-12-05T20:00:00Z",
    "output_metric": { "steps": 1234, "last_update": "..." }
  }
]
```

4. GET /collars/:collar_id

Returns complete collar details with reconstructed temperature history.

Example Response
```json
{
  "collar_id": "C001",
  "dog_name": "Bruno",
  "breed": "Labrador",
  "age": 3,
  "height": 60,
  "weight": 30,
  "sex": "Male",
  "temperature_list": [
    { "temp_c": 29.5, "timestamp": "2025-12-05T20:21:26Z" },
    { "temp_c": 29.4, "timestamp": "2025-12-05T20:21:27Z" }
  ],
  "output_metric": { "steps": 1234 }
}
```

Session Logic

Sessions are created when:
- POST /collars includes "new_session": true
- PUT /chunks includes "new_session": true

Only one session can be active at a time per collar.

Chunk uploads require an active session. If no active session exists, you must include "new_session": true.

Each session gets a unique session_id (e.g., "111", "222", or a random hex string).

Temperature Processing

Each chunk includes:
- `temp_data[]` - Array of temperature readings
- `temp_first_timestamp` - Starting timestamp

Timestamps are reconstructed as:
```
timestamp[i] = temp_first_timestamp + (i * 1000ms)
```

All chunk temperatures are merged into `temperature_list`.

Step Counting Algorithm

Processing pipeline:

1. Decode IMU base64
2. Gravity smoothing
3. Rotate sample to global Z-axis
4. DV filtering
5. Zero-line estimation
6. Falling zero-cross detection
7. Frequency validation (2.25–3.75 Hz)
8. Step increment
9. Store steps per chunk and cumulative steps

Database Tables
collars

Stores collar info and dog details:
- collar_id (primary key)
- dog_name
- breed
- age (INTEGER)
- height
- weight
- sex
- coat_type
- temperature_irgun
- collar_orientation
- medical_info
- remarks
- output_metric (JSON)
- created_at, updated_at

collar_sessions

Tracks active and inactive sessions:
- collar_id
- session_id
- active (boolean)
- created_by
- created_at

collar_chunks

Stores IMU data, temperature, timestamps, and metrics:
- chunk_id (primary key)
- collar_id
- session_id (composite key)
- chunk_json
- steps_this_chunk
- cumulative_steps
- temperature_list (JSON)
- created_at

Project Structure

```
app.js          # Main application file with all endpoints and logic
server.js       # Basic server setup (alternative entry point)
package.json    # Dependencies and scripts
README.md       # Documentation
.env            # Environment variables (not committed)
```
