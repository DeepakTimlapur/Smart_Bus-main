"""
Smart Bus IoT — Device Manager

Owns device identity (device_id / bus_id / camera_role / api_key) and the
device's relationship with the backend: periodic remote-config sync
(GET /api/v1/iot/device/config) and health telemetry (heartbeat).

Recognition thresholds, FPS budgets, and backoff parameters live on the
server (see server-db device config) so an admin can retune a whole fleet
without touching Pi firmware. This module fetches that config on start and
periodically refreshes it; if the server is unreachable it falls back to the
last-known config (or hard-coded safe defaults on first boot).
"""

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

logger = logging.getLogger("SmartBusIoT.DeviceManager")

DEFAULT_CONFIG: Dict[str, Any] = {
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
        "FACE_MATCH_THRESHOLD": 0.97,  # measured EER point for the classical HOG+LBP embedder, see docs/FACE_ACCURACY_CALIBRATION.md
        "HIGH_CONFIDENCE_THRESHOLD": 0.975,
        "LOW_CONFIDENCE_THRESHOLD": 0.94,
        "QUALITY_THRESHOLD": 0.45,
        "LIVENESS_THRESHOLD": 0.05,
        "TEMPORAL_CONSENSUS_THRESHOLD": 0.6,
        "TEMPORAL_WINDOW_FRAMES": 8,
        "TEMPORAL_MIN_FRAMES": 5,
        "BLUR_VARIANCE_MIN": 60.0,
        "AMBIGUOUS_MARGIN": 0.01,
    },
    "max_faces_per_frame": 4,
    "track_expiry_sec": 3.0,
}


class DeviceManager:
    def __init__(
        self,
        api_client,
        device_id: str,
        bus_id: str,
        camera_role: str,
        local_config_overrides: Optional[Dict[str, Any]] = None,
    ):
        self.api_client = api_client
        self.device_id = device_id
        self.bus_id = bus_id
        self.camera_role = camera_role.upper()

        # Start from safe local defaults; the first successful config fetch
        # (below) supersedes these. Explicit values in config.json always win
        # over server-issued thresholds, in case an operator needs a local
        # override for a device with unusual hardware.
        self.config: Dict[str, Any] = _deep_merge(DEFAULT_CONFIG, local_config_overrides or {})
        self._local_overrides = local_config_overrides or {}
        self.config_synced_at: Optional[str] = None
        self.last_heartbeat_ok = False

        self._running = False
        self._refresh_thread: Optional[threading.Thread] = None

        self.health = {
            "camera_status": "IDLE",
            "gps_status": "SEARCHING",
            "network_status": "DISCONNECTED",
        }

    # -----------------------------------------------------------------
    # Remote config sync
    # -----------------------------------------------------------------

    def fetch_config(self) -> bool:
        """Pulls the latest operating config from the server. Returns True on success."""
        remote = self.api_client.get_device_config()
        if remote is None:
            logger.warning(
                "Could not reach server for device config; continuing with last-known config."
            )
            return False

        server_config = remote.get("config", {})
        merged = _deep_merge(DEFAULT_CONFIG, server_config)
        merged = _deep_merge(merged, self._local_overrides)  # local overrides always win
        self.config = merged
        self.config_synced_at = datetime.now(timezone.utc).isoformat()

        # The server is authoritative for role/bus assignment too.
        if remote.get("camera_role"):
            self.camera_role = remote["camera_role"].upper()
        if remote.get("bus_id"):
            self.bus_id = remote["bus_id"]

        logger.info(
            "Device config synced from server (role=%s, thresholds.FACE_MATCH_THRESHOLD=%s)",
            self.camera_role,
            self.config.get("thresholds", {}).get("FACE_MATCH_THRESHOLD"),
        )
        return True

    def start_config_refresh(self):
        """Background thread that periodically re-pulls config so threshold tuning propagates live."""
        self._running = True
        self._refresh_thread = threading.Thread(target=self._refresh_loop, daemon=True, name="ConfigRefreshWorker")
        self._refresh_thread.start()

    def stop_config_refresh(self):
        self._running = False

    def _refresh_loop(self):
        while self._running:
            interval = float(self.config.get("config_refresh_interval_sec", 300))
            time.sleep(interval)
            if self._running:
                self.fetch_config()

    def threshold(self, name: str, default: Optional[float] = None) -> float:
        return self.config.get("thresholds", {}).get(name, default)

    # -----------------------------------------------------------------
    # Health / heartbeat
    # -----------------------------------------------------------------

    def update_health(self, camera_status: str = None, gps_status: str = None, network_status: str = None):
        if camera_status:
            self.health["camera_status"] = camera_status
        if gps_status:
            self.health["gps_status"] = gps_status
        if network_status:
            self.health["network_status"] = network_status

    def send_heartbeat(self, queued_events: int = 0, extra_metrics: Optional[Dict[str, Any]] = None) -> bool:
        ok = self.api_client.send_heartbeat(
            camera_status=self.health["camera_status"],
            gps_status=self.health["gps_status"],
            network_status=self.health["network_status"],
            metrics={
                "queued_offline_events": queued_events,
                "config_synced_at": self.config_synced_at,
                **(extra_metrics or {}),
            },
        )
        self.last_heartbeat_ok = ok
        return ok


def _deep_merge(base: Dict[str, Any], overrides: Dict[str, Any]) -> Dict[str, Any]:
    """Recursively merges `overrides` onto a copy of `base`; overrides win on conflicts."""
    result = dict(base)
    for key, value in (overrides or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result
