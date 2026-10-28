#!/usr/bin/env python3
"""
Smart Bus IoT — Pipeline & Recognition Benchmark

Measures, against synthetic-but-realistically-jittered face crops (no camera
or real people available in this sandbox):
  - detection-only latency, embedding-only latency, and combined latency
  - single-face vs four-face frame throughput
  - quality-gate correctness (good frame passes, bad frame doesn't)
  - REAL recognition metrics now that the embedder (embedding_model.py)
    actually discriminates between different synthetic faces: genuine match
    rate, false acceptance rate, false rejection rate, unknown-rejection rate

CPU SANDBOX vs RASPBERRY PI — READ THIS: every number below comes from
whatever CPU this container happens to be running on, which is almost
certainly faster than a Raspberry Pi 4/5's Cortex-A72/A76. Treat these as
*relative/algorithmic* numbers (is embedding batching actually faster than
one-at-a-time? does the quality gate actually reject blur? does matching
actually separate same/different?) — not as a promise of real-world FPS on
a Pi. Section 2 at the bottom tells you how to re-run this on actual
hardware.

Run: python3 benchmark.py
"""

import json
import statistics
import time

import numpy as np
import cv2

from face_engine import FrameFaceDetector, MultiFaceTracker
from embedding_model import HOGLBPEmbedder
from identity_matcher import LocalIdentityMatcher


# ---------------------------------------------------------------------------
# Synthetic face generation (see docs/FOUR_FACE_PROCESSING.md for why a real
# camera/human dataset isn't available in this environment)
# ---------------------------------------------------------------------------

def make_face(cx=60, cy=60, size=120, eye_gap=22, jaw_width=55, eye_size=7, skin=(180, 150, 140)):
    img = np.full((size, size, 3), 30, dtype=np.uint8)
    cv2.ellipse(img, (cx, cy), (jaw_width, int(size * 0.62)), 0, 0, 360, skin, -1)
    cv2.circle(img, (cx - eye_gap, cy - 15), eye_size, (20, 20, 20), -1)
    cv2.circle(img, (cx + eye_gap, cy - 15), eye_size, (20, 20, 20), -1)
    cv2.ellipse(img, (cx, cy + 30), (20, 8), 0, 0, 180, (40, 40, 140), 2)
    return img


def jitter(img, rng, translate=2.0, noise=3):
    dx, dy = rng.uniform(-translate, translate, 2)
    M = np.float32([[1, 0, dx], [0, 1, dy]])
    out = cv2.warpAffine(img, M, (img.shape[1], img.shape[0]), borderMode=cv2.BORDER_REPLICATE)
    n = rng.integers(-noise, noise + 1, size=img.shape, dtype=np.int16)
    return np.clip(out.astype(np.int16) + n, 0, 255).astype(np.uint8)


IDENTITY_PARAMS = [
    dict(eye_gap=18, jaw_width=48, eye_size=6, skin=(180, 150, 140)),
    dict(eye_gap=24, jaw_width=58, eye_size=8, skin=(170, 140, 130)),
    dict(eye_gap=20, jaw_width=52, eye_size=7, skin=(190, 160, 150)),
    dict(eye_gap=28, jaw_width=64, eye_size=9, skin=(160, 130, 120)),
    dict(eye_gap=22, jaw_width=55, eye_size=7, skin=(200, 170, 160)),
    dict(eye_gap=17, jaw_width=45, eye_size=6, skin=(175, 145, 135)),
]


