#!/usr/bin/env python3
"""
Smart Bus IoT -- Real Student Face Enrollment

Camera -> Haar face detection -> face crop -> embedding_model.ONNXFaceEmbedder
(w600k_mbf, 112x112 RGB NCHW float32, L2-normalized 512-D) -> several accepted
samples -> normalized-mean template -> L2 -> validated persistent template.

It deliberately reuses face_engine.FrameFaceDetector (the SAME detector, crop
and embedder that main.py and webcam_test.py use for verification), so the
enrollment embedding space is identical to the verification embedding space.
It never calls build_default_embedder(): that silently falls back to the
non-production HOG+LBP embedder, which must never produce an enrollment.

Usage (from the repo root):
    python raspberry_pi/enroll_face.py --student-id student1
    python raspberry_pi/enroll_face.py --student-id student1 --force
    python raspberry_pi/enroll_face.py --student-id 3BR23CD016 --storage server --server http://localhost:3000 --username admin
    python raspberry_pi/enroll_face.py --self-test        # no webcam, no model needed

Storage targets (see ENROLLMENT.md):
    --storage local   DEVELOPMENT store. Writes --output (flat {student_id: [512 floats]},
                      directly consumable by webcam_test.py --templates and config.json's
                      local_templates_path) plus a sidecar <name>.records.json with the full
                      metadata. NOT MongoDB.
    --storage server  PRODUCTION path. POSTs to the Next.js API (/api/v1/smart-bus/face/register),
                      which stores the template in the existing `students` collection fields
                      (face_embedding, face_embeddings, face_embedding_metadata). There is no
                      silent fallback to local storage if the server is unreachable.
"""

import argparse
import getpass
import json
import logging
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

try:
    import cv2
except ImportError:  # self-test does not need OpenCV
    cv2 = None

import embedding_spec as spec

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUTPUT = os.path.join(SCRIPT_DIR, "enrollments", "local_templates.json")
RECORDS_SCHEMA = "smartbus-enrollment-records-v1"
STUDENT_ID_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")

NORM_TOLERANCE = 1e-3  # embedder rounds to 5 decimals, so real vectors are well inside this

logger = logging.getLogger("SmartBusIoT.Enroll")


class EnrollmentError(Exception):
    """Any condition that must stop enrollment without storing anything."""


class AlreadyEnrolledError(EnrollmentError):
    """Student already has a valid enrollment and --force was not given."""


# ---------------------------------------------------------------------------
# Embedding / template validation and aggregation (pure, no camera/model)
# ---------------------------------------------------------------------------

def validate_embedding(vec: Any, label: str = "embedding", expected_dim: int = spec.EMBEDDING_DIMENSION,
                       norm_tol: float = NORM_TOLERANCE) -> np.ndarray:
    """Returns the vector as float64 ndarray, or raises EnrollmentError. Never converts or repairs."""
    if vec is None or isinstance(vec, (str, bytes, dict)):
        raise EnrollmentError(f"{label}: malformed (expected a list of {expected_dim} numbers).")
    try:
        arr = np.asarray(vec, dtype=np.float64)
    except (TypeError, ValueError):
        raise EnrollmentError(f"{label}: malformed (non-numeric or ragged values).")
    if arr.ndim != 1:
        raise EnrollmentError(f"{label}: malformed (expected a flat vector, got shape {list(arr.shape)}).")
    if arr.shape[0] != expected_dim:
        raise EnrollmentError(
            f"{label}: wrong dimension {arr.shape[0]}; exactly {expected_dim} required "
            "(legacy/other-model embeddings are rejected, never converted)."
        )
    if not np.all(np.isfinite(arr)):
        raise EnrollmentError(f"{label}: contains NaN/Inf.")
    norm = float(np.linalg.norm(arr))
    if abs(norm - 1.0) > norm_tol:
        raise EnrollmentError(f"{label}: not L2-normalized (||v|| = {norm:.6f}).")
    return arr


def l2_normalize(vec: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vec))
    if not np.isfinite(norm) or norm < 1e-9:
        raise EnrollmentError("Cannot L2-normalize a zero/non-finite vector.")
    return vec / norm


def aggregate_template(embeddings: Sequence[Sequence[float]]) -> np.ndarray:
    """Normalized mean of already-validated, L2-normalized sample embeddings, re-normalized to unit length."""
    if len(embeddings) == 0:
        raise EnrollmentError("No embeddings to aggregate.")
    validated = [validate_embedding(e, f"sample {i + 1}") for i, e in enumerate(embeddings)]
    template = l2_normalize(np.mean(np.stack(validated), axis=0))
    return validate_embedding(template, "template")


def self_verification(template: Sequence[float], samples: Sequence[Sequence[float]]) -> Dict[str, float]:
    """Cosine similarity (== dot product, since all vectors are unit length) of the template vs each sample."""
    t = validate_embedding(template, "template")
    sims = [float(np.dot(t, validate_embedding(s, f"sample {i + 1}"))) for i, s in enumerate(samples)]
    return {"min": min(sims), "mean": float(np.mean(sims)), "max": max(sims)}


# ---------------------------------------------------------------------------
# Template record (metadata alongside the embedding) + validation
# ---------------------------------------------------------------------------

REQUIRED_RECORD_FIELDS = (
    "student_id", "embedding", "embedding_dimension", "model_name", "model_version",
    "normalization", "preprocessing_version", "alignment_version", "enrolled_at", "sample_count",
)


