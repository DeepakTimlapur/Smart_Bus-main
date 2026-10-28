# Raspberry Pi IoT Device Setup & Integration Guide

This guide provides step-by-step instructions for deploying the Smart Bus IoT edge daemon on **Raspberry Pi 4 / 5** or industrial single-board computers (SBCs).

---

## 1. Architecture & Data Flow

```
+-------------------------------------------------------------------------+
|                        BUS VEHICLE HARDWARE                             |
|                                                                         |
|  +---------------------------+       +-------------------------------+  |
|  | Entrance Camera (Picam3)  |       | Exit Door Camera (Picam3)     |  |
|  | [Role: ENTRY]             |       | [Role: EXIT]                  |  |
|  +-------------+-------------+       +---------------+---------------+  |
|                |                                     |                  |
|                v                                     v                  |
|  +-------------------------------------------------------------------+  |
|  |                 Raspberry Pi 4 / 5 Edge Daemon                   |  |
|  |                                                                   |  |
|  |   - Multi-Face Detection & Quality Filter (Laplacian variance)    |  |
|  |   - Anti-Spoof Liveness & Motion Analysis                         |  |
|  |   - Serial GPS Telemetry Engine (NEO-6M / SIM7600 NMEA parser)    |  |
|  |   - SQLite Store-and-Forward Offline Queue                        |  |
|  +-----------------------------------+-------------------------------+  |
|                                      |                                  |
|                                      v                                  |
|                      4G / LTE Cellular Modem / Wi-Fi                    |
+--------------------------------------|----------------------------------+
                                       |
                   HTTPS (API Key / Bearer Auth)
                                       |
                                       v
+-------------------------------------------------------------------------+
|                      SMART BUS CLOUD BACKEND                            |
|                                                                         |
|   - POST /api/v1/iot/entry-events      (Student Entry -> BOARDED)      |
|   - POST /api/v1/iot/exit-events       (Student Exit -> EXITED)        |
|   - POST /api/v1/iot/gps               (Live Telemetry & Tracking)     |
|   - POST /api/v1/iot/heartbeat         (Device Health & Queue Metrics) |
|   - POST /api/v1/iot/batch-sync        (Replay Offline Stored Events)  |
|   - MongoDB Transactional Idempotency  (1 Student, 1 Trip Rule)        |
+-------------------------------------------------------------------------+
```

---

## 2. Hardware Bill of Materials (BOM)

| Component | Recommended Model | Specifications |
| :--- | :--- | :--- |
| **Edge Computer** | Raspberry Pi 4B (4GB) or Raspberry Pi 5 | Quad-core ARM Cortex-A72 / A76 |
| **Storage** | SanDisk Extreme Pro 32GB microSD or NVMe M.2 SSD | High write endurance, A2/U3 |
| **Cameras** | Raspberry Pi Camera Module 3 (Wide) or 1080p USB Webcams | Wide FoV (120°), Sony IMX708, autofocus |
| **GPS Receiver** | u-blox NEO-6M / NEO-M8N or Waveshare SIM7600 4G HAT | UART 9600 baud, active external antenna |
| **Cellular Modem** | SIM7600E-H 4G HAT or Quectel EC25 USB Dongle | 4G LTE Cat 4 with GPS combo |
| **Power Supply** | 12V/24V to 5V 3.5A DC-DC Buck Converter | Vehicle electrical transient protection |

---

## 3. Hardware Pinout & Wiring

### GPS Module (NEO-6M) to Raspberry Pi 40-Pin Header

| NEO-6M Pin | Raspberry Pi Pin | Header Pin Number | Function |
| :--- | :--- | :--- | :--- |
| **VCC** | 3.3V or 5V | Pin 1 or Pin 2 | DC Power |
| **GND** | Ground | Pin 6 | System Ground |
| **TX** | GPIO 15 (UART RX) | Pin 10 | GPS NMEA Output to Pi |
| **RX** | GPIO 14 (UART TX) | Pin 8 | Configuration to GPS |

*Note: For the Camera Module 3, connect the flexible flat cable (FFC) to the CAM/DISP CSI port with contacts facing the HDMI ports (Pi 4) or marked CAM/DISP slot (Pi 5).*

---

## 4. Operating System Configuration

