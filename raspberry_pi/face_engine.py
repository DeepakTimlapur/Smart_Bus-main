"""
Smart Bus IoT Ã¢â‚¬â€ Face Engine

Per-frame face detection, quality/liveness assessment, and embedding
extraction (moved out of camera.py, which now only captures frames), plus
multi-face temporal tracking so up to four simultaneous faces are each
followed independently across frames instead of being re-evaluated from a
single snapshot.

Pipeline this module implements, per frame:
    detect -> per-face quality gate -> liveness check -> BATCH embedding
    -> associate with an existing Track (IoU) or start a new one
    -> track accumulates frames -> once a track has enough consecutive
       acceptable frames, it becomes submit_ready exactly once (locked)
       so the caller (main.py) sends it to the server for identity
       matching a single time per track, not once per frame.

IMPORTANT HONESTY NOTE (see docs/FACE_RECOGNITION.md for the full writeup):
Final identity matching against enrolled student templates happens on the
server (lib/server-db.ts), which holds the enrolled embeddings. This engine
does NOT claim to resolve "who this is" on-device by itself Ã¢â‚¬â€ an optional
LocalIdentityMatcher (identity_matcher.py) can produce a preliminary
candidate_identity if templates have been synced locally, but the server
remains authoritative. What this module guarantees is: WHEN a face has been
observed with enough temporal stability to be worth matching, and that each
of up to four simultaneous faces' state (bbox, embedding, quality, liveness,
track, candidate_identity) is completely isolated from the others via
track_id. That separation is what prevents Face A's history leaking into
Face B's decision (section "no cross-talk" in the project brief).

Embeddings are produced by a real, pluggable backend (embedding_model.py) Ã¢â‚¬â€
NOT a hash of bytes. See that module's docstring for the two backends
(classical CV, real-today vs. ONNX deep model, correct-but-untested-here)
and the critical embedding-space-mismatch caveat re: enrollment.
"""

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

try:
    import cv2
except ImportError:
    cv2 = None

try:
    from embedding_model import EmbeddingModel, HOGLBPEmbedder
    from .scrfd_detector import SCRFDFaceDetector
except ImportError:
    from embedding_model import EmbeddingModel, HOGLBPEmbedder
    from scrfd_detector import SCRFDFaceDetector

logger = logging.getLogger("SmartBusIoT.FaceEngine")



def cosine_similarity(a: List[float], b: List[float]) -> float:
    a_arr = np.asarray(a, dtype=np.float32).reshape(-1)
    b_arr = np.asarray(b, dtype=np.float32).reshape(-1)

    if a_arr.size == 0 or b_arr.size == 0 or a_arr.size != b_arr.size:
        return 0.0

    if not np.all(np.isfinite(a_arr)) or not np.all(np.isfinite(b_arr)):
        return 0.0

    na = float(np.linalg.norm(a_arr))
    nb = float(np.linalg.norm(b_arr))

    if na == 0.0 or nb == 0.0:
        return 0.0

    return float(np.dot(a_arr, b_arr) / (na * nb))



# ---------------------------------------------------------------------------
# Per-frame detection, quality, liveness, embedding
# ---------------------------------------------------------------------------