def build_record(student_id: str, template: Sequence[float], samples: Sequence[Sequence[float]],
                 enrolled_at: Optional[str] = None) -> Dict[str, Any]:
    """Metadata comes from embedding_spec.py (the canonical Python mirror of docs/EMBEDDING_SPEC.md); nothing hard-coded here."""
    if not STUDENT_ID_RE.match(student_id or ""):
        raise EnrollmentError("student_id must be 1-64 characters of letters, digits, '_', '-' or '.'.")
    meta = spec.metadata()
    t = validate_embedding(template, "template")
    sample_arrays = [validate_embedding(s, f"sample {i + 1}") for i, s in enumerate(samples)]
    record = {
        "student_id": student_id,
        "embedding": np.round(t, 6).tolist(),
        "embedding_dimension": meta["embedding_dimension"],
        "model_name": meta["model_name"],
        "model_family": meta["model_family"],
        "model_version": meta["model_version"],
        "normalization": meta["embedding_normalization"],
        "preprocessing_version": meta["preprocessing_version"],
        "alignment_version": meta["alignment_version"],
        "enrolled_at": enrolled_at or datetime.now(timezone.utc).isoformat(),
        "sample_count": len(sample_arrays),
        "sample_embeddings": [np.round(s, 6).tolist() for s in sample_arrays],
    }
    if sample_arrays:
        record["self_verification"] = {k: round(v, 6) for k, v in self_verification(t, sample_arrays).items()}
    return validate_record(record)


def validate_record(record: Any) -> Dict[str, Any]:
    """Strict: any deviation from the production spec is an error. Legacy records are rejected, not converted."""
    if not isinstance(record, dict):
        raise EnrollmentError("Template record is not an object.")
    for field in REQUIRED_RECORD_FIELDS:
        if field not in record:
            raise EnrollmentError(f"Template record missing required field '{field}'.")
    sid = record["student_id"]
    if not isinstance(sid, str) or not STUDENT_ID_RE.match(sid):
        raise EnrollmentError("Template record has an invalid student_id.")
    expected = {
        "embedding_dimension": spec.EMBEDDING_DIMENSION,
        "model_name": spec.MODEL_NAME,
        "model_version": spec.MODEL_VERSION,
        "normalization": spec.NORMALIZATION_METHOD,
        "preprocessing_version": spec.PREPROCESSING_VERSION,
        "alignment_version": spec.ALIGNMENT_VERSION,
    }
    for field, want in expected.items():
        if record[field] != want:
            raise EnrollmentError(f"Template record {field}={record[field]!r}; production spec requires {want!r}.")
    validate_embedding(record["embedding"], f"{sid} template")
    samples = record.get("sample_embeddings", [])
    if not isinstance(samples, list):
        raise EnrollmentError("sample_embeddings must be a list.")
    for i, s in enumerate(samples):
        validate_embedding(s, f"{sid} sample {i + 1}")
    count = record["sample_count"]
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        raise EnrollmentError("sample_count must be a positive integer.")
    if samples and count != len(samples):
        raise EnrollmentError(f"sample_count={count} does not match {len(samples)} stored samples.")
    try:
        datetime.fromisoformat(str(record["enrolled_at"]))
    except ValueError:
        raise EnrollmentError("enrolled_at is not a valid ISO-8601 timestamp.")
    return record


# ---------------------------------------------------------------------------
# DEVELOPMENT local store: flat matcher-compatible file + full-record sidecar
# ---------------------------------------------------------------------------

def records_path(output: str) -> str:
    root, ext = os.path.splitext(output)
    return f"{root}.records{ext or '.json'}"


def _read_json(path: str) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        raise EnrollmentError(f"Cannot read {path}: {e}")


def load_local_store(output: str) -> Dict[str, Dict[str, Any]]:
    """
    Loads and strictly validates the dev store. The sidecar holds the full records; the flat file
    ({student_id: [512 floats]}) must agree with it. Entries the flat file has that this tool did not
    create (e.g. hand-made or legacy 128-D templates) cause a refusal rather than being dropped or
    silently converted when the files are rewritten.
    """
    records: Dict[str, Dict[str, Any]] = {}
    rpath = records_path(output)
    if os.path.exists(rpath):
        doc = _read_json(rpath)
        if not isinstance(doc, dict) or doc.get("schema") != RECORDS_SCHEMA or not isinstance(doc.get("records"), dict):
            raise EnrollmentError(f"{rpath} is not a {RECORDS_SCHEMA} file.")
        for sid, rec in doc["records"].items():
            validate_record(rec)
            if rec["student_id"] != sid:
                raise EnrollmentError(f"{rpath}: record key {sid!r} != student_id {rec['student_id']!r}.")
            records[sid] = rec
    if os.path.exists(output):
        flat = _read_json(output)
        if not isinstance(flat, dict):
            raise EnrollmentError(f"{output} is not a {{student_id: [embedding]}} object.")
        foreign = sorted(set(flat) - set(records))
        if foreign:
            raise EnrollmentError(
                f"{output} contains entries not created by enroll_face.py: {foreign}. "
                "Refusing to overwrite or convert them; choose a different --output."
            )
        for sid, rec in records.items():
            if sid not in flat or not np.allclose(np.asarray(flat[sid], dtype=np.float64), rec["embedding"], atol=1e-6):
                raise EnrollmentError(f"{output} is out of sync with {rpath} for {sid!r}; refusing to continue.")
    return records


def _atomic_write_json(path: str, obj: Any) -> None:
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def save_local_store(output: str, records: Dict[str, Dict[str, Any]]) -> None:
    for rec in records.values():
        validate_record(rec)
    _atomic_write_json(records_path(output), {"schema": RECORDS_SCHEMA, "records": records})
    _atomic_write_json(output, {sid: rec["embedding"] for sid, rec in records.items()})


