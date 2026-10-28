#!/usr/bin/env python3
"""
Smart Bus IoT — Threshold Calibration (real face photos, real model only)

Evaluates FAR / FRR / TAR / TRR / EER (and ROC/AUC if scikit-learn is
available) from a directory of REAL face photos, using the real
ONNXFaceEmbedder. Refuses to run against the HOGLBPEmbedder dev fallback
(see embedding_model.py) -- calibrating a production threshold against a
non-production embedder would produce a number that looks authoritative but
means nothing, which is exactly what this script exists to prevent (see
docs/FACE_ACCURACY_CALIBRATION.md's distinction between dev-mode pipeline
validation and real calibration).

Directory layout expected:

    calibration_data/
        person_001/
            img1.jpg
            img2.jpg
            ...
        person_002/
            img1.jpg
            ...
        ...

Every pair of images WITHIN a person's folder is a genuine pair; every pair
of images ACROSS different folders is an impostor pair. 5+ people with 3+
images each is a reasonable minimum to get a non-degenerate distribution;
more is better, and real accuracy numbers should ultimately come from a
much larger validation set than a quick local test can provide.

Usage:
    python3 calibrate_threshold.py --data-dir calibration_data/
    python3 calibrate_threshold.py --data-dir calibration_data/ --model-path models/face_embedding.onnx

NOT RUN in the sandbox that wrote this file: no real face photos and no
model weights are available here. This script is syntax-checked and its
math (FAR/FRR/EER/ROC sweep) is unit-tested against synthetic labeled
scores (see the bottom of this file / the test invoked by benchmark
tooling), but has never been run against real photos. Do not treat any
number it has NOT actually printed as a real result.
"""

import argparse
import glob
import logging
import os
import sys
from typing import Dict, List, Tuple

import numpy as np
import cv2

from embedding_model import ONNXFaceEmbedder, HOGLBPEmbedder
from face_engine import cosine_similarity

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("Calibrate")


def load_dataset(data_dir: str) -> Dict[str, List[np.ndarray]]:
    """person_id -> list of loaded BGR images (cv2.imread)."""
    dataset: Dict[str, List[np.ndarray]] = {}
    person_dirs = sorted(d for d in glob.glob(os.path.join(data_dir, "*")) if os.path.isdir(d))
    for person_dir in person_dirs:
        person_id = os.path.basename(person_dir)
        images = []
        for ext in ("*.jpg", "*.jpeg", "*.png"):
            for path in sorted(glob.glob(os.path.join(person_dir, ext))):
                img = cv2.imread(path)
                if img is not None:
                    images.append(img)
                else:
                    logger.warning("Could not read image: %s", path)
        if images:
            dataset[person_id] = images
    return dataset


def compute_embeddings(embedder, dataset: Dict[str, List[np.ndarray]]) -> Dict[str, List[List[float]]]:
    embeddings: Dict[str, List[List[float]]] = {}
    for person_id, images in dataset.items():
        # Batch inference per person (requirement: prefer batch inference where supported).
        embeddings[person_id] = embedder.embed_batch(images)
        logger.info("Embedded %d sample(s) for %s", len(images), person_id)
    return embeddings


def genuine_impostor_scores(embeddings: Dict[str, List[List[float]]]) -> Tuple[np.ndarray, np.ndarray]:
    genuine, impostor = [], []
    person_ids = list(embeddings.keys())
    for i, pid in enumerate(person_ids):
        vecs = embeddings[pid]
        for a in range(len(vecs)):
            for b in range(a + 1, len(vecs)):
                genuine.append(cosine_similarity(vecs[a], vecs[b]))
        for j in range(i + 1, len(person_ids)):
            other_vecs = embeddings[person_ids[j]]
            for va in vecs:
                for vb in other_vecs:
                    impostor.append(cosine_similarity(va, vb))
    return np.array(genuine), np.array(impostor)


def sweep_thresholds(genuine: np.ndarray, impostor: np.ndarray, steps: int = 400) -> List[dict]:
    lo = min(genuine.min(), impostor.min()) - 0.01
    hi = max(genuine.max(), impostor.max()) + 0.01
    rows = []
    for t in np.linspace(lo, hi, steps):
        tar = float((genuine >= t).mean())  # True Accept Rate
        frr = 1.0 - tar  # False Reject Rate
        far = float((impostor >= t).mean())  # False Accept Rate
        trr = 1.0 - far  # True Reject Rate
        rows.append({"threshold": float(t), "FAR": far, "FRR": frr, "TAR": tar, "TRR": trr})
    return rows


