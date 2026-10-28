
"""
Smart Bus IoT — Camera Capture Module
Supports Picamera2, OpenCV USB webcams, and explicit simulation mode.

Camera capture only. Face detection, quality/liveness scoring, embeddings,
and tracking are handled by face_engine.py.
"""

import logging
import math
from typing import Optional

import numpy as np

try:
    import cv2
except ImportError:
    cv2 = None

logger = logging.getLogger("SmartBusIoT.Camera")


class CameraProcessor:
    def __init__(
        self,
        camera_source: str = "0",
        width: int = 640,
        height: int = 480,
        role: str = "ENTRY",
    ):
        self.camera_source = camera_source
        self.width = width
        self.height = height
        self.role = role.upper()

        self.cap = None
        self.picam2 = None
        self.backend = "SIMULATED"
        self._frame_index = 0

        self._init_camera()

    def _init_camera(self):
        """Initialize hardware when available; otherwise use simulation."""
        if self.camera_source.lower() in (
            "picam", "picamera", "picamera2", "csi"
        ):
            try:
                from picamera2 import Picamera2

                self.picam2 = Picamera2()
                config = self.picam2.create_video_configuration(
                    main={
                        "size": (self.width, self.height),
                        "format": "RGB888",
                    }
                )
                self.picam2.configure(config)
                self.picam2.start()
                self.backend = "PICAMERA2"
                logger.info("Initialized Picamera2 hardware backend")
                return
            except Exception as exc:
                logger.warning("Picamera2 initialization failed: %s", exc)
                self.picam2 = None

        if cv2 is not None:
            try:
                idx = (
                    int(self.camera_source)
                    if self.camera_source.isdigit()
                    else self.camera_source
                )
                self.cap = cv2.VideoCapture(idx)

                if self.cap.isOpened():
                    self.cap.set(
                        cv2.CAP_PROP_FRAME_WIDTH, self.width
                    )
                    self.cap.set(
                        cv2.CAP_PROP_FRAME_HEIGHT, self.height
                    )
                    self.backend = "OPENCV_V4L2"
                    logger.info(
                        "Initialized OpenCV camera backend on %s",
                        self.camera_source,
                    )
                    return

                self.cap.release()
                self.cap = None
            except Exception as exc:
                logger.warning("OpenCV camera initialization failed: %s", exc)
                if self.cap is not None:
                    self.cap.release()
                    self.cap = None

        self.backend = "SIMULATED"
        logger.warning(
            "No camera hardware detected; using SIMULATED frames. "
            "These frames must never authorize passenger access."
        )

    @property
    def is_simulated(self) -> bool:
        return self.backend == "SIMULATED"

    def capture_frame(self) -> Optional[np.ndarray]:
        """Capture a frame without replacing hardware failures with fake input."""
        self._frame_index += 1

        if self.backend == "SIMULATED":
            return self._generate_simulated_frame()

        if self.backend == "PICAMERA2" and self.picam2 is not None:
            try:
                frame = self.picam2.capture_array()
                if frame is not None and frame.size > 0:
                    return frame
                logger.warning("Picamera2 returned an empty frame")
            except Exception as exc:
                logger.error("Picamera2 capture failed: %s", exc)
            return None

        if self.backend == "OPENCV_V4L2" and self.cap is not None:
            try:
                ret, frame = self.cap.read()
                if ret and frame is not None and frame.size > 0:
                    return frame
                logger.warning("OpenCV camera returned an empty frame")
            except Exception as exc:
                logger.error("OpenCV camera capture failed: %s", exc)
            return None

        logger.error("Camera backend is unavailable: %s", self.backend)
        return None

    def _generate_simulated_frame(self) -> np.ndarray:
        """Generate a clearly marked test image for simulation only."""
        img = np.zeros(
            (self.height, self.width, 3), dtype=np.uint8
        )
        img[:, :] = (30, 30, 35)

        center_x = int(
            self.width / 2
            + 30 * math.sin(self._frame_index * 0.1)
        )
        center_y = int(self.height / 2)

        if cv2 is not None:
            cv2.ellipse(
                img, (center_x, center_y), (60, 85),
                0, 0, 360, (180, 150, 140), -1
            )
            cv2.circle(
                img, (center_x - 22, center_y - 15),
                8, (20, 20, 20), -1
            )
            cv2.circle(
                img, (center_x + 22, center_y - 15),
                8, (20, 20, 20), -1
            )
            cv2.ellipse(
                img, (center_x, center_y + 30),
                (25, 10), 0, 0, 180, (40, 40, 140), 2
            )
            cv2.putText(
                img,
                f"SIMULATED {self.role} CAMERA",
                (20, 35),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                (0, 255, 180),
                2,
            )

        return img

    def close(self):
        """Release camera resources."""
        if self.cap is not None:
            self.cap.release()
            self.cap = None

        if self.picam2 is not None:
            try:
                self.picam2.stop()
            except Exception as exc:
                logger.warning("Picamera2 shutdown issue: %s", exc)
            self.picam2 = None