class FrameFaceDetector:
    """Stateless (per-call) detection + quality + liveness for a single frame; embeddings are batched."""

    def __init__(
        self,
        blur_threshold: float = 60.0,
        max_faces: int = 4,
        liveness_threshold: float = 0.03,
        embedder: Optional[EmbeddingModel] = None,
    ):
        self.blur_threshold = blur_threshold
        self.max_faces = max_faces
        self.liveness_threshold = liveness_threshold
        self.embedder: EmbeddingModel = embedder or HOGLBPEmbedder()
        self.face_cascade = None
        self.scrfd_detector = None
        self._init_detector()
        self._last_gray = None

    def _init_detector(self):
        if cv2 is None:
            raise RuntimeError("OpenCV is required for face detection.")

        import os
        model_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "models",
            "scrfd_500m_bnkps_shape640x640.onnx",
        )

        # Use SCRFD for both enrollment and live recognition.
        # Do not silently fall back to Haar if SCRFD fails to initialize.
        self.scrfd_detector = SCRFDFaceDetector(model_path=model_path)

        # Retained for compatibility with existing enrollment checks.
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        if os.path.exists(cascade_path):
            self.face_cascade = cv2.CascadeClassifier(cascade_path)

    def process(self, frame: np.ndarray, role: str = "ENTRY", simulated: bool = False) -> List[Dict[str, Any]]:
        """Returns a list of per-face detection dicts: bbox, quality, liveness, embedding."""
        if frame is None:
            return []

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if cv2 is not None else None

        # Global frame-level motion is kept only as a fallback for when a
        # per-face crop isn't available (e.g. first frame, or frame size
        # changed). It's deliberately NOT used as the primary liveness signal
        # per-face: a small face against a large mostly-static background
        # barely moves the whole-frame average, so a real live person's face
        # motion gets diluted into a false SUSPICIOUS reading. See
        # docs/FACE_RECOGNITION.md for the writeup of this finding.
        global_motion_score = 0.8
        if gray is not None and self._last_gray is not None and self._last_gray.shape == gray.shape:
            try:
                diff = cv2.absdiff(gray, self._last_gray)
                global_motion_score = min(1.0, float(np.mean(diff)) / 25.0)
            except Exception:
                pass
        prev_gray = self._last_gray
        self._last_gray = gray

        raw_faces = []
        try:
            if self.scrfd_detector is not None:
                detections = self.scrfd_detector.detect(frame)
                raw_faces = [
                    (
                        d["bbox"]["x"],
                        d["bbox"]["y"],
                        d["bbox"]["width"],
                        d["bbox"]["height"],
                    )
                    for d in detections
                ]
        except Exception:
            logger.exception("SCRFD detection failed")
            raw_faces = []

        if len(raw_faces) == 0 and simulated:
            h, w = frame.shape[0], frame.shape[1]
            raw_faces = [(int(w / 2 - 60), int(h / 2 - 80), 120, 160)]

        raw_faces = raw_faces[: self.max_faces]

        # --- Pass 1: per-face bbox/quality/liveness (cheap, no model inference yet) ---
        prelim: List[Dict[str, Any]] = []
        color_crops: List[np.ndarray] = []
        for (x, y, w, h) in raw_faces:
            face_roi_gray = gray[y: y + h, x: x + w] if gray is not None else None
            # Embeddings are computed from the COLOR crop, not the grayscale
            # one -- a real embedding model (and even the classical HOG/LBP
            # backend's equalization step) needs the actual color image, not
            # a pre-grayscaled crop, to be meaningful.
            face_roi_color = frame[y: y + h, x: x + w] if frame is not None else None

            blur_var = 120.0
            if face_roi_gray is not None and face_roi_gray.size > 0 and cv2 is not None:
                blur_var = float(cv2.Laplacian(face_roi_gray, cv2.CV_64F).var())

            is_acceptable = blur_var >= self.blur_threshold
            quality_score = min(1.0, max(0.2, blur_var / 200.0))

            liveness_score = global_motion_score
            if (
                prev_gray is not None
                and prev_gray.shape == gray.shape
                and face_roi_gray is not None
                and face_roi_gray.size > 0
            ):
                try:
                    prev_face_roi = prev_gray[y: y + h, x: x + w]
                    if prev_face_roi.shape == face_roi_gray.shape:
                        face_diff = cv2.absdiff(face_roi_gray, prev_face_roi)
                        liveness_score = min(1.0, float(np.mean(face_diff)) / 12.0)
                except Exception:
                    pass
            is_live = liveness_score > self.liveness_threshold

            prelim.append({
                "bbox": {"x": int(x), "y": int(y), "width": int(w), "height": int(h)},
                "quality": {
                    "qualityScore": round(quality_score, 2),
                    "qualityLabel": "EXCELLENT" if quality_score > 0.8 else "GOOD" if is_acceptable else "BLURRED",
                    "isAcceptable": is_acceptable,
                    "blur": round(blur_var, 1),
                },
                "liveness": {
                    "isLive": is_live,
                    "livenessStatus": "VERIFIED" if is_live else "SUSPICIOUS",
                    "livenessScore": round(liveness_score, 2),
                },
            })
            color_crops.append(face_roi_color if face_roi_color is not None and face_roi_color.size > 0
                                else np.zeros((self.embedder.__dict__.get("chip_size", 64),) * 2 + (3,), dtype=np.uint8))

        # --- Pass 2: BATCH embedding inference for every face in this frame at once ---
        # (requirement: "use batch inference where supported" -- one call handles
        # up to 4 faces instead of 4 separate model invocations.)
        embeddings = self.embedder.embed_batch(color_crops) if color_crops else []

        detections: List[Dict[str, Any]] = []
        for det, embedding in zip(prelim, embeddings):
            det["embedding"] = embedding
            det["embedding_model"] = self.embedder.metadata()
            detections.append(det)

        return detections


def iou(box_a: Dict[str, int], box_b: Dict[str, int]) -> float:
    ax1, ay1 = box_a["x"], box_a["y"]
    ax2, ay2 = ax1 + box_a["width"], ay1 + box_a["height"]
    bx1, by1 = box_b["x"], box_b["y"]
    bx2, by2 = bx1 + box_b["width"], by1 + box_b["height"]

    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter_w, inter_h = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter_area = inter_w * inter_h
    if inter_area == 0:
        return 0.0
    area_a = box_a["width"] * box_a["height"]
    area_b = box_b["width"] * box_b["height"]
    union = area_a + area_b - inter_area
    return inter_area / union if union > 0 else 0.0


