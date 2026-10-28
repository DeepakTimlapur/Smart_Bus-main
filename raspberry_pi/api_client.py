"""Smart Bus IoT API transport and offline event synchronization."""
import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import requests
from local_store import LocalEventStore

logger = logging.getLogger("SmartBusIoT.APIClient")


class SmartBusAPIClient:
    def __init__(
        self,
        server_url: str = "http://localhost:3000",
        device_id: str = "RPI-BUS01-ENTRY",
        api_key: str = "",
        bus_id: str = "BUS-01",
        offline_db_path: str = "iot_events_queue.db",
        timeout: float = 4.0,
        retry_backoff_base_sec: float = 5.0,
        retry_backoff_max_sec: float = 300.0,
    ):
        self.server_url = server_url.rstrip("/")
        self.device_id = device_id
        self.api_key = api_key
        self.bus_id = bus_id
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "Content-Type": "application/json",
            "x-device-id": device_id,
            "x-api-key": api_key,
            "User-Agent": f"SmartBus-IoT/{device_id}",
        })
        self.store = LocalEventStore(
            db_path=offline_db_path,
            retry_backoff_base_sec=retry_backoff_base_sec,
            retry_backoff_max_sec=retry_backoff_max_sec,
        )
        self._sync_thread = None
        self._running = False

    def start_background_sync(self, interval_sec: int = 10):
        if self._sync_thread and self._sync_thread.is_alive():
            return
        self._running = True
        self._sync_thread = threading.Thread(
            target=self._sync_loop, args=(interval_sec,),
            daemon=True, name="IoTOfflineSyncWorker",
        )
        self._sync_thread.start()

    def stop_background_sync(self):
        self._running = False

    def get_device_config(self) -> Optional[Dict[str, Any]]:
        try:
            res = self.session.get(
                f"{self.server_url}/api/v1/iot/device/config",
                timeout=self.timeout,
            )
            if res.status_code == 200:
                return res.json()
            logger.warning("Device config returned HTTP %s", res.status_code)
        except Exception as exc:
            logger.warning("Device config request failed: %s", exc)
        return None

    def send_heartbeat(
        self, camera_status="ACTIVE", gps_status="FIX_ACQUIRED",
        network_status="CELLULAR", metrics=None,
    ) -> bool:
        body = {
            "device_id": self.device_id, "bus_id": self.bus_id,
            "camera_status": camera_status, "gps_status": gps_status,
            "network_status": network_status,
            "queued_offline_events": self.store.pending_count(),
            "metrics": metrics or {},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        try:
            res = self.session.post(
                f"{self.server_url}/api/v1/iot/heartbeat",
                json=body, timeout=self.timeout,
            )
            return res.status_code in (200, 201)
        except Exception as exc:
            logger.warning("Heartbeat failed: %s", exc)
            return False

    def send_gps(
        self, latitude: float, longitude: float, speed: float = 0.0,
        heading: float = 0.0, timestamp: Optional[str] = None,
    ) -> bool:
        body = {
            "bus_id": self.bus_id, "device_id": self.device_id,
            "latitude": latitude, "longitude": longitude,
            "speed": speed, "heading": heading,
            "timestamp": timestamp or datetime.now(timezone.utc).isoformat(),
        }
        try:
            res = self.session.post(
                f"{self.server_url}/api/v1/iot/gps",
                json=body, timeout=self.timeout,
            )
            if res.status_code in (200, 201):
                return True
            logger.warning("GPS update returned HTTP %s", res.status_code)
        except Exception as exc:
            logger.warning("GPS update failed: %s", exc)
        # GPS is deliberately not put in the face-event queue: the current
        # batch-sync endpoint replays biometric events, not GPS telemetry.
        return False

    def process_face_event(
        self, camera_role: str, faces: List[Dict[str, Any]],
        current_stop: str = "Campus Terminal",
    ) -> Dict[str, Any]:
        role = "EXIT" if str(camera_role).upper() == "EXIT" else "ENTRY"
        event_id = str(uuid.uuid4())
        payload = {
            "event_id": event_id,
            "bus_id": self.bus_id,
            "device_id": self.device_id,
            "camera_role": role,
            "stop": current_stop,
            "faces": faces,
        }
        endpoint = "exit-events" if role == "EXIT" else "entry-events"
        try:
            res = self.session.post(
                f"{self.server_url}/api/v1/iot/{endpoint}",
                json=payload,
                headers={"x-event-id": event_id},
                timeout=self.timeout,
            )
            if res.status_code in (200, 201):
                result = res.json()
                if not isinstance(result, dict):
                    raise ValueError("Recognition API returned a non-object response")
                result.setdefault("event_id", event_id)
                result["offline_queued"] = False
                return result

            message = f"Face API returned HTTP {res.status_code}"
            # Do not queue authorization/configuration failures indefinitely.
            if res.status_code in (400, 401, 403, 404, 422):
                logger.error("%s: %s", message, res.text[:300])
                return {
                    "success": False, "offline_queued": False,
                    "event_id": event_id, "error": message,
                    "processed_faces": [],
                }
            logger.warning("%s; queueing for later replay", message)
        except Exception as exc:
            logger.warning("Face API unavailable; queueing event: %s", exc)

        self.store.enqueue(event_id, role, payload)
        return {
            "success": False, "offline_queued": True,
            "event_id": event_id, "processed_faces": [],
            "message": "Pending server verification; no recognition decision was made.",
        }

    def _sync_loop(self, interval_sec: int = 10):
        while self._running:
            try:
                self.sync_pending_events()
            except Exception:
                logger.exception("Offline event sync cycle failed")
            time.sleep(max(1, interval_sec))

    def sync_pending_events(self, max_batch_size: int = 25) -> int:
        rows = self.store.due_batch(max_batch_size)
        if not rows:
            return 0

        events = []
        row_meta = []
        for row in rows:
            try:
                payload = __import__("json").loads(row["payload"])
                events.append({
                    "event_id": row["event_id"],
                    "event_type": row["event_type"],
                    "payload": payload,
                })
                row_meta.append((row["id"], row["retry_count"], row["event_id"]))
            except Exception as exc:
                self.store.mark_failed(row["id"], row["retry_count"], str(exc))

        if not events:
            return 0

        try:
            res = self.session.post(
                f"{self.server_url}/api/v1/iot/batch-sync",
                json={"bus_id": self.bus_id, "events": events},
                timeout=max(self.timeout, 10.0),
            )
            if res.status_code not in (200, 201):
                for row_id, retry_count, _ in row_meta:
                    self.store.mark_failed(row_id, retry_count, f"HTTP {res.status_code}")
                return 0

            data = res.json()
            results = data.get("results", [])
            acknowledged = set()
            for item in results:
                if not isinstance(item, dict):
                    continue
                result = item.get("result")
                if not isinstance(result, dict):
                    continue
                if (
                    result.get("event_status") in ("COMPLETED", "ALREADY_PROCESSED")
                    and not result.get("error")
                    and not result.get("processing_error")
                ):
                    acknowledged.add(item.get("event_id"))

            synced_ids = [
                row_id for row_id, _, event_id in row_meta
                if event_id in acknowledged
            ]
            if synced_ids:
                self.store.mark_synced(synced_ids)

            for row_id, retry_count, event_id in row_meta:
                if event_id not in acknowledged:
                    self.store.mark_failed(
                        row_id, retry_count,
                        "Missing or unsuccessful per-event batch acknowledgement",
                    )

            logger.info(
                "Offline batch acknowledged %d/%d events",
                len(synced_ids), len(row_meta),
            )
            return len(synced_ids)
        except Exception as exc:
            for row_id, retry_count, _ in row_meta:
                self.store.mark_failed(row_id, retry_count, str(exc))
            logger.warning("Batch sync failed: %s", exc)
            return 0
