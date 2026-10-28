"""
Smart Bus IoT — GPS Telemetry Module
Handles hardware serial NMEA communication (NEO-6M, SIM7600, u-blox)
with thread-safe polling and mock fallback.
"""

import math
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

try:
    import serial
except ImportError:
    serial = None


class GPSReader:
    def __init__(
        self,
        port: str = "/dev/ttyUSB0",
        baudrate: int = 9600,
        mock_fallback: bool = True,
    ):
        self.port = port
        self.baudrate = baudrate
        self.mock_fallback = mock_fallback
        self.serial_conn = None
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

        # Current state
        self._current_location: Dict[str, Any] = {
            "latitude": 12.9716,
            "longitude": 77.5946,
            "speed": 0.0,
            "heading": 0.0,
            "altitude": 920.0,
            "satellites": 0,
            "fix": False,
            "source": "INITIALIZING",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        # Simulation waypoint state
        self._sim_t = 0.0
        self._sim_center_lat = 12.9716
        self._sim_center_lng = 77.5946

    def start(self):
        """Starts background GPS listener thread."""
        self.running = True
        self._init_serial()
        self.thread = threading.Thread(target=self._read_loop, daemon=True, name="GPSReaderThread")
        self.thread.start()

    def stop(self):
        """Stops GPS reader gracefully."""
        self.running = False
        if self.serial_conn:
            try:
                self.serial_conn.close()
            except Exception:
                pass
            self.serial_conn = None

    def _init_serial(self):
        if serial is None:
            return

        try:
            self.serial_conn = serial.Serial(
                port=self.port,
                baudrate=self.baudrate,
                timeout=1.0,
            )
        except Exception:
            self.serial_conn = None

    def _read_loop(self):
        while self.running:
            read_success = False

            if self.serial_conn and self.serial_conn.is_open:
                try:
                    line = self.serial_conn.readline().decode("ascii", errors="ignore").strip()
                    if line.startswith("$GPRMC") or line.startswith("$GNRMC"):
                        self._parse_rmc(line)
                        read_success = True
                    elif line.startswith("$GPGGA") or line.startswith("$GNGGA"):
                        self._parse_gga(line)
                        read_success = True
                except Exception:
                    self._init_serial()
                    time.sleep(1.0)
            else:
                self._init_serial()

            # If hardware serial failed or no lock, use mock fallback if enabled
            if not read_success and self.mock_fallback:
                self._update_mock_location()
                time.sleep(1.0)
            else:
                time.sleep(0.1)

    def _parse_rmc(self, sentence: str):
        """
        Parses NMEA Recommended Minimum Navigation sentence:
        $GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A
        """
        parts = sentence.split(",")
        if len(parts) < 10:
            return

        status = parts[2]
        if status != "A":  # 'A' = Valid, 'V' = Void
            with self._lock:
                self._current_location["fix"] = False
            return

        raw_lat = parts[3]
        lat_dir = parts[4]
        raw_lon = parts[5]
        lon_dir = parts[6]
        raw_speed_knots = parts[7]
        raw_course = parts[8]

        try:
            lat = self._nmea_to_decimal(raw_lat, lat_dir)
            lon = self._nmea_to_decimal(raw_lon, lon_dir)
            speed_kmh = float(raw_speed_knots) * 1.852 if raw_speed_knots else 0.0
            heading = float(raw_course) if raw_course else 0.0

            with self._lock:
                self._current_location = {
                    "latitude": round(lat, 6),
                    "longitude": round(lon, 6),
                    "speed": round(speed_kmh, 1),
                    "heading": round(heading, 1),
                    "altitude": self._current_location.get("altitude", 920.0),
                    "satellites": self._current_location.get("satellites", 6),
                    "fix": True,
                    "source": "HARDWARE",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
        except Exception:
            pass

    def _parse_gga(self, sentence: str):
        """Parses GGA sentence for altitude and satellite count."""
        parts = sentence.split(",")
        if len(parts) < 10:
            return

        fix_quality = parts[6]
        sats = parts[7]
        alt = parts[9]

        try:
            with self._lock:
                if fix_quality and int(fix_quality) > 0:
                    self._current_location["fix"] = True
                if sats:
                    self._current_location["satellites"] = int(sats)
                if alt:
                    self._current_location["altitude"] = round(float(alt), 1)
        except Exception:
            pass

    def _nmea_to_decimal(self, raw_coord: str, direction: str) -> float:
        """Converts DDMM.MMMM to decimal degrees."""
        if not raw_coord or not direction:
            return 0.0

        if direction in ("N", "S"):
            degrees = float(raw_coord[:2])
            minutes = float(raw_coord[2:])
        else:
            degrees = float(raw_coord[:3])
            minutes = float(raw_coord[3:])

        decimal = degrees + (minutes / 60.0)
        if direction in ("S", "W"):
            decimal = -decimal
        return decimal

    def _update_mock_location(self):
        """Simulates vehicle moving smoothly along a closed city loop."""
        self._sim_t += 0.05
        # 0.008 degrees radius circle/ellipse around center
        radius_lat = 0.008
        radius_lng = 0.012

        lat = self._sim_center_lat + radius_lat * math.sin(self._sim_t)
        lng = self._sim_center_lng + radius_lng * math.cos(self._sim_t)

        # Calculate tangent heading
        heading = (math.degrees(math.atan2(
            radius_lat * math.cos(self._sim_t),
            -radius_lng * math.sin(self._sim_t)
        )) + 360) % 360

        speed = 28.0 + 8.0 * math.sin(self._sim_t * 2.0)

        with self._lock:
            self._current_location = {
                "latitude": round(lat, 6),
                "longitude": round(lng, 6),
                "speed": round(max(0.0, speed), 1),
                "heading": round(heading, 1),
                "altitude": 920.0,
                "satellites": 8,
                "fix": True,
                "source": "SIMULATED",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

    def get_location(self) -> Dict[str, Any]:
        """Thread-safe snapshot of latest GPS position."""
        with self._lock:
            return dict(self._current_location)


if __name__ == "__main__":
    reader = GPSReader(mock_fallback=True)
    reader.start()
    try:
        print("[GPS] Starting 5-second test poll...")
        for _ in range(5):
            loc = reader.get_location()
            print(f"[{loc['source']}] Lat: {loc['latitude']}, Lng: {loc['longitude']}, Speed: {loc['speed']} km/h, Fix: {loc['fix']}")
            time.sleep(1)
    finally:
        reader.stop()
        print("[GPS] Test finished.")