def check_local_duplicate(output: str, student_id: str, force: bool) -> None:
    if student_id in load_local_store(output) and not force:
        raise AlreadyEnrolledError("Student already enrolled.")


def store_local(output: str, record: Dict[str, Any], force: bool) -> None:
    validate_record(record)
    records = load_local_store(output)  # re-read at write time
    if record["student_id"] in records and not force:
        raise AlreadyEnrolledError("Student already enrolled.")
    records[record["student_id"]] = record
    save_local_store(output, records)


# ---------------------------------------------------------------------------
# PRODUCTION storage: Next.js API -> existing MongoDB `students` fields
# ---------------------------------------------------------------------------

def build_server_payload(record: Dict[str, Any], force: bool) -> Dict[str, Any]:
    validate_record(record)
    meta = spec.metadata()
    meta["production_ready"] = True  # field expected by lib/embedding-spec.ts EmbeddingMetadata
    return {
        "student_id": record["student_id"],
        "face_embedding": record["embedding"],
        "face_embeddings": record.get("sample_embeddings", []),
        "sample_count": record["sample_count"],
        "embedding_metadata": meta,
        "force_replace": bool(force),
    }


def _http():
    try:
        import requests
        return requests
    except ImportError:
        raise EnrollmentError("`requests` is required for --storage server (pip install requests).")


def _api_error(resp) -> str:
    try:
        return str(resp.json().get("detail") or resp.text)
    except ValueError:
        return resp.text[:300]


def server_login(server: str, username: str, password: str, timeout: float = 10.0) -> Dict[str, Any]:
    requests = _http()
    try:
        resp = requests.post(f"{server.rstrip('/')}/api/v1/auth/login",
                             json={"username": username, "password": password}, timeout=timeout)
    except requests.RequestException as e:
        raise EnrollmentError(
            f"Cannot reach server {server}: {e}. Nothing was stored and there is NO automatic fallback "
            "to local storage; use --storage local for development."
        )
    if resp.status_code != 200:
        raise EnrollmentError(f"Server login failed: {_api_error(resp)}")
    return resp.json()


def server_face_status(server: str, token: str, student_id: str, timeout: float = 10.0) -> Dict[str, Any]:
    requests = _http()
    resp = requests.get(f"{server.rstrip('/')}/api/v1/smart-bus/face/status",
                        params={"student_id": student_id},
                        headers={"Authorization": f"Bearer {token}"}, timeout=timeout)
    if resp.status_code == 404:
        raise EnrollmentError(f"Student {student_id!r} does not exist on the server.")
    if resp.status_code != 200:
        raise EnrollmentError(f"Face status request failed: {_api_error(resp)}")
    return resp.json()


def server_has_valid_enrollment(status: Dict[str, Any]) -> bool:
    return bool(status.get("face_registered")) and status.get("face_enrollment_status") == "OK" \
        and status.get("face_model_version") == spec.MODEL_VERSION


def server_register(server: str, token: str, record: Dict[str, Any], force: bool, timeout: float = 30.0) -> Dict[str, Any]:
    requests = _http()
    try:
        resp = requests.post(f"{server.rstrip('/')}/api/v1/smart-bus/face/register",
                             json=build_server_payload(record, force),
                             headers={"Authorization": f"Bearer {token}"}, timeout=timeout)
    except requests.RequestException as e:
        raise EnrollmentError(f"Server unreachable during upload: {e}. Nothing was stored.")
    if resp.status_code != 200:
        raise EnrollmentError(f"Server rejected the enrollment: {_api_error(resp)}")
    return resp.json()


def server_precheck(server: str, username: str, password: str, student_id: str, force: bool) -> str:
    """Logs in, verifies who will actually be enrolled, and applies duplicate protection. Returns the JWT."""
    login = server_login(server, username, password)
    role = login.get("role")
    if role == "DRIVER":
        raise EnrollmentError("DRIVER accounts cannot enroll faces.")
    if role == "STUDENT" and (login.get("student_id") or login.get("username")) != student_id:
        # The server enrolls a STUDENT login for THEIR OWN id regardless of the body; refuse rather than mis-enroll.
        raise EnrollmentError("A STUDENT login can only enroll its own student_id. Log in as ADMIN to enroll others.")
    token = login["access_token"]
    status = server_face_status(server, token, student_id)
    if server_has_valid_enrollment(status) and not force:
        raise AlreadyEnrolledError("Student already enrolled.")
    if force and role != "ADMIN" and server_has_valid_enrollment(status):
        raise EnrollmentError("--force replacement on the server requires an ADMIN login.")
    return token


# ---------------------------------------------------------------------------
# Frame assessment + sample selection (pure, testable without a camera)
# ---------------------------------------------------------------------------

NO_FACE, MULTIPLE_FACES, LOW_QUALITY, FACE_OK = "NO_FACE", "MULTIPLE_FACES", "LOW_QUALITY", "OK"


def assess_frame(frame: Optional[np.ndarray], detections: List[Dict[str, Any]], min_face_px: int = 80,
                 min_brightness: float = 50.0, max_brightness: float = 215.0) -> Tuple[str, str, Optional[Dict[str, Any]]]:
    """Returns (code, user message, the single usable detection or None)."""
    if len(detections) == 0:
        return NO_FACE, "NO FACE DETECTED", None
    if len(detections) > 1:
        return MULTIPLE_FACES, "MULTIPLE FACES\nPlease ensure only the student is visible.", None
    det = detections[0]
    box = det["bbox"]
    reasons = []
    if not det["quality"]["isAcceptable"]:
        reasons.append("image is blurry - hold still")
    if min(box["width"], box["height"]) < min_face_px:
        reasons.append("face too small")
    if frame is not None:
        crop = frame[box["y"]: box["y"] + box["height"], box["x"]: box["x"] + box["width"]]
        if crop.size:
            brightness = float(np.mean(crop))
            if brightness < min_brightness:
                reasons.append("too dark")
            elif brightness > max_brightness:
                reasons.append("too bright")
    if reasons:
        return LOW_QUALITY, "LOW QUALITY\nMove closer / improve lighting. (" + "; ".join(reasons) + ")", None
    return FACE_OK, "Face OK", det


