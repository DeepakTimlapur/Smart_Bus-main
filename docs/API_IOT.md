# IoT REST API Reference

All endpoints below are implemented in `app/api/v1/[...route]/route.ts`
(GET handler / POST handler as noted). Base URL: `{server_url}/api/v1`.

## Authentication

Device requests authenticate with two headers:

```
x-device-id: <device_id>
x-api-key: <raw API key issued at registration>
```

`serverDb.authenticateIotDevice(device_id, api_key, target_bus_id?)` hashes
the presented key, compares it to the stored hash, rejects `DEACTIVATED`
devices, and — where a `bus_id` is supplied in the request — rejects a
device posting telemetry for a bus it isn't assigned to. `POST
/heartbeat` also accepts a signed-in `DRIVER`/`ADMIN` Bearer token as an
alternative (useful for a dashboard-triggered manual heartbeat), but every
other IoT endpoint requires the device header pair. Admin-only endpoints
(`devices/register`, `devices/toggle`) require a Bearer JWT with
`role === "ADMIN"` — the device credential alone cannot reach them.

---

## `GET /iot/device/config`

**Added in this pass** — was missing from the original implementation.

Auth: `x-device-id` + `x-api-key` headers (or `?device_id=&api_key=` query
params, for environments where setting custom headers is awkward).

Response `200`:
```json
{
  "success": true,
  "device_id": "PI-BUS-01-ENTRY-a1b2c3",
  "device_name": "Bus 1 Entry Camera",
  "device_type": "RASPBERRY_PI",
  "bus_id": "BUS-01",
  "camera_role": "ENTRY",
  "status": "ONLINE",
  "firmware_version": "v2.4.1",
  "config": {
    "server_time": "2026-09-26T10:00:00.000Z",
    "camera_fps": 10,
    "detection_fps": 10,
    "tracking_fps": 15,
    "recognition_fps": 3,
    "gps_interval_sec": 5,
    "heartbeat_interval_sec": 15,
    "batch_sync_interval_sec": 10,
    "config_refresh_interval_sec": 300,
    "offline_max_batch_size": 25,
    "offline_retry_backoff_base_sec": 5,
    "offline_retry_backoff_max_sec": 300,
    "thresholds": {
      "FACE_MATCH_THRESHOLD": 0.97,
      "HIGH_CONFIDENCE_THRESHOLD": 0.975,
      "LOW_CONFIDENCE_THRESHOLD": 0.94,
      "QUALITY_THRESHOLD": 0.45,
      "LIVENESS_THRESHOLD": 0.05,
      "TEMPORAL_CONSENSUS_THRESHOLD": 0.6,
      "TEMPORAL_WINDOW_FRAMES": 8,
      "TEMPORAL_MIN_FRAMES": 5,
      "BLUR_VARIANCE_MIN": 60.0,
      "AMBIGUOUS_MARGIN": 0.01
    },
    "max_faces_per_frame": 4,
    "track_expiry_sec": 3.0
  }
}
```
`401` if the device credentials are missing/invalid; `403` if deactivated.
These values are currently hard-coded defaults in the route handler (not yet
persisted per-device in MongoDB) — see "Known limitation" below.

---

## `POST /iot/heartbeat`

Body:
```json
{
  "device_id": "PI-BUS-01-ENTRY-a1b2c3",
  "bus_id": "BUS-01",
  "camera_status": "ACTIVE",
  "gps_status": "FIX_ACQUIRED",
  "network_status": "CELLULAR",
  "queued_offline_events": 0,
  "metrics": { "...": "free-form" }
}
```
Response `200`: `{ success, message, device }` with the updated device doc.

## `POST /iot/gps`

Body: `{ bus_id, device_id, latitude, longitude, speed, heading, timestamp }`.
Response `200`: telemetry echo with the persisted timestamp. Rejects `400`
if `latitude`/`longitude` are not numeric.

## `POST /iot/entry-events` / `POST /iot/exit-events`

Body (sent by `api_client.process_face_event`):
```json
{
  "event_id": "uuid4",
  "device_id": "PI-BUS-01-ENTRY-a1b2c3",
  "bus_id": "BUS-01",
  "stop": "GPS (12.34, 56.78)",
  "trip_id": null,
  "camera_role": "ENTRY",
  "faces": [
    {
      "track_id": "track_a1b2c3d4",
      "bbox": { "x": 120, "y": 80, "width": 110, "height": 150 },
      "embedding": [ /* 512 floats -- see docs/EMBEDDING_SPEC.md */ ],
      "quality": { "qualityScore": 0.9, "isAcceptable": true, "blur": 180.2 },
      "liveness": { "isLive": true, "livenessScore": 0.82 },
      "embedding_model": { "model_name": "w600k_mbf", "model_version": "arcface-w600k_mbf-v1", "embedding_dimension": 512, "embedding_normalization": "l2", "production_ready": true }
    }
  ],
  "timestamp": "2026-09-26T10:00:00.000Z"
}
```
Server does identity matching + business-rule validation
(`serverDb.recognizeAndProcessFaces`) and returns per-face outcomes plus a
`processed_faces` array that `main.py._log_biometric_outcome()` logs.
`event_id` is deduped server-side (see `IOT_ARCHITECTURE.md` /
`FACE_ACCURACY_CALIBRATION.md`), so a retried POST after a dropped response
is safe.

## `POST /iot/batch-sync`

Replays queued offline events. Body:
```json
{
  "device_id": "...",
  "bus_id": "...",
  "events": [
    { "event_id": "uuid4", "event_type": "FACE_ENTRY", "payload": { "...": "the original entry-events body" } }
  ],
  "batch_size": 1
}
```
Each event is routed back through the same recognition/GPS logic as its live
counterpart. Response includes `synced_count` and per-event results;
`local_store.py` deletes a row from the local queue only after it is
confirmed synced (see `mark_synced` in `api_client.flush_offline_queue`).

## `POST /iot/devices/register` (ADMIN only)

Body: `{ device_name, bus_id, device_type?, camera_role?, firmware_version? }`.
Response `201`: `{ success, device, raw_api_key }` — `raw_api_key` is
returned **once**, at registration time; only its hash is stored. Copy it
into the device's `config.json` immediately.

## `POST /faces/enroll-samples` (student or admin)

**New in this pass.** Real, server-side face enrollment — see
`docs/EMBEDDING_SPEC.md` and `docs/FACE_RECOGNITION.md`. Body:
```json
{ "images": ["data:image/jpeg;base64,...", "data:image/jpeg;base64,...", "..."] }
```
3-5 JPEG data-URLs captured from the browser's camera. The server (`lib/
face-embedding-server.ts`) decodes, preprocesses, and runs each through the
real ONNX model in one batched inference call, then stores the resulting
512-D embedding(s) with full spec metadata via `serverDb.registerFace()`.

Response `200`: `{ success: true, message, registered_at }`.
Response `503`: the real model isn't installed on this server yet —
```json
{ "detail": "The real face recognition model is not yet installed on this server. See docs/EMBEDDING_SPEC.md for the exact download/install procedure. (...)" }
```
Never falls back to a fake embedding on this path — a 503 means enrollment
did not happen, full stop.

## `POST /faces/migrate-legacy` (ADMIN only)

**New in this pass.** One-time (idempotent) migration: marks every student
whose `face_embedding` predates the current model spec as
`face_enrollment_status: "FACE_REENROLLMENT_REQUIRED"`, excluding them from
`recognizeAndProcessFaces()`'s matching pool. See `docs/FACE_RECOGNITION.md`,
"Migration." Response: `{ success, message, marked, already_ok, total }`.

## `POST /iot/devices/toggle` (ADMIN only)

Body: `{ device_id, status: "ONLINE" | "OFFLINE" | "DEACTIVATED" }`.

---

## Known limitation: config is not yet per-device persisted

`GET /iot/device/config` currently returns the same hard-coded defaults for
every device (merged with the requesting device's own `device_id` /
`bus_id` / `camera_role` /`status` from MongoDB). An admin cannot yet retune
`FACE_MATCH_THRESHOLD` for one bus differently from another through the UI —
doing so would mean adding a `config` sub-document to `IoTDeviceDoc` in
`lib/mongodb.ts`, an admin-facing form to edit it, and reading it in the
`device/config` handler instead of the literal object currently inlined
there. Flagged here rather than silently shipped as "configurable" when it
isn't yet.
