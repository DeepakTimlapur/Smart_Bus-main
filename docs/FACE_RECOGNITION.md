# Face Recognition Pipeline

## The architecture, as it now stands

One shared specification (`docs/EMBEDDING_SPEC.md`) governs embedding
generation everywhere. Two implementations of that same spec exist — one
Python (`raspberry_pi/embedding_model.py`'s `ONNXFaceEmbedder`), one Node
(`lib/face-embedding-server.ts`) — loading the **same** `.onnx` model file,
with identical preprocessing, so a browser-enrolled embedding and a
Pi-recognized embedding are comparable by cosine similarity. Neither has
been run against real weights in this sandbox (no network access here —
see `docs/EMBEDDING_SPEC.md` for the exact install procedure), but both are
implemented to the full spec and both fail loudly (never silently fake an
embedding) when the model isn't installed.

```
ENROLLMENT (browser -> backend)              RECOGNITION (Raspberry Pi)
─────────────────────────────────             ──────────────────────────
Browser camera                                 Pi camera
  -> capture 3-5 JPEG frames                     -> capture frame
  -> POST /api/v1/faces/enroll-samples            -> face_engine.FrameFaceDetector:
  -> lib/face-embedding-server.ts                    detect, quality, liveness
       (Node, onnxruntime-node)                  -> embedding_model.ONNXFaceEmbedder:
       decode -> crop -> resize 112x112               SAME model, same preprocessing,
       -> (px-127.5)/128.0 -> NCHW                     BATCH inference across up to
       -> SAME .onnx model, BATCH inference              4 faces in one call
       -> L2-normalize -> 512-D                   -> face_engine.MultiFaceTracker:
  -> lib/server-db.ts registerFace():                 temporal consensus per track
       stores embedding + spec metadata          -> api_client.process_face_event:
       (model_version, dim, preprocessing_ver)        submit to server
       in MongoDB
                                                  lib/server-db.ts recognizeAndProcessFaces():
                                                    filter candidates to ONLY students
                                                    whose face_embedding_metadata.model_version
                                                    matches the current spec
                                                    -> cosine similarity match
                                                    -> business rule validation
                                                    -> entry/exit decision
```

Both paths funnel through the exact same model and preprocessing — this is
what makes the two sides' embeddings meaningfully comparable, which was not
true before this pass (see "What existed before" below).

## What existed before this pass (for context, not to repeat)

- **Enrollment** (`FaceRegistration.tsx`) called
  `generateCanonicalFaceEmbedding(studentId)` — a seeded pseudo-random
  128-D vector keyed by the student's ID string, not derived from any photo
  at all.
- **The live "recognition" demo** (`DriverFaceRecognition.tsx`) never
  processed real pixels either — it called the same seeded-random function
  with hardcoded student IDs to script canned scenarios (confirmed by
  searching the codebase: `extractEmbeddingFromBox`, the one function in
  `lib/face-recognition.ts` that *did* derive features from real pixels,
  was never called from anywhere).
- **The Pi**, before an earlier pass in this conversation, hashed raw pixel
  bytes (SHA-256) — not identity-preserving at all.
- **A middle pass** replaced the Pi's hash with classical HOG+LBP features
  — a real improvement (see "Two intermediate fixes" below) but explicitly
  not suitable for production biometric matching (~20% FAR/FRR at best
  operating point — see `docs/FACE_ACCURACY_CALIBRATION.md`), and still in
  a completely different embedding space from the browser's seeded-random
  enrollment vectors.

This pass replaces both sides with one real model. `generateCanonicalFaceEmbedding`
and the classical HOG+LBP embedder both still exist in the codebase (see
"What's still around, and why" below) but neither is in the production
enrollment or matching path anymore.

## Migration: legacy embeddings are excluded, never silently matched

Every currently-enrolled student (the 3 seed students in `lib/mongodb.ts`,
and anyone who enrolled through the old browser flow before this pass) has
a `face_embedding` from the old seeded-random generator. These are now:

1. Marked `face_enrollment_status: "FACE_REENROLLMENT_REQUIRED"` — done
   automatically for the seed data in this pass; for any other
   already-deployed instance, run the new ADMIN-only migration endpoint
   once: `POST /api/v1/smart-bus/faces/migrate-legacy` (see
   `lib/server-db.ts`'s `migrateEmbeddingsToReenrollmentRequired()` —
   idempotent, safe to run more than once).
2. **Excluded from the matching candidate pool entirely.**
   `recognizeAndProcessFaces()`'s `registeredStudents` filter now requires
   `face_embedding_metadata?.model_version === SPEC_MODEL_VERSION` — a
   legacy student is never compared against, never "upgraded" silently,
   never produces a false match. A face submitted from the Pi that would
   have matched a legacy student instead correctly returns `UNKNOWN`.
3. Required to re-enroll through the new `/api/v1/faces/enroll-samples`
   flow, which can only ever produce a spec-compliant embedding (the
   server computes it, not the client — see below).

**`registerFace()` structurally cannot store a fake embedding as valid
going forward**: it now requires `embedding_metadata.model_version` to
match the current spec, and rejects the call otherwise (see
`lib/server-db.ts`). The old low-level route
(`POST /api/v1/smart-bus/face/register`, which accepts a pre-computed
embedding from the client) is kept for API compatibility but now enforces
the same metadata check — a client can no longer get a fake embedding
accepted through it.

## What's still around, and why (not silently deleted, deliberately scoped)

- **`lib/face-recognition.ts`'s `generateCanonicalFaceEmbedding`**: still
  exists, still 128-D (the old, superseded dimension), now used ONLY by
  `DriverFaceRecognition.tsx`'s scenario simulator, which now carries a
  visible banner stating it's a demo, not real recognition. Deleting the
  function outright would have broken that component and the two test
  scripts below without a compiler available in this sandbox to catch
  mistakes — kept, clearly labeled, isolated from production paths instead.
- **`scripts/biometric-runtime-test.ts` / `scripts/iot-exit-lifecycle-test.ts`**:
  both rely on the same legacy seed embeddings and will now correctly get
  `UNKNOWN` results instead of their originally-expected `RECOGNIZED` —
  this is the migration gating working as intended, not a regression to
  fix quietly. Both files now carry a comment explaining this; updating
  their fixtures to use spec-compliant metadata is future work, not done
  in this pass.
- **`raspberry_pi/embedding_model.py`'s `HOGLBPEmbedder`**: kept as an
  explicitly non-production (`production_ready: False`) pipeline-validation
  fallback — lets the whole detection/tracking/consensus/offline-queue
  pipeline be exercised without needing model weights. `main.py` checks
  this flag before ever treating a local match as real (see
  `identity_matcher.py`'s usage in `main.py`'s vision loop).

## Real model: what it is, and what's not yet done

See `docs/EMBEDDING_SPEC.md` for the full specification. Summary: ArcFace
family, InsightFace's `buffalo_sc` pack's recognition component
(`w600k_mbf.onnx`, MobileFaceNet architecture — chosen specifically because
it's light enough to also run on a Pi, satisfying the "same model
everywhere" requirement), 512-D output, L2-normalized, cosine similarity.

**Not done, honestly stated:**
- **No landmark-based face alignment.** Both `ONNXFaceEmbedder`
  implementations crop the raw detector bounding box and resize — proper
  ArcFace preprocessing aligns on 5 facial landmarks first. This will
  measurably hurt accuracy on off-angle faces. See `docs/EMBEDDING_SPEC.md`,
  "Alignment," for the honest state and the scoped fix.
- **No real accuracy benchmark**, because no real model weights are
  installed in this sandbox (no network access here — confirmed:
  GitHub/Hugging Face both return `403`). `docs/FACE_ACCURACY_CALIBRATION.md`
  documents exactly what to run once weights are installed, and is explicit
  that the classical-embedder numbers already in that doc are a *pipeline*
  validation, not a stand-in for real accuracy.
- **No Raspberry Pi hardware benchmark** — no Pi available in this
  environment either.

## Four simultaneous faces, no cross-talk

Unchanged from the previous pass's implementation and re-verified after
this one: `face_engine.MultiFaceTracker` assigns each detection to a
persistent `track_id` via IoU matching, and each `Track` carries its own
`bbox`, `embedding`, `quality`, `liveness`, `candidate_identity`,
`similarity_score`, and `verification_state` — see
`docs/FOUR_FACE_PROCESSING.md` for the specific tests run. Embedding
extraction is batched: all faces detected in a frame go through
`embed_batch()` in one call (`ONNXFaceEmbedder.embed_batch` /
`embedFaceImagesBatch` on the Node side), not one call per face.

## Liveness / anti-spoofing

Unchanged from the previous pass: per-face frame-to-frame motion,
measured within each face's own crop against the previous frame's crop at
the same coordinates. See the git history / earlier revisions of this doc
for the two liveness bugs found and fixed in an earlier pass (whole-frame
dilution, and a score floored regardless of actual motion).

## Quality gate

Unchanged: `BLUR_VARIANCE_MIN` (Laplacian variance of the face crop) gates
`quality.isAcceptable` before a frame can contribute to temporal consensus.
