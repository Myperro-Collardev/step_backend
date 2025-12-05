Dog Collar Backend — Express + PostgreSQL + IMU Processing

This backend powers a smart dog collar system with collar management, session tracking, IMU chunk ingestion, step counting, and temperature history reconstruction.

Features

Create and update dog collars

Session system (multiple sessions per collar)

Upload IMU chunks (accelerometer, gyro, temperature)

Step counting using a custom algorithm

Temperature timeline reconstruction

Timestamp alignment using real_time + start_sample

Per-chunk and cumulative metrics storage

Tech Stack

Node.js

Express

PostgreSQL

Custom IMU decoder

In-memory StepCounter

Installation
git clone https://github.com/your-username/dog-collar-backend.git
cd dog-collar-backend
npm install


Create a .env file:

DATABASE_URL=your-postgres-connection-url
PORT=3000


Run the server:

node app.js

API Endpoints
1. POST /collars

Create or update a collar.
A new session is created only when new_session: true is included.

Example
{
  "collar_id": "C001",
  "dog_name": "Bruno",
  "new_session": true
}

2. PUT /chunks

Uploads an IMU + temperature chunk.

Requires an active session unless new_session: true is sent.

Example
{
  "new_session": true,
  "data": {
    "chunk_0001": {
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

Returns a list of all collars.

4. GET /collars/:collar_id

Returns the collar details and reconstructed temperature history.

Example Response
{
  "collar_id": "C001",
  "dog_name": "Bruno",
  "temperature_list": [
    { "temp_c": 29.57, "timestamp": "2025-12-05T20:21:26Z" },
    { "temp_c": 29.51, "timestamp": "2025-12-05T20:21:27Z" }
  ]
}

5. GET /dog/:collar_id

Returns dog-only profile information.

Session Logic

Sessions are not created automatically.

Sessions are created only when:

POST /collars includes "new_session": true

PUT /chunks includes "new_session": true

Only one session can be active at a time.

Chunk uploads without an active session return an error.

Temperature Processing

Each chunk includes:

temp_data[]

temp_first_timestamp

Timestamps are reconstructed as:

timestamp[i] = temp_first_timestamp + (i * 1000ms)


All chunk temperatures are merged into temperature_list.

Step Counting Algorithm

Processing pipeline:

Decode IMU base64

Gravity smoothing

Rotate sample to global Z-axis

DV filtering

Zero-line estimation

Falling zero-cross detection

Frequency validation (2.25–3.75 Hz)

Step increment

Store steps per chunk and cumulative steps

Database Tables
collars

Stores collar info + metrics.

collar_sessions

Tracks active and inactive sessions.

collar_chunks

Stores IMU data, temperature, timestamps, and metrics.

Project Structure
app.js
package.json
README.md
