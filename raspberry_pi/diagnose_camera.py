import json
import os
import sys
import time

import cv2

# Make the project root importable when this script is run directly.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from embedding_model import build_default_embedder
from face_engine import FrameFaceDetector

with open(os.path.join(ROOT, "raspberry_pi", "config.json"),
          encoding="utf-8-sig") as f:
    config = json.load(f)

model_path = os.path.abspath(os.path.join(
    ROOT, "raspberry_pi", config["embedding_model_path"]
))
embedder = build_default_embedder(model_path)
engine = FrameFaceDetector(embedder=embedder)

camera_source = config.get("camera_source", "0")
try:
    camera_source = int(camera_source)
except (TypeError, ValueError):
    camera_source = str(camera_source)

camera = cv2.VideoCapture(camera_source)
camera.set(cv2.CAP_PROP_FRAME_WIDTH, int(config.get("camera_width", 640)))
camera.set(cv2.CAP_PROP_FRAME_HEIGHT, int(config.get("camera_height", 480)))

if not camera.isOpened():
    raise SystemExit("ERROR: Could not open the configured camera.")

print("Embedding model:", embedder.metadata())
print("Look at the camera and move your face naturally.")
print("Running for 10 seconds. No API requests will be sent.")

start = time.time()
frames = 0
total_detections = 0

try:
    while time.time() - start < 10:
        ok, frame = camera.read()
        if not ok:
            continue

        frames += 1
        detections = engine.process(frame, simulated=False)
        total_detections += len(detections)

        for index, det in enumerate(detections, 1):
            bbox = det.get("bbox", {})
            quality = det.get("quality", {})
            liveness = det.get("liveness", {})
            embedding = det.get("embedding", [])

            print({
                "frame": frames,
                "face": index,
                "bbox_width": bbox.get("width"),
                "bbox_height": bbox.get("height"),
                "blur": quality.get("blur"),
                "isAcceptable": quality.get("isAcceptable"),
                "livenessScore": liveness.get("livenessScore"),
                "isLive": liveness.get("isLive"),
                "livenessStatus": liveness.get("livenessStatus"),
                "embedding_dimensions": len(embedding),
            })

        time.sleep(0.05)
finally:
    camera.release()

print({
    "frames_read": frames,
    "detections_total": total_detections,
    "api_requests_sent": 0,
})
