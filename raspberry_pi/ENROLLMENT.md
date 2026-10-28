# Smart Bus — Real Face Enrollment

## 1. What enrollment does
`enroll_face.py` registers a student's face by capturing several webcam samples, turning each into a real
ArcFace 512-D embedding with the **same model, crop and preprocessing the bus uses for verification**,
averaging them into one template, validating it, and persisting it with metadata.

```
Camera -> Haar face detection -> face crop -> embedding_model.ONNXFaceEmbedder (w600k_mbf)
       -> 512-D, L2 -> N accepted samples -> normalized mean -> L2 -> validated template -> store
```

It reuses `face_engine.FrameFaceDetector` (the detector/cropper used by `main.py` and `webcam_test.py`) and
`embedding_model.ONNXFaceEmbedder`, so no preprocessing is duplicated. It builds `ONNXFaceEmbedder` directly and
**refuses to run** if the real model is not active/production-ready — it never uses the HOG+LBP fallback that
`build_default_embedder()` would silently pick. No browser-, hash- or seed-generated embeddings are involved.

## 2. How to run
From the repo root (venv active):

```
python raspberry_pi/enroll_face.py --student-id student1
python raspberry_pi/enroll_face.py --student-id student1 --force            # replace existing
python raspberry_pi/enroll_face.py --student-id student1 --camera 1 --samples 12
python raspberry_pi/enroll_face.py --self-test                              # no webcam, no model
```

Options: `--student-id`, `--camera` (default 0), `--samples` (default 10, min 3), `--force`, `--output`,
`--storage local|server`, `--server`, `--username`, `--model-path`, `--min-face-px`, `--min-interval`,
`--max-sample-similarity`, `--min-consistency`, `--timeout`. Press `q` in the window to cancel (nothing is stored).

## 3–7. Model, dimension, version, preprocessing, normalization
All values come from `embedding_spec.py` (mirror of `docs/EMBEDDING_SPEC.md` / `lib/embedding-spec.ts`):

| Field | Value |
|---|---|
| model file | `raspberry_pi/models/face_embedding.onnx` (= `w600k_mbf.onnx`) |
| model_name / model_version | `w600k_mbf` / `arcface-w600k_mbf-v1` |
| dimension | 512 |
| preprocessing | 112×112 RGB, NCHW float32 |
| alignment_version | `none-v1` (Haar bounding-box crop, no landmark alignment) |
| normalization | L2 (every sample and the final template have ‖v‖ = 1) |

Anything that is not exactly this (128-D legacy vectors, NaN/Inf, un-normalized, wrong model_version) is
**rejected, never converted**.

## 8. Sample collection
Per frame the tool requires exactly one face of acceptable quality:

| Situation | Message |
|---|---|
| no face | `NO FACE DETECTED` |
| 2+ faces | `MULTIPLE FACES` / `Please ensure only the student is visible.` |
| blurry, face smaller than `--min-face-px` (80), too dark/bright | `LOW QUALITY` / `Move closer / improve lighting.` |

An accepted frame becomes a sample (`Sample 3/10 captured`) only if its embedding is valid and it is
(a) ≥ `--min-interval` s (0.7) after the previous sample, (b) not a near-duplicate (cosine ≤ `--max-sample-similarity`,
0.98) of an accepted sample, so samples carry modest natural variation (small head movement, expression,
distance), and (c) consistent with the samples so far (cosine to their mean ≥ `--min-consistency`, 0.5), so a
second person stepping into view is not blended in. These thresholds are **uncalibrated safety heuristics, not accuracy
figures**; tune them with the flags if your camera needs it. Enrollment aborts, storing nothing, after `--timeout` (120 s).

Finish: validate every embedding → normalized mean → L2 → check 512-D/finite → self-verify (cosine of template vs each
sample: min / mean / max). If the minimum falls below `--min-consistency`, "Template valid: NO" and nothing is stored.
No accuracy percentage is computed or claimed.

## 9. Storage format