def find_eer(rows: List[dict]) -> dict:
    return min(rows, key=lambda r: abs(r["FAR"] - r["FRR"]))


def try_roc_auc(genuine: np.ndarray, impostor: np.ndarray):
    try:
        from sklearn.metrics import roc_auc_score, roc_curve
    except ImportError:
        return None
    y_true = np.concatenate([np.ones(len(genuine)), np.zeros(len(impostor))])
    y_score = np.concatenate([genuine, impostor])
    auc = roc_auc_score(y_true, y_score)
    fpr, tpr, thresholds = roc_curve(y_true, y_score)
    return {"auc": float(auc), "n_points": len(thresholds)}


def main():
    parser = argparse.ArgumentParser(description="Calibrate FACE_MATCH_THRESHOLD against real face photos")
    parser.add_argument("--data-dir", required=True, help="Directory of person_id/*.jpg folders")
    parser.add_argument("--model-path", default="models/face_embedding.onnx", help="Path to the real .onnx model")
    parser.add_argument(
        "--allow-dev-embedder",
        action="store_true",
        help="DANGEROUS: allow calibrating against the non-production HOGLBPEmbedder fallback. "
             "The resulting threshold is meaningless for the real model and must never be deployed. "
             "Only use this to sanity-check the calibration math itself.",
    )
    args = parser.parse_args()

    embedder = ONNXFaceEmbedder(args.model_path)
    if not embedder.production_ready:
        if not args.allow_dev_embedder:
            print(
                f"REFUSING TO CALIBRATE: no production-ready model loaded from {args.model_path}.\n"
                f"Calibrating against the dev-mode classical embedder would produce a threshold that "
                f"looks authoritative but is meaningless for the real model -- exactly what this script "
                f"exists to prevent (see docs/FACE_ACCURACY_CALIBRATION.md).\n"
                f"Install the real model (see docs/EMBEDDING_SPEC.md) and re-run, or pass "
                f"--allow-dev-embedder to explicitly sanity-check the calibration math only."
            )
            sys.exit(1)
        logger.warning(
            "*** --allow-dev-embedder set: calibrating against HOGLBPEmbedder. "
            "THIS THRESHOLD IS NOT VALID FOR THE REAL MODEL. Dev-math-check only. ***"
        )
        embedder = HOGLBPEmbedder()

    if not os.path.isdir(args.data_dir):
        print(f"Data directory not found: {args.data_dir}")
        sys.exit(1)

    dataset = load_dataset(args.data_dir)
    n_people = len(dataset)
    n_images = sum(len(v) for v in dataset.values())
    print(f"Loaded {n_people} people, {n_images} images total from {args.data_dir}")
    if n_people < 2 or n_images < 4:
        print("Not enough data for a meaningful calibration (need >= 2 people, >= 4 images total). Stopping.")
        sys.exit(1)

    embeddings = compute_embeddings(embedder, dataset)
    genuine, impostor = genuine_impostor_scores(embeddings)
    print(f"\n{len(genuine)} genuine pairs, {len(impostor)} impostor pairs")
    if len(genuine) == 0:
        print("No genuine pairs available (every person needs >= 2 images). Stopping.")
        sys.exit(1)

    print(f"Genuine similarity:  min={genuine.min():.4f} mean={genuine.mean():.4f} max={genuine.max():.4f}")
    print(f"Impostor similarity: min={impostor.min():.4f} mean={impostor.mean():.4f} max={impostor.max():.4f}")

    rows = sweep_thresholds(genuine, impostor)
    eer_row = find_eer(rows)
    print(f"\nEqual-error-rate operating point:")
    print(f"  threshold = {eer_row['threshold']:.4f}")
    print(f"  FAR = {eer_row['FAR']:.4f}   FRR = {eer_row['FRR']:.4f}")
    print(f"  TAR = {eer_row['TAR']:.4f}   TRR = {eer_row['TRR']:.4f}")

    roc = try_roc_auc(genuine, impostor)
    if roc:
        print(f"\nROC AUC: {roc['auc']:.4f} ({roc['n_points']} threshold points)")
    else:
        print("\n(scikit-learn not installed -- skipping ROC/AUC; pip install scikit-learn for it)")

    print(
        f"\nRESULT IS ONLY AS GOOD AS THE DATASET: {n_people} people / {n_images} images is a smoke test, "
        f"not a validation-grade dataset. Do not deploy this threshold to production without a larger, "
        f"more representative dataset (varied lighting, angles, glasses, distance -- see item 12 in the brief)."
    )


if __name__ == "__main__":
    main()