# ---------------------------------------------------------------------------
# Multi-face temporal tracking (sections: temporal consensus, no cross-talk)
# ---------------------------------------------------------------------------

@dataclass
class Track:
    track_id: str
    bbox: Dict[str, int]
    last_seen: float
    created_at: float
    frame_history: List[Dict[str, Any]] = field(default_factory=list)  # recent per-frame detections, own copy
    consecutive_acceptable: int = 0
    submitted: bool = False
    last_submitted_at: float = 0.0
    # Per-track identity state (item: "preserve independent track state").
    # Populated by main.py via LocalIdentityMatcher when a local template
    # cache is available; stays at these safe defaults otherwise. Never
    # shared or copied between tracks -- each Track instance owns its own.
    candidate_identity: Optional[str] = None
    similarity_score: float = 0.0
    verification_state: str = "PENDING"  # PENDING | RECOGNIZED | UNKNOWN | AMBIGUOUS


class MultiFaceTracker:
    """
    Assigns each frame's raw detections to persistent, isolated tracks using
    IoU association, so Face A's embedding/quality/liveness history can never
    be attributed to Face B's bounding box even as people move within frame.

    A track becomes "submit_ready" exactly once Ã¢â‚¬â€ after it accumulates
    `temporal_min_frames` consecutive acceptable-quality, live frames within
    the last `temporal_window_frames` Ã¢â‚¬â€ implementing the "don't authenticate
    off a single frame, and don't re-authenticate every frame once locked"
    requirement without needing enrolled identities on-device.
    """

    def __init__(
        self,
        temporal_window_frames: int = 8,
        temporal_min_frames: int = 5,
        track_expiry_sec: float = 3.0,
        iou_match_threshold: float = 0.3,
        resubmit_cooldown_sec: float = 30.0,
    ):
        self.temporal_window_frames = temporal_window_frames
        self.temporal_min_frames = temporal_min_frames
        self.track_expiry_sec = track_expiry_sec
        self.iou_match_threshold = iou_match_threshold
        self.resubmit_cooldown_sec = resubmit_cooldown_sec
        self.tracks: Dict[str, Track] = {}

    def update(self, detections: List[Dict[str, Any]]) -> List[Tuple[Track, Dict[str, Any], bool]]:
        """
        Associates this frame's detections with tracks (creating new ones as
        needed), expires stale tracks, and returns
        [(track, detection, submit_ready_this_frame), ...] Ã¢â‚¬â€ one tuple per
        currently visible face, each independently evaluated.
        """
        now = time.time()
        self._expire_stale(now)

        used_track_ids = set()
        results: List[Tuple[Track, Dict[str, Any], bool]] = []

        for det in detections:
            track = self._match_track(det["bbox"], used_track_ids)
            if track is None:
                track = Track(
                    track_id=f"track_{uuid.uuid4().hex[:8]}",
                    bbox=det["bbox"],
                    last_seen=now,
                    created_at=now,
                )
                self.tracks[track.track_id] = track
                logger.debug("New track started: %s", track.track_id)

            used_track_ids.add(track.track_id)
            track.bbox = det["bbox"]
            track.last_seen = now
            track.frame_history.append(det)
            if len(track.frame_history) > self.temporal_window_frames:
                track.frame_history.pop(0)

            is_acceptable = det["quality"]["isAcceptable"] and det["liveness"]["isLive"]
            track.consecutive_acceptable = track.consecutive_acceptable + 1 if is_acceptable else 0

            submit_ready = False
            if (
                track.consecutive_acceptable >= self.temporal_min_frames
                and not track.submitted
            ):
                submit_ready = True
                track.submitted = True
                track.last_submitted_at = now
            elif track.submitted and (now - track.last_submitted_at) > self.resubmit_cooldown_sec:
                # Allow periodic re-submission (e.g. server said UNKNOWN and the
                # person is still standing there Ã¢â‚¬â€ don't lock them out forever).
                track.submitted = False
                track.consecutive_acceptable = 0

            results.append((track, det, submit_ready))

        return results

    def _match_track(self, bbox: Dict[str, int], excluded: set) -> Optional[Track]:
        best_track, best_iou = None, 0.0
        for tid, track in self.tracks.items():
            if tid in excluded:
                continue
            score = iou(track.bbox, bbox)
            if score > best_iou:
                best_iou, best_track = score, track
        if best_track is not None and best_iou >= self.iou_match_threshold:
            return best_track
        return None

    def _expire_stale(self, now: float):
        expired = [tid for tid, t in self.tracks.items() if now - t.last_seen > self.track_expiry_sec]
        for tid in expired:
            logger.debug("Track expired: %s", tid)
            del self.tracks[tid]

    def active_track_count(self) -> int:
        return len(self.tracks)

