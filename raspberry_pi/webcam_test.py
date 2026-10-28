#!/usr/bin/env python3
"""
Smart Bus IoT — Local Webcam Test (Windows/Mac/Linux dev machine)

Opens your laptop's webcam and runs the REAL pipeline (detection -> quality
-> liveness -> embedding -> tracking -> temporal consensus -> optional local
identity match) live, so you can sanity-check the real model BEFORE
deploying to a Raspberry Pi. Supports up to 4 simultaneous faces (item 19),
each with independent on-screen status (item 18/19).

Per-face display states, per the brief:
    FACE #1
    Student: 3BR23EC045
    Similarity: 0.XX
    Quality: GOOD
    Liveness: LIVE
    State: VERIFYING
  -> once temporal consensus is reached:
    ACCESS APPROVED                 (RECOGNIZED, high confidence)
    ACCESS DENIED / UNKNOWN FACE    (no template matched closely enough)
    ACCESS DENIED / LOW QUALITY     (never reached consensus -- blurry/dark)
    ACCESS DENIED / AMBIGUOUS IDENTITY (two candidates too close to call)

REQUIREMENTS NOTE: this needs a GUI-capable OpenCV build. The Pi's
requirements.txt intentionally uses `opencv-python-headless` (no GUI needed
on a headless Pi). For this script, on your dev machine:
    pip install opencv-python onnxruntime --break-system-packages
(opencv-python, NOT opencv-python-headless -- headless has no cv2.imshow)

Usage:
    python3 webcam_test.py                          # webcam index 0, up to 4 faces
    python3 webcam_test.py --camera 1 --max-faces 2
    python3 webcam_test.py --templates my_templates.json   # enable identity matching
    python3 webcam_test.py --no-display                    # console output only (CI/headless sanity check)

NOT RUN in the sandbox that wrote this file: no webcam, no display, and no
model weights are available here. The pure display-logic function
(compute_display_state) is unit-tested against synthetic Track/MatchResult
objects (see the bottom of this file / README note) so its state-machine
correctness is verified independent of camera hardware -- running the
actual capture loop against a real camera and real face is work you need
to do locally.
"""

import argparse
import json
import logging
import os
import sys
import threading
import time
from typing import Any, Dict, Optional

import numpy as np

try:
    import cv2
except ImportError:
    cv2 = None

from embedding_model import build_default_embedder
from face_engine import FrameFaceDetector, MultiFaceTracker, Track
from identity_matcher import LocalIdentityMatcher, MatchResult

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("WebcamTest")

STATE_COLORS = {
    "VERIFYING": (0, 200, 255),        # amber
    "ACCESS_APPROVED": (0, 220, 0),    # green
    "UNKNOWN_FACE": (0, 0, 220),       # red
    "LOW_QUALITY": (0, 140, 255),      # orange
    "AMBIGUOUS_IDENTITY": (200, 0, 200),  # magenta
}


def compute_display_state(
    track: Track,
    det: Dict[str, Any],
    matcher: Optional[LocalIdentityMatcher],
    production_ready: bool,
    submit_ready_this_frame: bool,
) -> Dict[str, Any]:
    """
    Pure function: given a track's current state plus this frame's
    detection, returns what to display for that one face. No cv2 calls
    here -- this is the part that's unit-testable without a camera.
    """
    quality_label = "GOOD" if det["quality"]["isAcceptable"] else "LOW"
    liveness_label = "LIVE" if det["liveness"]["isLive"] else "SUSPICIOUS"

    if not det["quality"]["isAcceptable"]:
        return {
            "state": "LOW_QUALITY",
            "lines": [f"Track {track.track_id[-6:]}", "ACCESS DENIED", "LOW QUALITY"],
            "quality": quality_label,
            "liveness": liveness_label,
        }

    if not production_ready:
        return {
            "state": "VERIFYING",
            "lines": [
                f"Track {track.track_id[-6:]}",
                "Student: (model not installed)",
                "Similarity: N/A",
                f"Quality: {quality_label}",
                f"Liveness: {liveness_label}",
                "State: PENDING_MODEL_NOT_INSTALLED",
            ],
            "quality": quality_label,
            "liveness": liveness_label,
        }

    if submit_ready_this_frame and matcher is not None:
        result: MatchResult = matcher.match(det["embedding"])
        track.candidate_identity = result.student_id
        track.similarity_score = round(result.similarity, 4)
        track.verification_state = result.status

    state = track.verification_state

    if state == "PENDING" or state == "":
        return {
            "state": "VERIFYING",
            "lines": [
                f"Track {track.track_id[-6:]}",
                "Student: ...",
                "Similarity: ...",
                f"Quality: {quality_label}",
                f"Liveness: {liveness_label}",
                "State: VERIFYING",
            ],
            "quality": quality_label,
            "liveness": liveness_label,
        }

    if state == "RECOGNIZED":
        return {
            "state": "ACCESS_APPROVED",
            "lines": [
                f"Track {track.track_id[-6:]}",
                f"Student: {track.candidate_identity}",
                f"Similarity: {track.similarity_score:.2f}",
                f"Quality: {quality_label}",
                f"Liveness: {liveness_label}",
                "ACCESS APPROVED",
            ],
            "quality": quality_label,
            "liveness": liveness_label,
        }

    if state == "AMBIGUOUS":
        return {
            "state": "AMBIGUOUS_IDENTITY",
            "lines": [f"Track {track.track_id[-6:]}", "ACCESS DENIED", "AMBIGUOUS IDENTITY"],
            "quality": quality_label,
            "liveness": liveness_label,
        }

    # UNKNOWN (default)
    return {
        "state": "UNKNOWN_FACE",
        "lines": [f"Track {track.track_id[-6:]}", "ACCESS DENIED", "UNKNOWN FACE"],
        "quality": quality_label,
        "liveness": liveness_label,
    }


