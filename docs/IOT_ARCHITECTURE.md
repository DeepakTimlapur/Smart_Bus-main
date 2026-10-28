# IoT Architecture

This describes the actual module layout in `raspberry_pi/` and how it talks to
the Next.js backend, as implemented — not an aspirational diagram.

## Edge daemon module layout

```
raspberry_pi/
├── main.py             Wires everything together; owns the run loop
├── camera.py            Frame capture only (Picamera2 / OpenCV V4L2 / simulated)
├── embedding_spec.py       Canonical embedding spec constants (mirrors
│                          docs/EMBEDDING_SPEC.md and lib/embedding-spec.ts)
├── embedding_model.py     Pluggable embedding backends: ONNXFaceEmbedder
│                          (real ArcFace model, production_ready, ready but
│                          untested here for lack of network to fetch
│                          weights) and HOGLBPEmbedder (classical CV,
│                          working today, explicitly NOT production_ready --
│                          pipeline validation only). Also a CLI:
│                          `python3 embedding_model.py --info` / `--self-test`
├── face_engine.py        Per-frame detection + quality/liveness + BATCH
│                         embedding, plus MultiFaceTracker (independent
│                         tracks per face, up to 4 simultaneous)
├── identity_matcher.py    Optional local UNKNOWN/AMBIGUOUS/RECOGNIZED
│                          decisioning against a synced template cache
├── device_manager.py     Device identity, remote config sync, health/heartbeat
├── api_client.py         Thin REST transport (HTTP only)
├── local_store.py        SQLite offline queue with exponential backoff
├── gps.py                NMEA GPS reader (NEO-6M/M8N over serial), unchanged
├── config.json           Local device config (device_id, bus_id, camera role...)
├── benchmark.py           Dev-mode pipeline latency + recognition benchmark
├── calibrate_threshold.py  Real FAR/FRR/TAR/TRR/EER/ROC calibration from
│                           real face photos; refuses to run against the
│                           dev-mode embedder without an explicit override
├── webcam_test.py          Live single/four-face test via laptop webcam
│                           (Windows/Mac/Linux), see docs/LOCAL_WEBCAM_TESTING.md
└── systemd/smart-bus-iot.service
```

Each module has one job:

- **camera.py** never touches OpenCV's face detector — it only returns raw
  frames. This means swapping camera hardware (or adding a second camera for
  a second door) never requires touching detection code.
- **face_engine.py** is capture-agnostic. It exposes `FrameFaceDetector`
  (per-frame: detect → quality → liveness → embedding) and `MultiFaceTracker`
  (cross-frame: associate detections to persistent tracks via IoU, decide
  when a track has enough temporal consensus to submit). Identity *matching*
  against enrolled students is **not** done here — see `FACE_RECOGNITION.md`
  for why that's intentional.
- **device_manager.py** is the only module that knows about server-issued
  configuration. It fetches `GET /api/v1/iot/device/config` on boot and on a
  refresh interval, merges it under any local `config.json` overrides, and
  exposes `.config` / `.threshold(name)` to the rest of the daemon. `main.py`
  builds the detector and tracker from `device_manager.config`, so retuning
  thresholds from the admin side takes effect on next config refresh without
  a firmware redeploy.
- **api_client.py** only knows HTTP. On failure it hands the payload to
  `local_store.py` and returns; it never blocks the vision loop waiting on
  retries.
- **local_store.py** is the only place SQLite is touched. `event_id` is
  `UNIQUE` at the schema level, so re-enqueuing an event that's already
  queued is a no-op (`INSERT OR IGNORE`), which is what makes the daemon safe
  to crash-and-restart mid-queue without duplicating events.

## Backend embedding modules (Node side)

Mirroring the Pi's Python modules, two new backend files implement the
same spec (`docs/EMBEDDING_SPEC.md`) for browser enrollment:

- `lib/embedding-spec.ts` — the TypeScript mirror of
  `raspberry_pi/embedding_spec.py`. Both must be changed together; see
  either file's header comment.
- `lib/face-embedding-server.ts` — loads the same `.onnx` model file via
  `onnxruntime-node`, decodes/crops/resizes uploaded images via `sharp`,
  and runs real batched inference. Used by the new
  `POST /api/v1/faces/enroll-samples` route (see `API_IOT.md`). Neither
  `onnxruntime-node` nor `sharp` could be installed in this sandbox (no
  network) — both are added to `package.json` and this file is written to
  their documented APIs, but is unverified until `npm install` succeeds on
  a machine with network access.

