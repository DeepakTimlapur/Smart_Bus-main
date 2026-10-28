from mobile_face_engine import MobileFaceNetEmbedder
from queue import Queue
import threading
#!/usr/bin/env python3
"""
Smart Bus IoT Edge Daemon
Runs on Raspberry Pi 4 / 5 at bus entrance or exit door.
Handles live camera face processing (detection -> quality/liveness -> tracking
-> temporal-consensus submission), GPS telemetry, and offline store-and-forward.

Module layout (see docs/IOT_ARCHITECTURE.md for the full picture):
    camera.py           - frame capture only (Picamera2 / OpenCV / simulated)
    embedding_model.py   - pluggable REAL embedding backends (classical CV,
                           working today; ONNX deep model, ready but untested
                           here for lack of network to fetch weights)
    face_engine.py       - per-frame detection+quality+liveness+batched
                           embedding, plus MultiFaceTracker (up to 4
                           independent tracks)
    identity_matcher.py  - optional local UNKNOWN/AMBIGUOUS/RECOGNIZED
                           decisioning against a synced template cache
    device_manager.py    - device identity, remote config sync, health state
    api_client.py        - thin REST transport to the Next.js backend
    local_store.py        - SQLite offline queue with exponential backoff
    main.py (this file)   - wires the above into the run loop
"""

import argparse
import cv2
import json
import logging
import os
import signal
import sys
import time
from datetime import datetime, timezone

from api_client import SmartBusAPIClient
from camera import CameraProcessor
from device_manager import DeviceManager
from embedding_model import build_default_embedder
from face_engine import FrameFaceDetector, MultiFaceTracker
from gps import GPSReader
from identity_matcher import LocalIdentityMatcher

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("SmartBusIoT.Main")