### Step 1: Install OS
Flash **Raspberry Pi OS Lite (64-bit)** using the Raspberry Pi Imager tool. Configure SSH, username (`pi`), and Wi-Fi credentials during writing.

### Step 2: Enable Hardware Interfaces
Connect via SSH and execute:
```bash
sudo raspi-config
```
1. **Interface Options → Camera**: Enable `libcamera` support.
2. **Interface Options → Serial Port**:
   - Would you like a login shell accessible over serial? **No**
   - Would you like the serial port hardware to be enabled? **Yes**
3. Finish and reboot:
```bash
sudo reboot
```

### Step 3: Verify Hardware
```bash
# Verify CSI Camera
rpicam-hello --list-cameras

# Verify Serial GPS Output
sudo cat /dev/serial0
# (You should see live NMEA sentences: $GPRMC, $GPGGA, etc.)
```

---

## 5. Software Installation

```bash
# 1. Update system packages
sudo apt update && sudo apt install -y python3-pip python3-venv libgl1 libglib2.0-0 sqlite3

# 2. Clone repository / copy IoT directory
mkdir -p ~/smart-bus-iot
cd ~/smart-bus-iot
cp -r /path/to/raspberry_pi/* .

# 3. Create Python virtual environment
python3 -m venv venv
source venv/bin/activate

# 4. Install dependencies
pip install --upgrade pip
pip install -r requirements.txt

# 5. Install the real face recognition model (see docs/EMBEDDING_SPEC.md
#    for exact download steps -- needs network access, which a Pi normally
#    has even though the sandbox that wrote this guide did not)
mkdir -p models
# cp /path/to/w600k_mbf.onnx models/face_embedding.onnx

# 6. Confirm the model loads and its shapes are correct BEFORE wiring it
#    into the live daemon
python3 embedding_model.py --self-test
```

If `--self-test` fails, do not proceed to running `main.py` expecting real
recognition — fix whatever it reports first (wrong file, wrong model,
`onnxruntime` not installed, shape mismatch). Until it passes, the daemon
will still run (using the classical CV fallback) but recognition will not
be biometrically valid — see `docs/EMBEDDING_SPEC.md`.

---

## 6. Device Configuration (`config.json`)

Edit `~/smart-bus-iot/config.json`:

```json
{
  "server_url": "https://your-smart-bus-server.run.app",
  "device_id": "RPI-BUS01-ENTRY",
  "device_name": "Bus 01 Entrance Camera",
  "api_key": "smartbus_iot_key_b2797d51",
  "bus_id": "BUS-01",
  "camera_role": "ENTRY",
  "camera_source": "0",
  "camera_width": 640,
  "camera_height": 480,
  "gps_port": "/dev/serial0",
  "gps_baudrate": 9600,
  "gps_mock_fallback": false,
  "offline_db_path": "iot_events_queue.db",
  "threshold_overrides": {
    "thresholds": {}
  }
}
```

> **Note:** `camera_fps`, detection/quality thresholds, `gps_interval_sec`,
> `heartbeat_interval_sec`, `batch_sync_interval_sec`, and `max_faces_per_frame`
> are **not** set in this file — the device fetches them from
> `GET /api/v1/iot/device/config` on boot and periodically thereafter, so an
> admin can retune a whole fleet from the server without touching every Pi.
> Use `threshold_overrides` only for a genuine per-device exception (e.g. one
> camera in unusually low light needing a lower `BLUR_VARIANCE_MIN`) — see
> `docs/FACE_ACCURACY_CALIBRATION.md`. Anything under `threshold_overrides`
> always wins over the server's value for that device.

> **Camera Role Selection:**
> - For entrance door device, set `"camera_role": "ENTRY"`.
> - For rear/exit door device, set `"camera_role": "EXIT"`.

---

## 7. Running & Testing

### Before the first real run: verify the model, then test against your own face

Don't skip straight to `main.py` on the Pi. On a dev machine (see
`docs/LOCAL_WEBCAM_TESTING.md`), with the same model file:
```bash
python3 embedding_model.py --self-test   # confirms the model loads and I/O shapes are correct
python3 webcam_test.py                   # live test against your own face via laptop webcam
python3 calibrate_threshold.py --data-dir <real photos>  # real FAR/FRR/EER before trusting any threshold
```
Only once those look right, copy the same `models/face_embedding.onnx` to
the Pi and proceed below.

