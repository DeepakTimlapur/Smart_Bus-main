import os
import sys
import json
import cv2
import traceback

PI = os.path.abspath("raspberry_pi")
sys.path.insert(0, PI)

from embedding_model import build_default_embedder
from face_engine import FrameFaceDetector
from scrfd_detector import SCRFDFaceDetector

with open(os.path.join(PI, "config.json"), encoding="utf-8-sig") as f:
    config = json.load(f)

embedding_path = os.path.join(PI, config["embedding_model_path"])
embedder = build_default_embedder(embedding_path)

scrfd_path = os.path.join(
    PI, "models", "scrfd_500m_bnkps_shape640x640.onnx"
)
scrfd = SCRFDFaceDetector(model_path=scrfd_path)
engine = FrameFaceDetector(embedder=embedder)

camera = cv2.VideoCapture(0)
if not camera.isOpened():
    raise SystemExit("Cannot open camera 0.")

try:
    for i in range(40):
        ok, frame = camera.read()
        if not ok:
            continue

        try:
            direct = scrfd.detect(frame)
            integrated = engine.process(frame, simulated=False)

            print({
                "frame": i,
                "direct_scrfd_count": len(direct),
                "engine_count": len(integrated),
                "direct_bbox": direct[0]["bbox"] if direct else None,
                "engine_dimensions": [
                    len(face.get("embedding", []))
                    for face in integrated
                ],
                "engine_liveness": [
                    face.get("liveness") for face in integrated
                ],
            })
        except Exception:
            traceback.print_exc()
            break
finally:
    camera.release()

print("Diagnostic complete. No API calls were made.")
