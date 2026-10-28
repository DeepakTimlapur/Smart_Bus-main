# Local Webcam Testing (Windows / Mac / Linux dev machine)

Test the real model against your own face, live, on your laptop — before
ever deploying to a Raspberry Pi.

## Setup

```bash
cd raspberry_pi
pip install opencv-python onnxruntime --break-system-packages
```

**Important:** `opencv-python`, not `opencv-python-headless` (which is what
`requirements.txt` lists for the Pi — a Pi has no display, so it doesn't
need `cv2.imshow`). If you `pip install -r requirements.txt` as-is for this
test, swap `opencv-python-headless` for `opencv-python` first, or install
both and let pip resolve to whichever loads last — headless and the GUI
build can conflict if both are importable, so cleanest is to uninstall
headless on your dev machine before installing the GUI version:
```bash
pip uninstall opencv-python-headless -y
pip install opencv-python
```

Place the real model at `raspberry_pi/models/face_embedding.onnx` (see
`docs/EMBEDDING_SPEC.md` for exact download steps).

## Single/multi-face live test

```bash
python3 webcam_test.py
```
Opens webcam index 0, detects up to 4 simultaneous faces, and overlays live
status per face:
```
Track abcdef
Student: ...
Similarity: ...
Quality: GOOD
Liveness: LIVE
State: VERIFYING
```
Once a track reaches temporal consensus (5 consecutive acceptable+live
frames by default), the panel updates to one of:
- **ACCESS APPROVED** (green) — recognized with a name and similarity score
- **ACCESS DENIED / UNKNOWN FACE** (red) — no enrolled template matched
- **ACCESS DENIED / LOW QUALITY** (orange) — never cleared the quality gate
- **ACCESS DENIED / AMBIGUOUS IDENTITY** (magenta) — two candidates too
  close to call

Press `q` to quit.

## Testing against real enrolled students

By default, no templates are loaded, so everything reports `UNKNOWN`
(correct — there's nothing to match against). To test real matching:

1. Export enrolled students' embeddings to a JSON file:
   `{"3BR23EC045": [512 floats], "3BR23ME012": [512 floats], ...}`
   (a small export script against your MongoDB `students` collection,
   filtering to `face_embedding_metadata.model_version` matching the
   current spec, is the natural way to produce this — not included here,
   since it depends on your MongoDB connection details.)
2. `python3 webcam_test.py --templates my_templates.json`

**Calibrate the threshold first** (`calibrate_threshold.py`, see
`docs/FACE_ACCURACY_CALIBRATION.md`) — `webcam_test.py` uses a placeholder
`face_match_threshold=0.5` until you do. That placeholder is explicitly
not a calibrated value; the script's own code comment says so.

## Options

| Flag | Meaning |
|---|---|
| `--camera N` | Webcam device index (default 0) |
| `--max-faces N` | Max simultaneous faces to track (default 4) |
| `--model-path PATH` | Override the model file location |
| `--templates FILE.json` | Enable identity matching against these templates |
| `--no-display` | Console output only, no GUI window (useful for a quick headless sanity check over SSH, or CI) |

## What was and wasn't verified in the sandbox that built this

- The pure per-face display-state logic (`compute_display_state` in
  `webcam_test.py`) is unit-tested against synthetic `Track`/`MatchResult`
  objects covering all 6 display states (LOW_QUALITY, model-not-installed,
  VERIFYING, ACCESS_APPROVED, UNKNOWN_FACE, AMBIGUOUS_IDENTITY) — these
  pass.
- The full loop (detector → tracker → matcher → display) was run end-to-end
  against a simulated camera backend (no real webcam available in that
  sandbox) and completes without error, correctly reporting
  `PENDING_MODEL_NOT_INSTALLED` since no model file was present there.
- **Never run against an actual webcam, an actual human face, or the real
  model weights** — do that yourself, which is exactly what this doc and
  script are for.