### Development store (`--storage local`, default) — NOT MongoDB
Default `raspberry_pi/enrollments/local_templates.json`:
* **`local_templates.json`** — flat `{ "student1": [512 floats] }`. This is exactly what `LocalIdentityMatcher.sync_templates()`
  expects, and what `webcam_test.py --templates` and `config.json → local_templates_path` already load. No second format.
* **`local_templates.records.json`** — sidecar with full records (kept in sync, checked on every load):

```json
{ "schema": "smartbus-enrollment-records-v1",
  "records": { "student1": {
    "student_id": "student1", "embedding": [512 floats],
    "embedding_dimension": 512, "model_name": "w600k_mbf", "model_family": "...",
    "model_version": "arcface-w600k_mbf-v1", "normalization": "l2",
    "preprocessing_version": "...", "alignment_version": "none-v1",
    "enrolled_at": "2026-10-03T12:00:00+00:00", "sample_count": 10,
    "sample_embeddings": [10 x 512 floats], "self_verification": {"min":..,"mean":..,"max":..} } } }
```
Writes are atomic. A flat file containing entries this tool did not create (e.g. hand-made or legacy 128-D) is refused, not overwritten.

### Production store (`--storage server`) — Next.js → MongoDB
Posts to `POST /api/v1/smart-bus/face/register`, which writes the **existing** `students` fields — no new collection:
`face_embedding` (the 512-D template), `face_embeddings` (the individual samples), `face_embedding_metadata`
(`model_name, model_family, model_version, embedding_dimension, preprocessing_version, alignment_version,
embedding_normalization, production_ready`), `face_sample_count`, `face_registered`, `face_registered_at`,
`face_enrollment_status = "OK"`. The server independently re-validates every vector (512-D, finite, unit norm) and the full
metadata. If the server is unreachable nothing is stored and there is **no silent fallback** to local storage.

```
set SMARTBUS_ENROLL_PASSWORD=...        (or you will be prompted; the password is never a CLI argument)
python raspberry_pi/enroll_face.py --student-id 3BR23CD016 --storage server --server http://localhost:3000 --username admin
```
Use an **ADMIN** login to enroll any student. A STUDENT login can only enroll its own ID (the tool refuses a mismatch).
Without `MONGODB_URI` the Next.js server itself falls back to its local JSON store (`data/transit_db.json`) — that is the web
app's existing behaviour, not MongoDB.

## 10. Duplicate enrollment
An already-enrolled student is never silently overwritten: the tool prints `Student already enrolled.` and exits before opening
the camera. Replace with `--force`. On the server, `--force` is honoured **only for ADMIN logins**. A legacy / non-compliant
enrollment (old 128-D or wrong model_version) does not count as enrolled and can be re-enrolled directly.

## 11. How verification consumes the template
`LocalIdentityMatcher` computes cosine similarity between the live 512-D embedding and each template, applying its
threshold and margin (`face_match_threshold`, `margin` in `config.json`). Pi: point `local_templates_path` in `config.json` (or
`webcam_test.py --templates`) at the flat file. Server: `serverDb` matches against `face_embedding` and `face_embeddings`.

## 12. Replacing an enrollment
`python raspberry_pi/enroll_face.py --student-id student1 --force` (add `--storage server` with an ADMIN login for MongoDB).

## 13. Security / quality notes
* Enrollment is the trust anchor: run it supervised, one person in frame. Anyone enrolled under another ID will be accepted as that ID.
* There is **no liveness check** during enrollment; a photo held to the camera would enroll. Do it attended.
* `alignment_version = none-v1` (bounding-box crop, no landmark alignment) means pose/lighting at enrollment matter; enroll in
  conditions similar to the bus doorway.
* Match thresholds and the sample-selection thresholds above are not calibrated on real data (see `calibrate_threshold.py`).
* Templates are biometric data: protect `enrollments/` and the database; the dev folder should not be committed.
* Known harmless ONNX Runtime warning: `Expected shape from model of {1,512} does not match actual shape of {N,512}`. The model's
  output metadata hard-codes batch=1 though the input batch is dynamic; batch outputs were verified identical to one-by-one
  inference (max difference 0.0 for N = 2, 3, 4). The enrollment tool silences ORT warnings in its own process only; the model is unchanged.
