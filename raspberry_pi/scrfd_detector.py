import cv2
import numpy as np
import onnxruntime as ort


class SCRFDFaceDetector:
    """SCRFD-500M face detector for a 640x640 ONNX model."""

    def __init__(
        self,
        model_path=r"raspberry_pi\models\scrfd_500m_bnkps_shape640x640.onnx",
        score_threshold=0.5,
        nms_threshold=0.4,
    ):
        self.session = ort.InferenceSession(
            model_path, providers=["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name
        self.score_threshold = score_threshold
        self.nms_threshold = nms_threshold
        self.input_size = 640
        self.strides = (8, 16, 32)

        # Cache fixed SCRFD anchor centers once instead of rebuilding
        # mesh grids and repeated centers for every camera frame.
        self._anchor_centers = {}
        for stride in self.strides:
            feat_h = self.input_size // stride
            feat_w = self.input_size // stride
            yy, xx = np.mgrid[0:feat_h, 0:feat_w]
            centers = np.stack(
                [
                    xx.reshape(-1) * stride,
                    yy.reshape(-1) * stride,
                ],
                axis=1,
            )
            centers = np.repeat(centers, 2, axis=0)
            centers.setflags(write=False)
            self._anchor_centers[stride] = centers

        outputs = {o.name for o in self.session.get_outputs()}
        required = {
            f"score_{s}" for s in self.strides
        } | {
            f"bbox_{s}" for s in self.strides
        } | {
            f"kps_{s}" for s in self.strides
        }
        if not required.issubset(outputs):
            raise RuntimeError(
                f"Unexpected SCRFD outputs. Missing: {sorted(required - outputs)}"
            )

    def detect(self, frame):
        if frame is None or frame.size == 0:
            return []

        h, w = frame.shape[:2]
        scale = min(640 / w, 640 / h)
        nw, nh = int(round(w * scale)), int(round(h * scale))

        resized = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)
        canvas = np.zeros((640, 640, 3), dtype=np.uint8)
        canvas[:nh, :nw] = resized

        # SCRFD model input is RGB, normalized with (pixel - 127.5) / 128.
        rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)
        tensor = (rgb.astype(np.float32) - 127.5) / 128.0
        tensor = np.transpose(tensor, (2, 0, 1))[None, ...]

        raw = self.session.run(None, {self.input_name: tensor})
        names = [o.name for o in self.session.get_outputs()]
        out = dict(zip(names, raw))

        boxes_all, scores_all = [], []

        for stride in self.strides:
            scores = out[f"score_{stride}"].reshape(-1)
            deltas = out[f"bbox_{stride}"].reshape(-1, 4)

            # SCRFD outputs two anchors per spatial location at each stride.
            feat_h, feat_w = 640 // stride, 640 // stride
            anchors_per_cell = 2
            expected = feat_h * feat_w * anchors_per_cell
            if len(scores) != expected or len(deltas) != expected:
                raise RuntimeError(
                    f"Unexpected output size at stride {stride}: "
                    f"scores={len(scores)}, boxes={len(deltas)}, expected={expected}"
                )

            # Reuse precomputed anchor centers for this stride.
            centers = self._anchor_centers[stride]
            boxes = np.empty_like(deltas)
            boxes[:, 0] = centers[:, 0] - deltas[:, 0] * stride
            boxes[:, 1] = centers[:, 1] - deltas[:, 1] * stride
            boxes[:, 2] = centers[:, 0] + deltas[:, 2] * stride
            boxes[:, 3] = centers[:, 1] + deltas[:, 3] * stride

            keep = scores >= self.score_threshold
            if np.any(keep):
                boxes_all.append(boxes[keep])
                scores_all.append(scores[keep])

        if not boxes_all:
            return []

        boxes = np.concatenate(boxes_all)
        scores = np.concatenate(scores_all)

        # Undo the same top-left padding and uniform resize.
        boxes[:, [0, 2]] = np.clip(boxes[:, [0, 2]] / scale, 0, w)
        boxes[:, [1, 3]] = np.clip(boxes[:, [1, 3]] / scale, 0, h)

        xywh = [
            [float(b[0]), float(b[1]),
             float(max(0, b[2] - b[0])), float(max(0, b[3] - b[1]))]
            for b in boxes
        ]
        indices = cv2.dnn.NMSBoxes(
            xywh, scores.tolist(), self.score_threshold, self.nms_threshold
        )

        results = []
        for idx in np.asarray(indices).reshape(-1):
            x1, y1, x2, y2 = boxes[int(idx)]
            x, y = int(round(x1)), int(round(y1))
            right, bottom = int(round(x2)), int(round(y2))
            if right > x and bottom > y:
                results.append({
                    "bbox": {
                        "x": x, "y": y,
                        "width": right - x,
                        "height": bottom - y,
                    },
                    "score": float(scores[int(idx)]),
                })

        return results