class SampleCollector:
    """
    Accepts embeddings only if they are valid, spaced in time, not near-duplicates of an already accepted
    sample (so the ten samples carry modest variation), and consistent with the samples so far (so a
    different person stepping in mid-enrollment is not blended into the template). The thresholds are
    uncalibrated safety heuristics, not accuracy claims -- all are CLI-tunable.
    """

    def __init__(self, target: int = 10, min_interval_sec: float = 0.7,
                 max_similarity_to_existing: float = 0.98, min_consistency: float = 0.5):
        self.target = target
        self.min_interval_sec = min_interval_sec
        self.max_similarity_to_existing = max_similarity_to_existing
        self.min_consistency = min_consistency
        self.samples: List[np.ndarray] = []
        self.last_accept_time: Optional[float] = None

    @property
    def done(self) -> bool:
        return len(self.samples) >= self.target

    def offer(self, embedding: Sequence[float], now: float) -> Tuple[bool, str]:
        try:
            vec = validate_embedding(embedding, "captured embedding")
        except EnrollmentError as e:
            return False, f"INVALID_EMBEDDING: {e}"
        if self.last_accept_time is not None and now - self.last_accept_time < self.min_interval_sec:
            return False, "TOO_SOON"
        if self.samples:
            if max(float(np.dot(vec, s)) for s in self.samples) > self.max_similarity_to_existing:
                return False, "TOO_SIMILAR"
            mean_dir = l2_normalize(np.mean(np.stack(self.samples), axis=0))
            if float(np.dot(vec, mean_dir)) < self.min_consistency:
                return False, "INCONSISTENT"
        self.samples.append(vec)
        self.last_accept_time = now
        return True, "ACCEPTED"


# ---------------------------------------------------------------------------
# Embedder: real model only, never the HOG+LBP fallback
# ---------------------------------------------------------------------------

def resolve_model_path(path: str) -> str:
    if os.path.isabs(path) or os.path.exists(path):
        return path
    return os.path.join(SCRIPT_DIR, path)


def load_production_embedder(model_path: str):
    from embedding_model import ONNXFaceEmbedder

    embedder = ONNXFaceEmbedder(resolve_model_path(model_path))
    metadata = embedder.metadata()

    checks = {
        "production_ready": embedder.production_ready is True,
        "model_version": embedder.model_version == spec.MODEL_VERSION,
        "embedding_dimension": (
            embedder.embedding_dim == spec.EMBEDDING_DIMENSION
        ),
        "normalization": (
            embedder.normalization == spec.NORMALIZATION_METHOD
        ),
        "model_name": embedder.model_name == spec.MODEL_NAME,
        "model_family": metadata.get("model_family") == spec.MODEL_FAMILY,
    }

    failed_checks = [name for name, passed in checks.items() if not passed]

    if failed_checks:
        raise EnrollmentError(
            "Production embedder failed specification validation: "
            f"{', '.join(failed_checks)}. "
            f"Metadata: {metadata}. Enrollment will NOT fall back "
            "to the classical CV embedder."
        )

    return embedder

# ---------------------------------------------------------------------------
# Live capture
# ---------------------------------------------------------------------------