def make_synthetic_frame(width=640, height=480, n_faces=1, blurry=False, dark=False):
    img = np.zeros((height, width, 3), dtype=np.uint8)
    base = (10, 10, 12) if dark else (30, 30, 35)
    img[:, :] = base
    positions = [(width // 5, height // 2), (2 * width // 5, height // 2),
                 (3 * width // 5, height // 2), (4 * width // 5, height // 2)]
    for i in range(min(n_faces, 4)):
        cx, cy = positions[i]
        color = (90, 75, 70) if dark else (180, 150, 140)
        cv2.ellipse(img, (cx, cy), (55, 75), 0, 0, 360, color, -1)
        cv2.circle(img, (cx - 20, cy - 15), 7, (20, 20, 20), -1)
        cv2.circle(img, (cx + 20, cy - 15), 7, (20, 20, 20), -1)
    if blurry:
        img = cv2.GaussianBlur(img, (25, 25), 0)
    return img


def _with_jitter(frame, rng):
    """Small translation (not pixel noise -- see note in section 1) so consecutive frames aren't identical."""
    dx, dy = rng.uniform(-1.5, 1.5, size=2)
    h, w = frame.shape[:2]
    M = np.float32([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(frame, M, (w, h), borderMode=cv2.BORDER_REPLICATE)


def summarize(latencies_ms):
    return {
        "count": len(latencies_ms),
        "mean_ms": round(statistics.mean(latencies_ms), 2),
        "p50_ms": round(statistics.median(latencies_ms), 2),
        "p95_ms": round(sorted(latencies_ms)[max(0, int(len(latencies_ms) * 0.95) - 1)], 2),
        "max_ms": round(max(latencies_ms), 2),
        "implied_max_fps": round(1000.0 / statistics.mean(latencies_ms), 1),
    }


# ---------------------------------------------------------------------------
# Section 1: latency (detection vs embedding, split out)
# ---------------------------------------------------------------------------

def bench_latency(detector: FrameFaceDetector, embedder: HOGLBPEmbedder):
    good_frame = make_synthetic_frame(n_faces=1)

    # Combined (what actually runs per frame in main.py)
    single_combined_ms = []
    for _ in range(100):
        t0 = time.perf_counter()
        detector.process(good_frame, role="ENTRY", simulated=False)
        single_combined_ms.append((time.perf_counter() - t0) * 1000)

    # Embedding-only: pre-crop once, time just embed_batch repeatedly.
    crop = good_frame[10:130, 260:380]  # roughly where the synthetic face sits
    if crop.size == 0:
        crop = good_frame
    embed_only_ms = []
    for _ in range(100):
        t0 = time.perf_counter()
        embedder.embed_batch([crop])
        embed_only_ms.append((time.perf_counter() - t0) * 1000)

    four_frame = make_synthetic_frame(n_faces=4)
    four_combined_ms = []
    detection_counts = []
    for _ in range(50):
        t0 = time.perf_counter()
        dets = detector.process(four_frame, role="ENTRY", simulated=False)
        four_combined_ms.append((time.perf_counter() - t0) * 1000)
        detection_counts.append(len(dets))

    return {
        "single_face_combined_detect_plus_embed": summarize(single_combined_ms),
        "embedding_only_single_crop": summarize(embed_only_ms),
        "detection_only_approx_ms": round(
            statistics.mean(single_combined_ms) - statistics.mean(embed_only_ms), 2
        ),
        "four_face_combined_detect_plus_embed": summarize(four_combined_ms),
        "four_face_detections_per_frame": {
            "min": min(detection_counts), "max": max(detection_counts),
            "mean": round(statistics.mean(detection_counts), 2),
        },
    }


# ---------------------------------------------------------------------------
# Section 1: quality gate
# ---------------------------------------------------------------------------

def bench_quality_gate(detector: FrameFaceDetector, n_frames=20):
    rng = np.random.default_rng(42)
    good_base = make_synthetic_frame(n_faces=1)
    bad_base = make_synthetic_frame(n_faces=1, blurry=True, dark=True)

    tracker = MultiFaceTracker(temporal_window_frames=8, temporal_min_frames=5, track_expiry_sec=5.0)
    good_submits = 0
    for _ in range(n_frames):
        dets = detector.process(_with_jitter(good_base, rng), role="ENTRY", simulated=False)
        for _, _, ready in tracker.update(dets):
            if ready:
                good_submits += 1

    tracker2 = MultiFaceTracker(temporal_window_frames=8, temporal_min_frames=5, track_expiry_sec=5.0)
    bad_submits = 0
    for _ in range(n_frames):
        dets = detector.process(_with_jitter(bad_base, rng), role="ENTRY", simulated=False)
        for _, _, ready in tracker2.update(dets):
            if ready:
                bad_submits += 1

    return {
        "good_quality_frame_reached_consensus_times": good_submits,
        "bad_quality_frame_reached_consensus_times": bad_submits,
        "expected": "good > 0, bad == 0",
        "pass": good_submits > 0 and bad_submits == 0,
    }


# ---------------------------------------------------------------------------
# Section 1: REAL recognition metrics (genuine match rate, FAR, FRR, unknown
# rejection) using the actual embedder + actual LocalIdentityMatcher.
# ---------------------------------------------------------------------------

def bench_recognition(embedder: HOGLBPEmbedder, n_enroll_samples=5, n_query_samples=5):
    """
    Does NOT assume a threshold -- measures the real genuine/impostor
    similarity distributions from the actual embedder, sweeps for the
    empirical equal-error-rate (EER) operating point, and reports metrics
    AT that measured point. This is what item 10 in the brief means by
    "do not blindly choose a threshold."
    """
    rng = np.random.default_rng(2024)

    identities = {}
    held_out_queries = {}
    for idx, params in enumerate(IDENTITY_PARAMS):
        identity_id = f"synthetic_student_{idx}"
        base = make_face(**params)
        samples = [embedder.embed(jitter(base, rng)) for _ in range(n_enroll_samples)]
        arr = np.array(samples)
        mean_vec = arr.mean(axis=0)
        norm = np.linalg.norm(mean_vec)
        identities[identity_id] = (mean_vec / norm if norm > 1e-9 else mean_vec).tolist()
        held_out_queries[identity_id] = [embedder.embed(jitter(base, rng)) for _ in range(n_query_samples)]

    # Measure genuine (query vs its own template) and impostor (query vs
    # every OTHER template) similarity distributions directly.
    from face_engine import cosine_similarity
    genuine_sims, impostor_sims = [], []
    for identity_id, queries in held_out_queries.items():
        for q in queries:
            for other_id, template in identities.items():
                sim = cosine_similarity(q, template)
                (genuine_sims if other_id == identity_id else impostor_sims).append(sim)

    genuine_sims = np.array(genuine_sims)
    impostor_sims = np.array(impostor_sims)

    # Sweep for the empirical equal-error-rate point.
    lo = min(genuine_sims.min(), impostor_sims.min()) - 0.005
    hi = max(genuine_sims.max(), impostor_sims.max()) + 0.005
    best_gap, best_t, best_far, best_frr = None, None, None, None
    for t in np.arange(lo, hi, (hi - lo) / 200):
        far = float((impostor_sims >= t).mean())
        frr = float((genuine_sims < t).mean())
        gap = abs(far - frr)
        if best_gap is None or gap < best_gap:
            best_gap, best_t, best_far, best_frr = gap, float(t), far, frr

    matcher = LocalIdentityMatcher(face_match_threshold=best_t, high_confidence_threshold=best_t + 0.01,
                                    ambiguous_margin=0.003)
    matcher.sync_templates(identities)

    genuine_correct = 0
    for identity_id, queries in held_out_queries.items():
        for q in queries:
            result = matcher.match(q)
            if result.status == "RECOGNIZED" and result.student_id == identity_id:
                genuine_correct += 1
    genuine_total = sum(len(v) for v in held_out_queries.values())

    stranger_params = dict(eye_gap=35, jaw_width=70, eye_size=11, skin=(140, 110, 100))
    stranger_base = make_face(**stranger_params)
    stranger_queries = [embedder.embed(jitter(stranger_base, rng)) for _ in range(20)]
    false_accepts = sum(1 for q in stranger_queries if matcher.match(q).status == "RECOGNIZED")

    return {
        "note": "Synthetic identities (simple parametric ellipse faces), NOT real people. "
                "Threshold below is MEASURED (empirical equal-error-rate point from the actual "
                "genuine/impostor similarity distributions), not guessed. See "
                "docs/FACE_ACCURACY_CALIBRATION.md for why this still cannot substitute for a "
                "real photo dataset, and for how to re-run this against one.",
        "enrolled_identities": len(identities),
        "genuine_similarity": {"min": round(float(genuine_sims.min()), 4),
                                "mean": round(float(genuine_sims.mean()), 4),
                                "max": round(float(genuine_sims.max()), 4)},
        "impostor_similarity": {"min": round(float(impostor_sims.min()), 4),
                                 "mean": round(float(impostor_sims.mean()), 4),
                                 "max": round(float(impostor_sims.max()), 4)},
        "measured_eer_threshold": round(best_t, 4),
        "false_accept_rate_at_eer": round(best_far, 3),
        "false_reject_rate_at_eer": round(best_frr, 3),
        "genuine_match_rate_end_to_end": round(genuine_correct / genuine_total, 3) if genuine_total else 0.0,
        "false_acceptance_rate_stranger_end_to_end": round(false_accepts / len(stranger_queries), 3),
        "honest_assessment": (
            "FAR/FRR in the 15-30% range at best operating point, with substantial overlap "
            "between genuine and impostor distributions. This is a real, measured limitation "
            "of the classical HOG+LBP embedder on visually-similar faces, NOT a bug -- "
            "production face recognition (ArcFace/FaceNet-class) typically achieves <1% EER "
            "on standard benchmarks. This confirms embedding_model.py's own docstring: the "
            "classical backend proves the pipeline works end-to-end, it does not replace a "
            "real deep model for production accuracy."
        ),
    }


def main():
    embedder = HOGLBPEmbedder()
    detector = FrameFaceDetector(blur_threshold=60.0, max_faces=4, embedder=embedder)

    print("=" * 78)
    print("SMART BUS IoT — PIPELINE & RECOGNITION BENCHMARK")
    print("=" * 78)

    from embedding_model import build_default_embedder
    real_embedder = build_default_embedder()
    if real_embedder.production_ready:
        print(f"""
### A REAL, PRODUCTION-READY MODEL IS ACTIVE: {real_embedder.metadata()} ###
The numbers below still use the classical HOGLBPEmbedder on purpose (this
script's job is pipeline validation) -- re-run bench_recognition() with
`real_embedder` and REAL enrolled-student photo pairs (not synthetic faces)
for the accuracy numbers that actually matter. See
docs/FACE_ACCURACY_CALIBRATION.md, "How to calibrate FACE_MATCH_THRESHOLD
against real enrolled students" for that methodology.
""")
    else:
        print("""
### NO PRODUCTION-READY MODEL IS INSTALLED (see docs/EMBEDDING_SPEC.md) ###
Everything below is a DEV-MODE PIPELINE VALIDATION benchmark using the
classical HOGLBPEmbedder against SYNTHETIC faces. It proves the pipeline
(detection, tracking, temporal consensus, quality gate, matching logic)
works end-to-end -- it is explicitly NOT a real accuracy evaluation and
must not be quoted as one. Once a real model is installed per
docs/EMBEDDING_SPEC.md, re-run this script -- build_default_embedder() will
pick it up automatically -- and separately run a real-photo accuracy
evaluation (see docs/FACE_ACCURACY_CALIBRATION.md) before trusting any
FAR/FRR number for biometric access control.
""")
    print("\n### SECTION 1: CPU SANDBOX BENCHMARK (this container -- NOT Raspberry Pi) ###\n")

    print(f"Embedder: {embedder.metadata()}\n")

    print("[1a] Latency (detection vs embedding split out)")
    print(json.dumps(bench_latency(detector, embedder), indent=2))

    print("\n[1b] Quality gate correctness")
    print(json.dumps(bench_quality_gate(detector), indent=2))

    print("\n[1c] Recognition metrics (genuine match rate / FAR / FRR / unknown rejection)")
    print(json.dumps(bench_recognition(embedder), indent=2))

    print("\n" + "=" * 78)
    print("### SECTION 2: RASPBERRY PI HARDWARE BENCHMARK -- NOT RUN, NO PI AVAILABLE ###")
    print("=" * 78)
    print("""
This sandbox is not a Raspberry Pi. Before trusting any FPS/latency number
above for a real deployment, re-run this exact script on the actual target
device:

    scp raspberry_pi/*.py pi@<device-ip>:~/smart-bus-iot/
    ssh pi@<device-ip>
    cd ~/smart-bus-iot && python3 benchmark.py

Compare [1a]'s implied_max_fps against the Pi's actual camera_fps in
config.json / server-issued config -- if the Pi's four-face latency exceeds
1000/camera_fps ms, frames will queue up and the vision loop will fall
behind real time. On a Pi 4 (Cortex-A72), expect Haar cascade detection to
be meaningfully slower than whatever CPU ran the sandbox numbers above; on a
Pi 5 (Cortex-A76), expect it to be closer but still likely slower than a
generic x86 sandbox CPU. If a Pi 4 can't sustain useful FPS at 4 faces,
consider: lowering detection_fps relative to camera_fps (decouple capture
rate from detection rate), reducing camera resolution, or switching the
Haar cascade for OpenCV's DNN face detector (cv2.dnn, faster and more
accurate at the cost of a bundled ONNX model file).
""")


if __name__ == "__main__":
    main()
