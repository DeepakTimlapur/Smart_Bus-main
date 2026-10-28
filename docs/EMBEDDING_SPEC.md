# Embedding Specification (canonical — single source of truth)

This is THE specification. Every place that produces or consumes a face
embedding — the Pi (`raspberry_pi/embedding_spec.py`), the Next.js backend
(`lib/embedding-spec.ts`), enrollment, and recognition — must match every
field below exactly, or embeddings from different places are not comparable
(this is the mismatch the previous architecture had, and the reason this
doc exists). If you change any field here, you MUST bump `MODEL_VERSION`
and re-enroll everyone (see "Migration" below) — never silently reinterpret
old embeddings under a new spec.

## Chosen model

| Field | Value |
|---|---|
| Model family | ArcFace (InsightFace) |
| Specific model | `w600k_mbf.onnx` — the recognition component of InsightFace's `buffalo_sc` pack (MobileFaceNet architecture) |
| Why this one, not `buffalo_l`'s `w600k_r50.onnx` | Same embedding space requirement (item 3) means ONE model runs everywhere, including the Raspberry Pi. `w600k_mbf.onnx` is ~13MB and built for CPU/mobile inference; `w600k_r50.onnx` (ResNet50, ~166MB) is more accurate but too heavy to be the Pi's real-time recognition model. Rather than run two different models in two places (which would reintroduce an embedding-space mismatch), this spec picks the one model that works acceptably everywhere. |
| Embedding dimension | 512 |
| Input size | 112×112 |
| Input color order | RGB (not BGR — convert if your pipeline reads images as BGR, e.g. OpenCV's default) |
| Input normalization | `(pixel - 127.5) / 128.0`, per channel, float32 |
| Input tensor layout | `NCHW` (batch, channel, height, width) |
| Output normalization | L2-normalize the raw model output to unit length |
| Similarity metric | Cosine similarity |
| `MODEL_VERSION` string | `"arcface-w600k_mbf-v1"` — bump this (`-v2`, etc.) if you ever change the model file, preprocessing, or alignment method |
| `PREPROCESSING_VERSION` | `"1.0"` |
| `ALIGNMENT_VERSION` | `"none-v1"` — see "Alignment" below, this is the honest current state, not a placeholder name for something more sophisticated |

## Confirmed model I/O (reported externally, not independently verified here)

Once you have the real `w600k_mbf.onnx` file in place, running
`python3 embedding_model.py --self-test` prints the actual input/output
tensor names and shapes it finds and validates them against the table
above. Expected (reported from an external ONNX inspection, not run in the
sandbox that wrote this doc — no model file was present there to check):

| | Name | Shape | Type |
|---|---|---|---|
| Input | `input.1` | `[None, 3, 112, 112]` | `float32` |
| Output | `516` | `[1, 512]` | `float32` |

Tensor *names* (`input.1`, `516`) are not hardcoded anywhere in
`embedding_model.py` or `lib/face-embedding-server.ts` — both look up
`session.get_inputs()[0]` / `get_outputs()[0]` positionally, so a
differently-named-but-same-shaped model still works. The *shapes* are what
matters and what `--self-test` actually validates, failing clearly (not
silently) if they don't match.

## Alignment — the one piece NOT yet implemented to the real spec

Proper ArcFace preprocessing includes 5-point facial landmark alignment
(eyes, nose, mouth corners) before the 112×112 crop, using a similarity
transform so the eyes land at fixed reference coordinates. **This spec's
current implementation does NOT do that** — both `embedding_model.py`'s
`ONNXFaceEmbedder` and the planned Node adapter (`lib/face-embedding-
server.ts`) crop the raw detector bounding box and resize it directly,
with no landmark-based alignment. This will measurably hurt accuracy
(faces at an angle, or with the detector's box not perfectly centered,
will embed less consistently than properly-aligned faces) but does not
block getting a real model running end-to-end. `ALIGNMENT_VERSION:
"none-v1"` documents this honestly rather than implying alignment exists.
Adding real alignment is a scoped follow-up: it needs a landmark detector
(e.g. InsightFace's own `2d106det.onnx`, which ships in the same
`buffalo_sc` pack) feeding a similarity-transform crop before the
recognition model — noted here so it isn't silently forgotten.

## Exact file placement

Both the Pi and the Node backend load their own local copy of the **same**
file:

```
raspberry_pi/models/face_embedding.onnx     <- Pi (Python, onnxruntime)
models/face_embedding.onnx                  <- Next.js backend (Node, onnxruntime-node)
```

Both paths are configurable (`config.json`'s `embedding_model_path` on the
Pi; `FACE_MODEL_PATH` env var on the backend) but default to the paths
above. **They must be the literal same file (same bytes)** — copy, don't
re-download separately, to guarantee they're identical.

## How to obtain the model file (network required — not available in this sandbox)

This sandbox has no network access (confirmed: GitHub and Hugging Face both
return `403 host_not_allowed` here), so the actual `.onnx` weights could
not be downloaded as part of this work. Run these steps yourself, on a
machine with network access:

**Recommended — via the `insightface` Python package (self-updating, most robust to link rot):**
```bash
pip install insightface onnxruntime --break-system-packages
python3 -c "
from insightface.app import FaceAnalysis
app = FaceAnalysis(name='buffalo_sc')
app.prepare(ctx_id=-1)
"
```
This downloads the `buffalo_sc` pack to `~/.insightface/models/buffalo_sc/`
(on Linux/Mac) or `%USERPROFILE%\.insightface\models\buffalo_sc\` (Windows).
Inside that folder, find `w600k_mbf.onnx` and copy it to both paths above:
```bash
cp ~/.insightface/models/buffalo_sc/w600k_mbf.onnx raspberry_pi/models/face_embedding.onnx
cp ~/.insightface/models/buffalo_sc/w600k_mbf.onnx models/face_embedding.onnx
```

**Fallback — manual download:** if the above auto-download ever breaks (link
rot, package changes), the model is published under InsightFace's model
zoo (github.com/deepinsight/insightface, `model_zoo` / `python-package`
docs). I could not verify a specific, current direct-download URL from this
sandbox (no network to check it's still live) — search the InsightFace
repo's releases or model zoo page for the current `buffalo_sc` package link
rather than trusting a URL guessed here.

## What happens until the file is present

`embedding_model.ONNXFaceEmbedder` (Python) and `lib/face-embedding-
server.ts` (Node, once added) both check for the file at startup / first
use. Neither pretends a model is loaded when it isn't:
- Python: `ONNXFaceEmbedder.is_active` is `False`, `build_default_embedder()`
  falls back to `HOGLBPEmbedder` with a loud warning log (see
  `FACE_RECOGNITION.md` for why that fallback is explicitly NOT treated as
  production-grade by the matching logic).
- Node: the enrollment endpoint returns a clear "face recognition model is
  not yet installed" error (HTTP 503) rather than silently enrolling a fake
  embedding.

## Verifying an installed model

Once `raspberry_pi/models/face_embedding.onnx` exists:
```bash
cd raspberry_pi
python3 embedding_model.py --info        # prints model name/version/I-O/status
python3 embedding_model.py --self-test   # runs the full checklist: file exists,
                                          # ORT loads it, shapes match, inference
                                          # runs, embedding is 512-D float32 with
                                          # no NaN/Inf, L2 norm ~= 1.0, same image
                                          # -> stable embedding, 4-face batch works
python3 webcam_test.py                   # live test against your own face
python3 calibrate_threshold.py --data-dir <photos>  # real FAR/FRR/EER from real photos
```
See `docs/LOCAL_WEBCAM_TESTING.md` and `docs/FACE_ACCURACY_CALIBRATION.md`
for the latter two.

## Migration

Any embedding not carrying `model_version: "arcface-w600k_mbf-v1"` metadata
(all currently-enrolled students, whose embeddings came from the old
seeded-random `generateCanonicalFaceEmbedding` — see `FACE_RECOGNITION.md`)
is treated as **not enrolled for matching purposes** once this spec is
live — never blended with or compared against real embeddings. See
`FACE_RECOGNITION.md`'s "Migration" section for exactly how this is
enforced in `lib/server-db.ts`.
