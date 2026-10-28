import os
import sys
import time
import cv2

PI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PI)

from scrfd_detector import SCRFDFaceDetector

model = os.path.join(
    PI, "models", "scrfd_500m_bnkps_shape640x640.onnx"
)

print("SCRFD model exists:", os.path.isfile(model))
print("SCRFD model path:", model)

if not os.path.isfile(model):
    raise SystemExit("ERROR: SCRFD ONNX model is missing.")

detector = SCRFDFaceDetector(model_path=model)
camera = cv2.VideoCapture(0)

if not camera.isOpened():
    raise SystemExit("ERROR: Could not open camera index 0.")

try:
    for i in range(30):
        ok, frame = camera.read()
        if not ok:
            print("Frame read failed:", i)
            continue

        detections = detector.detect(frame)
        print(
            "frame=", i,
            "shape=", frame.shape,
            "detections=", len(detections),
            "details=", detections[:2]
        )
        time.sleep(0.1)
finally:
    camera.release()