### Manual Test Run
```bash
source venv/bin/activate
python3 main.py --config config.json
```

Output log example:
```
2026-09-21 08:30:01 [INFO] [SmartBusIoT.Main] Initializing Smart Bus IoT Daemon: RPI-BUS01-ENTRY
2026-09-21 08:30:01 [INFO] [SmartBusIoT.Main] Bus: BUS-01 | Role: ENTRY | Server: http://localhost:3000
2026-09-21 08:30:01 [INFO] [SmartBusIoT.DeviceManager] Device config synced from server (role=ENTRY, thresholds.FACE_MATCH_THRESHOLD=<calibrated value -- see docs/FACE_ACCURACY_CALIBRATION.md>)
2026-09-21 08:30:02 [INFO] [SmartBusIoT.Main] GPS subsystem started
2026-09-21 08:30:02 [INFO] [SmartBusIoT.Main] Initial heartbeat dispatched: SUCCESS
2026-09-21 08:30:02 [INFO] [SmartBusIoT.Main] Vision loop active (up to 4 simultaneous faces). Awaiting passengers at ENTRY door...
2026-09-21 08:30:05 [INFO] [SmartBusIoT.Main] 1 face(s) reached temporal consensus -> submitting to ENTRY gate API (tracks: track_a1b2c3d4)
2026-09-21 08:30:05 [INFO] [SmartBusIoT.Main] ✅ [RECOGNIZED] Anita Sharma (3BR23EC045) -> State: BOARDED
```

---

## 8. Offline Store-and-Forward Resilience Test

To verify the IoT device functions seamlessly through cellular signal dropouts:

1. Start `main.py`.
2. Temporarily disconnect Wi-Fi / unplug Ethernet / turn off hotspot.
3. Have a passenger scan their face at the camera.
4. Verify the client log outputs:
   ```
   [SmartBusIoT.APIClient] Network error processing entry-events, queuing locally: ...
   [SmartBusIoT.LocalStore] Queued offline event: 4a2f8b1c-... (FACE_ENTRY)
   ```
5. Reconnect network.
6. The background worker detects connectivity and flushes the queue:
   ```
   [SmartBusIoT.APIClient] Successfully flushed 1 offline events to server
   ```
7. Verify server database has registered the boarding with original timestamp and idempotency preserved.

---

## 9. Systemd Service Deployment (Boot Autostart)

To ensure the daemon starts automatically on vehicle ignition and auto-restarts upon error:

```bash
# 1. Copy service unit
sudo cp systemd/smart-bus-iot.service /etc/systemd/system/

# 2. Reload systemd daemon
sudo systemctl daemon-reload

# 3. Enable and start service
sudo systemctl enable smart-bus-iot
sudo systemctl start smart-bus-iot

# 4. View live logs
journalctl -u smart-bus-iot -f
```

---

## 10. Hardware Agnostic Device APIs

The backend exposes these hardware-agnostic REST endpoints for any third-party device (Raspberry Pi, Jetson Nano, ESP32-CAM, Android terminals):

| Endpoint | Method | Purpose | Authentication |
| :--- | :--- | :--- | :--- |
| `/api/v1/iot/entry-events` | `POST` | Process entrance camera faces (transition to `BOARDED`) | `x-api-key` or JWT |
| `/api/v1/iot/exit-events` | `POST` | Process exit camera faces (transition to `EXITED`) | `x-api-key` or JWT |
| `/api/v1/iot/gps` | `POST` | Push vehicle coordinates, speed, heading | `x-api-key` or JWT |
| `/api/v1/iot/heartbeat` | `POST` | Device ping, camera status, queue count | `x-api-key` or JWT |
| `/api/v1/iot/batch-sync` | `POST` | Bulk sync queued offline events | `x-api-key` or JWT |
| `/api/v1/iot/device/config` | `GET` | Pull server-issued thresholds/FPS/role for this device | `x-api-key` |
| `/api/v1/trips/:bus_id/stats` | `GET` | Retrieve live passenger counts and occupancy | `x-api-key` or JWT |
| `/api/v1/trips/:bus_id/manifest` | `GET` | List all students and states (`NOT_BOARDED`/`BOARDED`/`EXITED`) | `x-api-key` or JWT |