def _draw(frame, lines: List[str], color, bbox=None, progress: Optional[Tuple[int, int]] = None):
    if bbox:
        cv2.rectangle(frame, (bbox["x"], bbox["y"]), (bbox["x"] + bbox["width"], bbox["y"] + bbox["height"]), color, 2)
    y = 25
    for line in lines:
        cv2.putText(frame, line, (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2, cv2.LINE_AA)
        y += 24
    if progress:
        done, total = progress
        h, w = frame.shape[:2]
        cv2.rectangle(frame, (10, h - 25), (w - 10, h - 10), (80, 80, 80), 1)
        cv2.rectangle(frame, (10, h - 25), (10 + int((w - 20) * done / max(1, total)), h - 10), color, -1)


def capture_samples(student_id: str, embedder, args) -> List[np.ndarray]:
    from face_engine import FrameFaceDetector
    if cv2 is None:
        raise EnrollmentError("OpenCV is not installed (pip install opencv-python).")

    detector = FrameFaceDetector(blur_threshold=60.0, max_faces=4, embedder=embedder)
    if getattr(detector, "scrfd_detector", None) is None:
        raise EnrollmentError("SCRFD face detector failed to initialize.")
    collector = SampleCollector(args.samples, args.min_interval, args.max_sample_similarity, args.min_consistency)

    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise EnrollmentError(f"Could not open webcam index {args.camera}.")

    window = "Smart Bus -- Face Enrollment"
    start = time.time()
    last_hint_ref = start
    print("\nSMART BUS FACE ENROLLMENT")
    print(f"Student: {student_id}")
    print("Looking for one face...  (press 'q' in the window to cancel; nothing is saved on cancel)\n")
    last_console = None
    try:
        while not collector.done:
            now = time.time()
            if now - start > args.timeout:
                raise EnrollmentError(f"Timed out after {args.timeout:.0f}s with {len(collector.samples)}/{args.samples} samples. Nothing was stored.")
            ok, frame = cap.read()
            if not ok:
                raise EnrollmentError("Webcam frame read failed. Nothing was stored.")

            detections = detector.process(frame, role="ENTRY", simulated=False)
            code, message, det = assess_frame(frame, detections, args.min_face_px)
            color = (0, 200, 0) if code == FACE_OK else (0, 0, 220)
            bbox = det["bbox"] if det else (detections[0]["bbox"] if len(detections) == 1 else None)
            status_lines = message.split("\n")

            if det is not None:
                accepted, reason = collector.offer(det["embedding"], now)
                if accepted:
                    n = len(collector.samples)
                    print(f"Sample {n}/{args.samples} captured")
                    status_lines = [f"Sample {n}/{args.samples} captured"]
                    last_hint_ref = now
                elif reason.startswith("INVALID_EMBEDDING"):
                    status_lines = ["INVALID EMBEDDING - sample rejected"]
                    color = (0, 0, 220)
                elif reason == "INCONSISTENT":
                    status_lines = ["Face differs from earlier samples", "Only the enrolling student should be in view"]
                    color = (0, 140, 255)
                elif now - last_hint_ref > 6.0:
                    status_lines = ["Slightly turn/tilt your head or change expression"]
                    color = (0, 200, 255)
                else:
                    status_lines = ["Hold steady - capturing"]

            if status_lines[0] != last_console and code != FACE_OK:
                print(status_lines[0])
            last_console = status_lines[0]

            header = ["SMART BUS FACE ENROLLMENT", f"Student: {student_id}  Samples: {len(collector.samples)}/{args.samples}"]
            _draw(frame, header + status_lines, color, bbox, (len(collector.samples), args.samples))
            cv2.imshow(window, frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                raise EnrollmentError("Enrollment cancelled. Nothing was stored.")
    finally:
        cap.release()
        cv2.destroyAllWindows()
    return collector.samples


# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------

def run_enrollment(args) -> int:
    student_id = args.student_id
    if not STUDENT_ID_RE.match(student_id or ""):
        print("ERROR: --student-id must be 1-64 characters of letters, digits, '_', '-' or '.'.")
        return 1
    if args.samples < 3 or args.samples > 50:
        print("ERROR: --samples must be between 3 and 50 (single-frame enrollment is not allowed).")
        return 1

    token = None
    try:
        # Cheap checks first, before the model or camera are touched.
        if args.storage == "local":
            print(f"[DEVELOPMENT] Local template store: {args.output}  (NOT MongoDB)")
            check_local_duplicate(args.output, student_id, args.force)
        else:
            username = args.username or os.environ.get("SMARTBUS_ENROLL_USER") or input("Server username: ")
            password = os.environ.get("SMARTBUS_ENROLL_PASSWORD") or getpass.getpass("Server password: ")
            token = server_precheck(args.server, username, password, student_id, args.force)
            print(f"[PRODUCTION] Server: {args.server} -> MongoDB students collection")

        # Silence a harmless ORT warning (output metadata says batch=1; verified bit-identical results). See ENROLLMENT.md.
        try:
            import onnxruntime as ort
            ort.set_default_logger_severity(3)
        except ImportError:
            pass
        embedder = load_production_embedder(args.model_path)
        print(f"Embedder: {embedder.model_name} / {embedder.model_version} / {embedder.embedding_dim}-D / L2 / production_ready={embedder.production_ready}")

        samples = capture_samples(student_id, embedder, args)

        template = aggregate_template(samples)
        stats = self_verification(template, samples)
        valid = template.shape[0] == spec.EMBEDDING_DIMENSION and bool(np.all(np.isfinite(template))) \
            and stats["min"] >= args.min_consistency
        record = build_record(student_id, template, samples)

        if not valid:
            print(f"\nEnrollment FAILED self-verification (min similarity {stats['min']:.4f} < {args.min_consistency}). Template valid: NO. Nothing stored.")
            return 2

        if args.storage == "local":
            store_local(args.output, record, args.force)
            where = f"{args.output} (+ {records_path(args.output)})  [DEVELOPMENT store]"
        else:
            result = server_register(args.server, token, record, args.force)
            where = f"{args.server} -> MongoDB ({result.get('message', 'ok')})"

        print("\nEnrollment successful\n")
        print(f"Student: {student_id}")
        print(f"Model: {record['model_version']}")
        print(f"Dimension: {record['embedding_dimension']}")
        print(f"Samples: {record['sample_count']}")
        print(f"Stored: {where}\n")
        print("Self-verification:")
        print(f"Min similarity: {stats['min']:.4f}")
        print(f"Mean similarity: {stats['mean']:.4f}")
        print(f"Max similarity: {stats['max']:.4f}\n")
        print("Template valid: YES")
        return 0
    except AlreadyEnrolledError as e:
        print(f"\n{e}")
        print("Use --force to replace the existing enrollment." + (" (Server replacement requires an ADMIN login.)" if args.storage == "server" else ""))
        return 1
    except EnrollmentError as e:
        print(f"\nERROR: {e}")
        return 1


# ---------------------------------------------------------------------------
# Self-test (no webcam, no model file)
# ---------------------------------------------------------------------------

def _self_test() -> bool:
    import copy
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    results: List[bool] = []

    def check(label: str, passed: bool, detail: str = "") -> None:
        results.append(bool(passed))
        marker = "\u2713" if passed else "\u2717"
        print(f"{marker} {label}" + (f" -- {detail}" if detail else ""))

    def rejects(fn, *a, **k) -> bool:
        try:
            fn(*a, **k)
        except EnrollmentError:
            return True
        return False

    rng = np.random.default_rng(42)

    def unit(seed_vec=None) -> np.ndarray:
        v = rng.standard_normal(spec.EMBEDDING_DIMENSION) if seed_vec is None else seed_vec
        return v / np.linalg.norm(v)

    def near(base: np.ndarray, noise: float) -> np.ndarray:
        return unit(base + noise * rng.standard_normal(base.shape[0]) / np.sqrt(base.shape[0]))

    # --- 512-D / finite / normalization / malformed -------------------------------------------
    good = unit()
    check("valid 512-D L2-normalized embedding accepted", not rejects(validate_embedding, good.tolist()))
    check("wrong dimension rejected (128, 511, 513, 0)",
          all(rejects(validate_embedding, unit(rng.standard_normal(d)).tolist() if d else []) for d in (128, 511, 513, 0)))
    bad_nan, bad_inf, bad_ninf = good.copy(), good.copy(), good.copy()
    bad_nan[3], bad_inf[7], bad_ninf[9] = np.nan, np.inf, -np.inf
    check("NaN / +Inf / -Inf rejected", all(rejects(validate_embedding, v.tolist()) for v in (bad_nan, bad_inf, bad_ninf)))
    check("malformed embeddings rejected (None, str, dict, strings, nested, ragged, 2-D)",
          all(rejects(validate_embedding, v) for v in
              (None, "abc", {"a": 1}, ["x"] * 512, [[0.1] * 512], [[0.1] * 3, [0.1]], np.zeros((2, 256)))))
    check("non-normalized and all-zero embeddings rejected",
          rejects(validate_embedding, (good * 3).tolist()) and rejects(validate_embedding, [0.0] * 512))

    # --- L2 normalization / aggregation -------------------------------------------------------
    raw = rng.standard_normal(512) * 7
    check("L2 normalization works (||v|| == 1)", abs(np.linalg.norm(l2_normalize(raw)) - 1.0) < 1e-12)
    base = unit()
    samples = [near(base, 0.6) for _ in range(10)]
    template = aggregate_template([s.tolist() for s in samples])
    mean_dir = np.mean(np.stack(samples), axis=0)
    mean_dir /= np.linalg.norm(mean_dir)
    check("template is 512-D, finite, unit length", template.shape == (512,) and np.all(np.isfinite(template))
          and abs(np.linalg.norm(template) - 1.0) < 1e-9)
    check("template == normalized mean of samples", float(np.dot(template, mean_dir)) > 1 - 1e-9)
    check("aggregation rejects a bad sample / empty input",
          rejects(aggregate_template, [good.tolist(), bad_nan.tolist()]) and rejects(aggregate_template, []))

    # --- self-verification --------------------------------------------------------------------
    stats = self_verification(template, samples)
    check("self-verification min <= mean <= max, all cosine in [-1, 1]",
          stats["min"] <= stats["mean"] <= stats["max"] and -1 <= stats["min"] and stats["max"] <= 1 + 1e-9,
          f"min={stats['min']:.3f} mean={stats['mean']:.3f} max={stats['max']:.3f}")
    ident = self_verification(good, [good, good])
    check("template vs identical samples -> similarity 1.0", abs(ident["min"] - 1) < 1e-9 and abs(ident["max"] - 1) < 1e-9)

    # --- record / metadata / serialization ----------------------------------------------------
    record = build_record("student1", template, samples)
    meta_ok = (record["model_version"] == spec.MODEL_VERSION == "arcface-w600k_mbf-v1" and record["embedding_dimension"] == 512
               and record["normalization"] == "l2" and record["alignment_version"] == spec.ALIGNMENT_VERSION
               and record["preprocessing_version"] == spec.PREPROCESSING_VERSION and record["sample_count"] == 10
               and set(REQUIRED_RECORD_FIELDS) <= set(record))
    check("record carries all required metadata, sourced from embedding_spec", meta_ok)
    revived = json.loads(json.dumps(record))
    check("record serialization -> deserialization round-trips and re-validates",
          revived == record and validate_record(revived) is revived)
    check("metadata-validation rejects each deviation", all(rejects(validate_record, r) for r in (
        {**record, "model_version": "arcface-w600k_mbf-v0"}, {**record, "embedding_dimension": 128},
        {**record, "normalization": "none"}, {**record, "model_name": "other"},
        {**record, "alignment_version": "x"}, {**record, "preprocessing_version": "9.9"},
        {**record, "sample_count": 0}, {**record, "sample_count": 3}, {**record, "enrolled_at": "yesterday"},
        {k: v for k, v in record.items() if k != "enrolled_at"}, {**record, "student_id": "bad id!"}, "not a dict")))
    legacy = {**record, "embedding": [0.0884] * 128}
    check("legacy 128-D record rejected (not converted)", rejects(validate_record, legacy))
    check("build_record rejects bad student_id and bad embeddings",
          rejects(build_record, "../x", template, samples) and rejects(build_record, "s", bad_nan.tolist(), samples))

    # --- frame assessment / sample collector --------------------------------------------------
    def fake_det(w=150, h=150, acceptable=True):
        return {"bbox": {"x": 10, "y": 10, "width": w, "height": h}, "quality": {"isAcceptable": acceptable}}
    frame = np.full((300, 300, 3), 120, dtype=np.uint8)
    check("assess_frame: no face -> NO FACE DETECTED", assess_frame(frame, [])[:2] == (NO_FACE, "NO FACE DETECTED"))
    mf = assess_frame(frame, [fake_det(), fake_det()])
    check("assess_frame: two faces -> MULTIPLE FACES + instruction", mf[0] == MULTIPLE_FACES and "Please ensure only the student is visible." in mf[1])
    check("assess_frame: blurry / small / dark / bright -> LOW QUALITY",
          all(assess_frame(f, [d])[0] == LOW_QUALITY for f, d in (
              (frame, fake_det(acceptable=False)), (frame, fake_det(w=40, h=40)),
              (np.full((300, 300, 3), 10, np.uint8), fake_det()), (np.full((300, 300, 3), 250, np.uint8), fake_det()))))
    check("assess_frame: good single face accepted", assess_frame(frame, [fake_det()])[0] == FACE_OK)

    col = SampleCollector(target=3, min_interval_sec=1.0, max_similarity_to_existing=0.98, min_consistency=0.5)
    p = unit()
    a1 = col.offer(p.tolist(), 0.0)
    a2 = col.offer(near(p, 0.5).tolist(), 0.2)
    a3 = col.offer(p.tolist(), 1.5)
    a4 = col.offer(unit().tolist(), 3.0)
    a5 = col.offer(bad_nan.tolist(), 4.0)
    a6 = col.offer(near(p, 0.7).tolist(), 5.0)
    check("collector: accepts first, rejects too-soon / near-duplicate / different person / invalid, accepts varied later sample",
          a1 == (True, "ACCEPTED") and a2 == (False, "TOO_SOON") and a3 == (False, "TOO_SIMILAR")
          and a4 == (False, "INCONSISTENT") and a5[1].startswith("INVALID_EMBEDDING") and a6 == (True, "ACCEPTED"),
          f"{a1[1]},{a2[1]},{a3[1]},{a4[1]},{a5[1][:17]},{a6[1]}")

    # --- local (development) store: format, duplicates, matcher compatibility -------------------
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "t", "local_templates.json")
        store_local(out, record, force=False)
        flat = json.load(open(out))
        check("local store writes matcher-compatible flat {student_id: [512 floats]}",
              list(flat) == ["student1"] and len(flat["student1"]) == 512 and all(isinstance(x, float) for x in flat["student1"]))
        check("local store sidecar reloads and validates", load_local_store(out)["student1"] == record)

        dup_blocked = False
        try:
            store_local(out, record, force=False)
        except AlreadyEnrolledError as e:
            dup_blocked = str(e) == "Student already enrolled."
        check("duplicate enrollment blocked without --force ('Student already enrolled.')", dup_blocked)
        check("pre-capture duplicate check also blocks", rejects(check_local_duplicate, out, "student1", False))
        check_local_duplicate(out, "student1", True)
        check_local_duplicate(out, "student2", False)

        other_base = unit()
        other_samples = [near(other_base, 0.6) for _ in range(5)]
        other = build_record("student2", aggregate_template(other_samples), other_samples)
        store_local(out, other, False)
        newer = build_record("student1", aggregate_template([near(base, 0.6) for _ in range(5)]),
                             [near(base, 0.6) for _ in range(5)])
        store_local(out, newer, force=True)
        reloaded = load_local_store(out)
        check("--force replaces only that student; others untouched",
              set(reloaded) == {"student1", "student2"} and reloaded["student1"]["sample_count"] == 5
              and reloaded["student2"] == other)

        from identity_matcher import LocalIdentityMatcher
        matcher = LocalIdentityMatcher()
        matcher.sync_templates(json.load(open(out)))  # exactly how webcam_test.py / main.py load it
        probe1, probe2 = near(base, 0.3).tolist(), near(other_base, 0.3).tolist()
        r1, r2, r3 = matcher.match(probe1), matcher.match(probe2), matcher.match(unit().tolist())
        check("LocalIdentityMatcher consumes the file unchanged: RECOGNIZED correct student, UNKNOWN stranger",
              (r1.status, r1.student_id) == ("RECOGNIZED", "student1") and (r2.status, r2.student_id) == ("RECOGNIZED", "student2")
              and r3.status == "UNKNOWN", f"{r1.status}/{r1.student_id}, {r2.status}/{r2.student_id}, {r3.status}")

        foreign = os.path.join(tmp, "foreign.json")
        json.dump({"legacy": [0.1] * 128}, open(foreign, "w"))
        check("flat file with foreign/legacy 128-D entries refused (never overwritten or converted)",
              rejects(store_local, foreign, record, False))
        desync = os.path.join(tmp, "d", "local_templates.json")
        store_local(desync, record, False)
        bad_flat = json.load(open(desync)); bad_flat["student1"][0] += 0.5
        json.dump(bad_flat, open(desync, "w"))
        check("flat file out of sync with sidecar refused", rejects(load_local_store, desync))

    # --- server client vs. a MOCK server (not the real Next.js app) ------------------------------
    state = {"enrolled": False, "calls": [], "role": "ADMIN", "login_student": None}

    class Mock(BaseHTTPRequestHandler):
        def log_message(self, *a): pass

        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            state["calls"].append(self.path)
            if self.path == "/api/v1/auth/login":
                return self._send(200 if payload.get("password") == "pw" else 401,
                                  {"access_token": "tok", "role": state["role"], "username": "u", "student_id": state["login_student"]}
                                  if payload.get("password") == "pw" else {"detail": "Invalid username or password"})
            if self.headers.get("Authorization") != "Bearer tok":
                return self._send(401, {"detail": "expired"})
            if self.path == "/api/v1/smart-bus/face/register":
                state["payload"] = payload
                if state["enrolled"] and not payload.get("force_replace"):
                    return self._send(400, {"detail": "Face already registered."})
                state["enrolled"] = True
                return self._send(200, {"success": True, "message": "Face registration completed successfully."})
            self._send(404, {"detail": "nope"})

        def do_GET(self):
            state["calls"].append(self.path.split("?")[0])
            if self.headers.get("Authorization") != "Bearer tok":
                return self._send(401, {"detail": "expired"})
            if "student_id=ghost" in self.path:
                return self._send(404, {"detail": "Student face record not found"})
            self._send(200, {"face_registered": state["enrolled"], "face_enrollment_status": "OK" if state["enrolled"] else "NOT_ENROLLED",
                             "face_model_version": spec.MODEL_VERSION if state["enrolled"] else None})

        # (login is POST; status is GET)

    httpd = HTTPServer(("127.0.0.1", 0), Mock)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        payload = build_server_payload(record, force=False)
        check("server payload: 512-D template + samples + spec metadata (production_ready) + force flag",
              len(payload["face_embedding"]) == 512 and len(payload["face_embeddings"]) == 10
              and payload["embedding_metadata"]["model_version"] == spec.MODEL_VERSION
              and payload["embedding_metadata"]["embedding_normalization"] == "l2"
              and payload["embedding_metadata"]["production_ready"] is True and payload["force_replace"] is False)
        check("server login failure surfaces as an error", rejects(server_login, url, "u", "wrong"))
        token = server_precheck(url, "u", "pw", "student1", False)
        server_register(url, token, record, False)
        check("server: precheck + register succeed for a new enrollment", token == "tok" and state["enrolled"])
        dup = False
        try:
            server_precheck(url, "u", "pw", "student1", False)
        except AlreadyEnrolledError:
            dup = True
        check("server: duplicate enrollment blocked in precheck", dup)
        forced_token = server_precheck(url, "u", "pw", "student1", True)
        server_register(url, forced_token, record, True)
        check("server: --force passes precheck and sends force_replace=true",
              forced_token == "tok" and state["payload"]["force_replace"] is True)
        check("server: rejection without force surfaces the server's reason", rejects(server_register, url, "tok", record, False))
        state["role"], state["login_student"] = "STUDENT", "someone_else"
        check("server: STUDENT login cannot enroll a different student_id", rejects(server_precheck, url, "u", "pw", "student1", False))
        state["role"] = "DRIVER"
        check("server: DRIVER login refused", rejects(server_precheck, url, "u", "pw", "student1", False))
        state["role"] = "ADMIN"
        check("server: unknown student reported", rejects(server_precheck, url, "u", "pw", "ghost", False))
    finally:
        httpd.shutdown()
    check("server: unreachable host fails loudly with no local fallback", rejects(server_login, "http://127.0.0.1:1", "u", "pw", 1.0))

    passed = sum(results)
    print(f"\n{'ALL CHECKS PASSED' if all(results) else 'SOME CHECKS FAILED'} ({passed}/{len(results)})")
    return all(results)


def main() -> int:
    p = argparse.ArgumentParser(description="Smart Bus real face enrollment (w600k_mbf, 512-D, L2)")
    p.add_argument("--student-id", help="Student ID to enroll")
    p.add_argument("--camera", type=int, default=0, help="Webcam index (default 0)")
    p.add_argument("--samples", type=int, default=10, help="Number of accepted samples (default 10, min 3)")
    p.add_argument("--force", action="store_true", help="Replace an existing enrollment")
    p.add_argument("--output", default=DEFAULT_OUTPUT, help="DEVELOPMENT local template file (flat {student_id: [512]}); sidecar <name>.records.json holds metadata")
    p.add_argument("--storage", choices=["local", "server"], default="local", help="local = development JSON store (default); server = Next.js API -> MongoDB")
    p.add_argument("--server", default="http://localhost:3000", help="Next.js base URL for --storage server")
    p.add_argument("--username", help="Server login (ADMIN to enroll others); password via SMARTBUS_ENROLL_PASSWORD or prompt")
    p.add_argument("--model-path", default=spec.DEFAULT_MODEL_PATH, help="Path to the ONNX model (default: models/face_embedding.onnx next to this script)")
    p.add_argument("--min-face-px", type=int, default=80, help="Minimum face box side in pixels (default 80)")
    p.add_argument("--min-interval", type=float, default=0.7, help="Minimum seconds between accepted samples (default 0.7)")
    p.add_argument("--max-sample-similarity", type=float, default=0.98, help="Reject a sample this similar to an accepted one (default 0.98)")
    p.add_argument("--min-consistency", type=float, default=0.5, help="Min cosine similarity of a sample to the running mean (default 0.5; uncalibrated)")
    p.add_argument("--timeout", type=float, default=120.0, help="Abort (storing nothing) after this many seconds (default 120)")
    p.add_argument("--self-test", action="store_true", help="Run the webcam-free self-test")
    args = p.parse_args()

    if args.self_test:
        return 0 if _self_test() else 1
    if not args.student_id:
        print("\n=== Smart Bus Face Enrollment ===")
        student_name = input("Enter student name: ").strip()
        student_id = input("Enter student USN: ").strip()

        if not student_name:
            print("ERROR: Student name is required.")
            return 1
        if not STUDENT_ID_RE.match(student_id or ""):
            print("ERROR: Invalid student USN.")
            return 1

        args.student_id = student_id
        args.storage = "server"
        args.server = args.server or "http://localhost:3000"
        args.username = args.username or os.environ.get("SMARTBUS_ENROLL_USER")
        if not args.username or not os.environ.get("SMARTBUS_ENROLL_PASSWORD"):
            print("ERROR: Configure SMARTBUS_ENROLL_USER and SMARTBUS_ENROLL_PASSWORD first.")
            return 1

        print(f"\nStudent name: {student_name}")
        print(f"Student USN:  {student_id}")

    return run_enrollment(args)


if __name__ == "__main__":
    sys.exit(main())