class SmartBusEdgeDaemon:
    def __init__(self, config_path: str = "config.json", cli_overrides: dict = None):
        self.config_file = self._load_config(config_path)
        if cli_overrides:
            self.config_file.update({k: v for k, v in cli_overrides.items() if v is not None})

        self.running = False
        self.display_status = "READY - Waiting for face"
        self.display_enabled = True
        self.device_id = self.config_file.get("device_id", "RPI-BUS01-ENTRY")
        self.bus_id = self.config_file.get("bus_id", "BUS-01")
        self.camera_role = self.config_file.get("camera_role", "ENTRY").upper()
        self.server_url = self.config_file.get("server_url", "http://localhost:3000")
        self.api_key = str(self.config_file.get("api_key", "")).strip()

        if not self.api_key:
            raise ValueError(
                "Missing device API key. Register this device and set api_key "
                "in the local config.json file."
            )

        logger.info("Initializing Smart Bus IoT Daemon: %s", self.device_id)
        logger.info("Bus: %s | Role: %s | Server: %s", self.bus_id, self.camera_role, self.server_url)

        # 1. API transport + offline queue
        self.api_client = SmartBusAPIClient(
            server_url=self.server_url,
            device_id=self.device_id,
            api_key=self.api_key,
            bus_id=self.bus_id,
            offline_db_path=self.config_file.get("offline_db_path", "iot_events_queue.db"),
        )

        # 2. Device identity + remote config sync (thresholds, FPS budgets, etc.)
        # Local config.json values under "threshold_overrides" always win over
        # whatever the server issues, for per-device tuning.
        self.device_manager = DeviceManager(
            api_client=self.api_client,
            device_id=self.device_id,
            bus_id=self.bus_id,
            camera_role=self.camera_role,
            local_config_overrides=self.config_file.get("threshold_overrides"),
        )
        self.device_manager.fetch_config()  # best-effort; falls back to defaults if offline

        # 3. GPS reader
        self.gps_reader = GPSReader(
            port=self.config_file.get("gps_port", "/dev/ttyUSB0"),
            baudrate=int(self.config_file.get("gps_baudrate", 9600)),
            mock_fallback=bool(self.config_file.get("gps_mock_fallback", True)),
        )

        # 4. Camera (capture only)
        self.camera = CameraProcessor(
            camera_source=str(self.config_file.get("camera_source", "0")),
            width=int(self.config_file.get("camera_width", 640)),
            height=int(self.config_file.get("camera_height", 480)),
            role=self.camera_role,
        )

        # 5. Embedding backend: real ONNX deep model if configured+available,
        # otherwise the classical CV fallback (always works, no downloads).
        # See embedding_model.py's docstring for the honest capability gap
        # between these two, and docs/FACE_RECOGNITION.md for the critical
        # note about enrollment needing to use this SAME embedder.
        model_path = self.config_file.get("embedding_model_path", "models/face_recognition_sface_2021dec.onnx"); full_model_path = os.path.join(os.path.dirname(__file__), model_path); self.embedder = build_default_embedder(full_model_path if os.path.exists(full_model_path) else model_path)
        logger.info("Embedding backend active: %s", self.embedder.metadata())
        if not self.embedder.production_ready:
            logger.warning(
                "*** RECOGNITION IS NOT BIOMETRICALLY VALID: no production-ready embedding model "
                "is active (see docs/EMBEDDING_SPEC.md for install steps). Faces will be detected, "
                "tracked, and submitted to the server as normal, but the embeddings are placeholder-"
                "grade and the server will exclude them from real student matching (see "
                "docs/FACE_RECOGNITION.md, 'Migration'). ***"
            )

        # 6. Face detection + multi-face tracking, parameterized from device_manager.config
        cfg = self.device_manager.config
        thresholds = cfg.get("thresholds", {})
        self.detector = FrameFaceDetector(
            blur_threshold=float(thresholds.get("BLUR_VARIANCE_MIN", 60.0)),
            max_faces=int(cfg.get("max_faces_per_frame", 4)),
            liveness_threshold=float(thresholds.get("LIVENESS_THRESHOLD", 0.03)),
            embedder=self.embedder,
        )
        self.tracker = MultiFaceTracker(
            temporal_window_frames=int(thresholds.get("TEMPORAL_WINDOW_FRAMES", 8)),
            temporal_min_frames=int(thresholds.get("TEMPORAL_MIN_FRAMES", 5)),
            track_expiry_sec=float(cfg.get("track_expiry_sec", 3.0)),
        )

        # 7. Optional on-device identity pre-check. Templates start empty (see
        # identity_matcher.py's scope note -- there is no template-sync
        # endpoint yet), so every local match is UNKNOWN until
        # self.identity_matcher.sync_templates(...) is called from somewhere
        # that has enrolled templates. Harmless either way: the server call
        # in api_client.process_face_event is still the authoritative path.
        self.identity_matcher = LocalIdentityMatcher(
            face_match_threshold=float(thresholds.get("FACE_MATCH_THRESHOLD", 0.62)),
            high_confidence_threshold=float(thresholds.get("HIGH_CONFIDENCE_THRESHOLD", 0.78)),
            ambiguous_margin=float(thresholds.get("AMBIGUOUS_MARGIN", 0.05)),
        )
        local_templates_path = self.config_file.get("local_templates_path")
        if local_templates_path and os.path.exists(local_templates_path):
            try:
                with open(local_templates_path) as f:
                    self.identity_matcher.sync_templates(json.load(f))
            except Exception as e:
                logger.warning("Could not load local_templates_path %s: %s", local_templates_path, e)

    def _load_config(self, path: str) -> dict:
        if os.path.exists(path):
            try:
                with open(path, "r") as f:
                    return json.load(f)
            except Exception as e:
                logger.warning("Could not parse %s, using defaults: %s", path, e)
        return {}

    def start(self):
        self.running = True
        signal.signal(signal.SIGINT, self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)

        self.gps_reader.start()
        logger.info("GPS subsystem started")

        self.api_client.start_background_sync(
            interval_sec=int(self.device_manager.config.get("batch_sync_interval_sec", 10))
        )
        self.device_manager.start_config_refresh()

        self._send_initial_heartbeat()
        self._run_vision_loop()

    def _handle_signal(self, signum, frame):
        logger.info("Received termination signal (%d), shutting down cleanly...", signum)
        self.stop()
        sys.exit(0)

    def stop(self):
        self.running = False
        self.gps_reader.stop()
        self.api_client.stop_background_sync()
        self.device_manager.stop_config_refresh()
        self.camera.close()
        logger.info("Smart Bus IoT Daemon stopped.")

    def _send_initial_heartbeat(self):
        loc = self.gps_reader.get_location()
        self.device_manager.update_health(
            camera_status="ACTIVE",
            gps_status="FIX_ACQUIRED" if loc.get("fix") else "SEARCHING",
            network_status="CELLULAR",
        )
        ok = self.device_manager.send_heartbeat(
            queued_events=self.api_client.get_queued_count(),
            extra_metrics={"startup_time": datetime.now(timezone.utc).isoformat()},
        )
        logger.info("Initial heartbeat dispatched: %s", "SUCCESS" if ok else "OFFLINE/PENDING")

    def _run_vision_loop(self):
        """Continuous camera capture -> detect -> track -> (submit_ready) -> API loop."""
        fps = int(self.device_manager.config.get("camera_fps", 10))
        frame_delay = 1.0 / max(1, fps)

        last_gps_send = 0.0
        last_heartbeat = 0.0
        gps_interval = float(self.device_manager.config.get("gps_interval_sec", 5.0))
        heartbeat_interval = float(self.device_manager.config.get("heartbeat_interval_sec", 15.0))

        logger.info(
            "Vision loop active (up to %d simultaneous faces). Awaiting passengers at %s door...",
            int(self.device_manager.config.get("max_faces_per_frame", 4)),
            self.camera_role,
        )

        frame_counter = 0
        
        
        frame_skip_counter = 0
        while self.running:
            frame_skip_counter += 1
            run_inference = (frame_skip_counter % 3 == 0)
            frame_skip_counter += 1
            frame_skip_counter += 1
            frame_counter += 1
            now = time.time()

            if now - last_gps_send >= gps_interval:
                loc = self.gps_reader.get_location()
                self.api_client.send_gps(
                    latitude=loc["latitude"], longitude=loc["longitude"],
                    speed=loc["speed"], heading=loc["heading"],
                )
                last_gps_send = now

            if now - last_heartbeat >= heartbeat_interval:
                loc = self.gps_reader.get_location()
                self.device_manager.update_health(
                    camera_status="ACTIVE",
                    gps_status="FIX_ACQUIRED" if loc.get("fix") else "SEARCHING",
                    network_status="CELLULAR",
                )
                self.device_manager.send_heartbeat(queued_events=self.api_client.get_queued_count())
                last_heartbeat = now

            frame = self.camera.capture_frame()
            if frame is None:
                time.sleep(0.1)
                continue

            # Detect this frame's faces (independent per-face quality/liveness),
            # with BATCH embedding inference across all faces in the frame.
            detections = self.detector.process(frame, role=self.camera_role, simulated=self.camera.is_simulated)

            # Associate with persistent, isolated tracks and find out which
            # tracks just crossed the temporal-consensus threshold this frame.
            track_results = self.tracker.update(detections)

            # Optional local pre-check, purely for instant local feedback
            # (LED/buzzer) -- run independently per track so one face's
            # candidate identity can never leak into another's (same
            # no-cross-talk guarantee as bbox/embedding/quality/liveness).
            # This NEVER substitutes for the server's authoritative decision
            # below; it only updates each Track's own state fields.
            #
            # GATED on self.embedder.production_ready: with the dev-mode
            # HOGLBPEmbedder active (no real model installed -- see
            # docs/EMBEDDING_SPEC.md), a "RECOGNIZED" result here would not
            # be a real biometric match, so it's never even computed --
            # verification_state stays "PENDING_MODEL_NOT_INSTALLED" rather
            # than showing a misleadingly confident status.
            for track, det, submit_ready in track_results:
                if submit_ready:
                    if not self.embedder.production_ready:
                        # Dynamic student label display
                        label_text = getattr(track, "candidate_identity", None) or "VERIFYING..."
                        track.similarity_score = 0.0
                        track.verification_state = "PENDING_MODEL_NOT_INSTALLED"
                        continue
                    local_result = self.identity_matcher.match(det["embedding"])
                    # Dynamic student label display
                    label_text = getattr(track, "candidate_identity", None) or "VERIFYING..."
                    track.similarity_score = round(local_result.similarity, 4)
                    track.verification_state = local_result.status
                    if local_result.status != "UNKNOWN" or self.identity_matcher.templates:
                        logger.debug(
                            "[%s] local pre-check: %s (similarity=%.3f, second=%.3f)",
                            track.track_id, local_result.status, local_result.similarity,
                            local_result.second_best_similarity,
                        )

            ready_faces = [
                {**det, "track_id": track.track_id}
                for track, det, submit_ready in track_results
                if submit_ready
            ]

            # Fail closed: simulation and non-production models must never
            # generate real passenger access-control events.
            if ready_faces and self.camera.is_simulated:
                logger.error(
                    "BLOCKED: refusing biometric event submission from a simulated camera"
                )
                ready_faces = []

            if ready_faces and not self.embedder.production_ready:
                logger.error(
                    "BLOCKED: refusing biometric event submission because "
                    "the embedding model is not production-ready"
                )
                ready_faces = []


            if ready_faces:
                loc = self.gps_reader.get_location()
                current_stop = f"GPS ({loc['latitude']}, {loc['longitude']})"
                logger.info(
                    "%d face(s) reached temporal consensus -> submitting to %s gate API (tracks: %s)",
                    len(ready_faces), self.camera_role,
                    ", ".join(f["track_id"] for f in ready_faces),
                )
                result = self.api_client.process_face_event(
                    camera_role=self.camera_role,
                    faces=ready_faces,
                    current_stop=current_stop,
                )

                # Only an immediate authoritative server response may decide a face.
                if not result.get("offline_queued") and result.get("event_status") != "IN_PROGRESS":
                    if not hasattr(self, "server_face_results"):
                        self.server_face_results = {}
                    if not hasattr(self, "_feedback_beeped_tracks"):
                        self._feedback_beeped_tracks = set()
                    if not hasattr(self, "_face_buzzer"):
                        from buzzer_feedback import BuzzerFeedback
                        self._face_buzzer = BuzzerFeedback()

                    processed = result.get("processed_faces", [])
                    for item in processed:
                        if not isinstance(item, dict):
                            continue
                        index = item.get("face_index")
                        if not isinstance(index, int) or index < 0 or index >= len(ready_faces):
                            continue
                        track_id = str(ready_faces[index].get("track_id", ""))
                        status = str(item.get("status", "UNKNOWN")).upper()
                        student_id = str(item.get("student_id") or "").strip()
                        recognized = (
                            bool(student_id)
                            and student_id.upper() not in ("UNKNOWN", "N/A", "NONE")
                            and status not in ("UNKNOWN", "LOW CONFIDENCE")
                        )
                        display_label = f"{student_id} | {status}" if recognized else "UNVERIFIED"
                        self.server_face_results[track_id] = {
                            "verified": recognized,
                            "label": display_label,
                            "student_id": student_id if recognized else "",
                            "status": status,
                        }
                        if track_id and track_id not in self._feedback_beeped_tracks:
                            self._feedback_beeped_tracks.add(track_id)
                            self._face_buzzer.beep(1 if recognized else 3)

                threading.Thread(target=self._log_biometric_outcome, args=(result,), daemon=True).start()

            # Live preview: display the real frame and current processing status.
            if self.display_enabled:
                try:
                    preview = frame.copy()

                    for track, det, submit_ready in track_results:
                        bbox = (
                            det.get("bbox")
                            or det.get("box")
                            or det.get("face_bbox")
                        )

                        server_face = getattr(self, "server_face_results", {}).get(str(track.track_id))
                        if server_face:
                            label = server_face["label"]
                            box_color = (0, 255, 0) if server_face["verified"] else (0, 0, 255)
                        else:
                            label = "PENDING SERVER" if submit_ready else str(
                                getattr(track, "verification_state", "VERIFYING")
                            )
                            box_color = (0, 255, 255)

                        if isinstance(bbox, dict):
                            if all(k in bbox for k in ("x", "y", "width", "height")):
                                x, y = int(bbox["x"]), int(bbox["y"])
                                coords = [x, y, x + int(bbox["width"]), y + int(bbox["height"])]
                            else:
                                coords = [
                                    bbox.get("x1", bbox.get("left")),
                                    bbox.get("y1", bbox.get("top")),
                                    bbox.get("x2", bbox.get("right")),
                                    bbox.get("y2", bbox.get("bottom")),
                                ]
                        elif isinstance(bbox, (list, tuple)) and len(bbox) >= 4:
                            coords = list(bbox)[:4]
                        else:
                            coords = None

                        x1 = y1 = 0
                        if coords and all(v is not None for v in coords):
                            x1, y1, x2, y2 = map(int, coords)
                            cv2.rectangle(
                                preview, (x1, y1), (x2, y2), box_color, 2
                            )
                        cv2.putText(
                            preview,
                            f"{track.track_id} | {label}",
                            (max(0, x1), max(25, y1 - 10)),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            0.55,
                            box_color,
                            2,
                        )

                    cv2.imshow("Smart Bus - Face Verification", preview)

                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        self.stop()
                        break

                except Exception as exc:
                    self.display_enabled = False
                    logger.exception("Live preview disabled; full traceback follows")
                    try:
                        cv2.destroyAllWindows()
                    except Exception:
                        pass

            time.sleep(frame_delay)

    def _log_biometric_outcome(self, result: dict):
        if result.get("offline_queued"):
            logger.info("Ã°Å¸â€œÂ¦ [OFFLINE QUEUED] Event ID: %s", result.get("event_id"))
            return

        processed = result.get("processed_faces", [])
        for pf in processed:
            status = pf.get("status")
            name = pf.get("name", "Unknown")
            sid = pf.get("student_id", "N/A")
            state = pf.get("passenger_state", "")
            self.display_status = f"{status}: {name} ({sid})"

            if status in ("RECOGNIZED", "EXIT SUCCESSFUL"):
                logger.info("Ã¢Å“â€¦ [%s] %s (%s) -> State: %s", status, name, sid, state)
            elif status in ("ALREADY BOARDED", "ALREADY EXITED"):
                logger.info("Ã¢â€žÂ¹Ã¯Â¸Â [%s] %s (%s) -> Idempotency preserved", status, name, sid)
            elif "DENIED" in status or "NOT BOARDED" in status:
                logger.warning("Ã¢â€ºâ€ [%s] %s (%s): %s", status, name, sid, pf.get("message", ""))
            else:
                logger.info("Ã°Å¸â€Â [%s] %s", status, pf.get("message", ""))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Smart Bus IoT Client for Raspberry Pi")
    parser.add_argument("--config", default="config.json", help="Path to config.json")
    parser.add_argument("--role", choices=["ENTRY", "EXIT"], help="Override camera role")
    parser.add_argument("--bus-id", help="Override bus ID")
    parser.add_argument("--device-id", help="Override device ID")
    parser.add_argument("--server", help="Override backend server URL")
    args = parser.parse_args()

    overrides = {
        "camera_role": args.role,
        "bus_id": args.bus_id,
        "device_id": args.device_id,
        "server_url": args.server,
    }

    daemon = SmartBusEdgeDaemon(config_path=args.config, cli_overrides=overrides)
    daemon.start()