## Data flow

```
                    BUS VEHICLE (Raspberry Pi 4/5)
 ┌───────────────────────────────────────────────────────────────┐
 │  camera.py (capture)                                          │
 │        │ raw frame                                            │
 │        v                                                      │
 │  face_engine.FrameFaceDetector                                │
 │        │ up to 4 detections/frame: bbox, quality,              │
 │        │ liveness, 512-D embedding (real ONNX model)           │
 │        v                                                      │
 │  face_engine.MultiFaceTracker                                 │
 │        │ IoU-associates each detection to a persistent         │
 │        │ track_id; each track independently accumulates        │
 │        │ consecutive acceptable frames                         │
 │        │                                                      │
 │        └─▶ once a track crosses TEMPORAL_MIN_FRAMES ─┐        │
 │                                                        v        │
 │  api_client.process_face_event()  ◀── device_manager.config    │
 │        │ POST /api/v1/iot/{entry|exit}-events                 │
 │        │ (or local_store.enqueue() on failure)                │
 └────────┼────────────────────────────────────────────────────┘
          │ HTTPS, x-device-id / x-api-key headers
          v
 ┌───────────────────────────────────────────────────────────────┐
 │  Next.js backend  (app/api/v1/[...route]/route.ts)             │
 │        │                                                      │
 │        v                                                      │
 │  lib/server-db.ts                                              │
 │   - authenticateIotDevice() — device_id + api_key -> device     │
 │   - loads enrolled student embeddings, does identity matching   │
 │   - business rule validation (fee, capacity, already-boarded)   │
 │   - atomic idempotency_key write to MongoDB `attendance`        │
 └───────────────────────────────────────────────────────────────┘
```

GPS telemetry and heartbeats run on their own timers in `main.py`'s loop,
independent of face processing — a stalled GPS fix never blocks recognition,
and vice versa (section 19/20 of the original brief).

## Endpoints in use

| Method | Path                              | Caller             | Purpose |
|--------|------------------------------------|---------------------|---------|
| GET    | `/api/v1/iot/device/config`        | device_manager.py   | Pull server-issued thresholds/FPS/role (**added in this pass**) |
| POST   | `/api/v1/iot/heartbeat`            | device_manager.py   | Health/status telemetry |
| POST   | `/api/v1/iot/gps`                  | api_client.py        | Location telemetry |
| POST   | `/api/v1/iot/entry-events`         | api_client.py        | Boarding face events |
| POST   | `/api/v1/iot/exit-events`          | api_client.py        | Deboarding face events |
| POST   | `/api/v1/iot/batch-sync`           | api_client.py        | Replay of `local_store` queue |
| POST   | `/api/v1/iot/devices/register`     | admin dashboard      | Provision a new device (admin-only) |
| POST   | `/api/v1/iot/devices/toggle`       | admin dashboard      | Activate/deactivate a device (admin-only) |

Full request/response shapes are in `API_IOT.md`.

## Security model

The Pi authenticates every request with `x-device-id` + `x-api-key` headers.
`serverDb.authenticateIotDevice()` hashes the presented key and compares it
to the stored hash, rejects deactivated devices, and rejects a device
posting telemetry for a `bus_id` it isn't assigned to. The Pi has no
credential that can reach an `ADMIN`-only route (`devices/register`,
`devices/toggle` both require a user JWT with `role === "ADMIN"`), so a
compromised or physically stolen device can, at worst, submit face events
and GPS for the one bus it's provisioned for — it cannot register new
devices, deactivate other devices, or read another bus's data. Final
authorization (fee validity, capacity, already-boarded state) is decided
server-side in `server-db.ts`, never trusted from the Pi's payload.

## Known gap vs. the original brief

The brief describes `GET /api/v1/iot/device/config` as one of the required
endpoints; it did not exist before this pass and has now been added (see the
GET handler in `app/api/v1/[...route]/route.ts`) — **this has not been
build/lint/type-checked** in this environment because it has no network
access and no `node_modules` installed. Run `npm install && npx tsc --noEmit
&& npm run build` before deploying to confirm it compiles cleanly.