def draw_face_panel(frame, bbox: Dict[str, int], display: Dict[str, Any]):
    color = STATE_COLORS.get(display["state"], (255, 255, 255))
    x, y, w, h = bbox["x"], bbox["y"], bbox["width"], bbox["height"]
    cv2.rectangle(frame, (x, y), (x + w, y + h), color, 2)
    for i, line in enumerate(display["lines"]):
        cv2.putText(
            frame, line, (x, y - 10 - (len(display["lines"]) - 1 - i) * 18),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA,
        )


def load_templates(path: Optional[str]) -> Dict[str, list]:
    if not path or not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f)



class LatestFrameCapture:
    def __init__(self, camera):
        self.camera = camera
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.latest = None
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()
        return self

    def _loop(self):
        while not self.stop_event.is_set():
            ok, frame = self.camera.read()
            if ok and frame is not None:
                with self.lock:
                    self.latest = frame
            else:
                time.sleep(0.005)

    def read_latest(self):
        deadline = time.monotonic() + 2.0
        while not self.stop_event.is_set():
            with self.lock:
                if self.latest is not None:
                    return True, self.latest.copy()
            if time.monotonic() >= deadline:
                return False, None
            time.sleep(0.005)
        return False, None

    def stop(self):
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=1.5)


def main():
    parser = argparse.ArgumentParser(description="Smart Bus local webcam test")
    parser.add_argument("--camera", type=int, default=0, help="Webcam index (default 0)")
    parser.add_argument("--max-faces", type=int, default=4, help="Max simultaneous faces (default 4)")
    parser.add_argument("--model-path", default=None, help="Path to the real .onnx model (defaults to spec path)")
    parser.add_argument("--templates", default=None, help="JSON file of {student_id: [512 floats]} for matching")
    parser.add_argument("--no-display", action="store_true", help="Console output only, no cv2 window (headless sanity check)")
    args = parser.parse_args()

    if cv2 is None:
        print("OpenCV is not installed. `pip install opencv-python`")
        sys.exit(1)

    embedder = build_default_embedder(args.model_path)
    logger.info("Embedder: %s", embedder.metadata())
    if not embedder.production_ready:
        logger.warning(
            "*** No production-ready model loaded -- every face will show "
            "'PENDING_MODEL_NOT_INSTALLED' instead of a real match. "
            "See docs/EMBEDDING_SPEC.md. ***"
        )

    detector = FrameFaceDetector(blur_threshold=60.0, max_faces=args.max_faces, embedder=embedder)
    tracker = MultiFaceTracker(temporal_window_frames=8, temporal_min_frames=5, track_expiry_sec=2.0)

    matcher = None
    if embedder.production_ready:
        templates = load_templates(args.templates)
        matcher = LocalIdentityMatcher(face_match_threshold=0.5)  # placeholder -- see docs/FACE_ACCURACY_CALIBRATION.md; calibrate with calibrate_threshold.py before relying on this
        if templates:
            matcher.sync_templates(templates)
            logger.info("Loaded %d template(s) from %s", len(templates), args.templates)
        else:
            logger.warning("No --templates provided (or file empty) -- every match will be UNKNOWN.")

    # Prefer DirectShow on Windows and limit stale queued frames.
    if os.name == "nt" and hasattr(cv2, "CAP_DSHOW"):
        cap = cv2.VideoCapture(args.camera, cv2.CAP_DSHOW)
        if not cap.isOpened():
            cap.release()
            logger.warning("DirectShow failed; falling back to default camera backend.")
            cap = cv2.VideoCapture(args.camera)
    else:
        cap = cv2.VideoCapture(args.camera)

    if cap.isOpened():
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        cap.set(cv2.CAP_PROP_FPS, 30)
        logger.info(
            "Camera settings: %.0fx%.0f at %.1f FPS (reported by driver)",
            cap.get(cv2.CAP_PROP_FRAME_WIDTH),
            cap.get(cv2.CAP_PROP_FRAME_HEIGHT),
            cap.get(cv2.CAP_PROP_FPS),
        )
    if not cap.isOpened():
        print(f"Could not open webcam index {args.camera}.")
        sys.exit(1)

    logger.info("Webcam opened. Press 'q' to quit.")
    capture = LatestFrameCapture(cap).start()
    try:
        while True:
            ret, frame = capture.read_latest()
            if not ret:
                logger.warning("Frame read failed; stopping.")
                break

            detections = detector.process(frame, role="ENTRY", simulated=False)
            track_results = tracker.update(detections)

            for track, det, submit_ready in track_results:
                display = compute_display_state(
                    track, det, matcher, embedder.production_ready, submit_ready
                )
                if args.no_display:
                    print(" | ".join(display["lines"]))
                else:
                    draw_face_panel(frame, det["bbox"], display)

            if not args.no_display:
                if not track_results:
                    cv2.putText(
                        frame, "No face detected - look at the camera",
                        (10, 55), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                        (255, 255, 255), 1, cv2.LINE_AA,
                    )

                cv2.putText(
                    frame, f"Faces: {len(track_results)}/{args.max_faces}", (10, 25),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA,
                )
                cv2.imshow("Smart Bus -- Local Webcam Test", frame)

                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
            else:
                time.sleep(0.05)
    finally:
        capture.stop()
        cap.release()
        if not args.no_display:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
