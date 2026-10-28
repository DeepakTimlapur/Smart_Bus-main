# Four-Face Simultaneous Processing

## Where this lives

- **On the edge (Pi)**: `face_engine.FrameFaceDetector.process()` caps
  detections at `max_faces` (server-configurable, default 4) per frame, and
  `face_engine.MultiFaceTracker` maintains one independent `Track` per
  detected face, keyed by a generated `track_id` (`track_<8 hex chars>`).
- **In the browser demo path**: `lib/face-recognition.ts` independently
  implements the same idea for the driver-facing web dashboard
  (`maxFaces = 4` detector, `TemporalFaceTracker`), used by
  `DriverFaceRecognition.tsx`'s "simulate 4 faces" button. These are two
  separate implementations of the same concept (edge vs. browser), not
  shared code — worth unifying later if the on-device path matures.
- **Server-side**: `entry-events` / `exit-events` accept a `faces` array and
  process each independently in `lib/server-db.ts`, each against its own
  `idempotency_key` (`trip_id + student_id`), so four faces in one request
  can resolve to four different outcomes (boarded / already-boarded /
  fee-invalid / unknown) without one face's outcome affecting another's.

## How independence is achieved on the Pi

1. **Per-frame detection is independent per bounding box.** Each entry in
   `FrameFaceDetector.process()`'s return list carries its own `bbox`,
   `quality`, `liveness`, and `embedding` computed only from that face's
   cropped pixels. Embedding extraction itself is **batched** — all faces
   detected in a frame are passed to `embedder.embed_batch()` in a single
   call (see `embedding_model.py`), not one call per face. For the real
   ONNX model this means one `session.run()` call processes a
   `[4, 3, 112, 112]` input tensor and returns a `[4, 512]` output tensor in
   one shot — `ONNXFaceEmbedder.embed_batch`'s four-face path is covered by
   `embedding_model.py --self-test`'s "four-face batch inference works"
   check (verified against a mocked model with the real documented I/O
   shapes — see `docs/EMBEDDING_SPEC.md`). Batching doesn't change
   correctness (each output row still corresponds 1:1 to its input crop, in
   order) but avoids repeated per-call overhead, which matters more for the
   real deep model than it did for the near-free classical fallback.
2. **Track association is IoU-based, not order-based.** `MultiFaceTracker
   ._match_track()` matches each new detection to the *existing* track whose
   bounding box overlaps most (above `iou_match_threshold`), not to "whichever
   track was created first." This is what keeps a `track_id` stable as two
   people shift position in frame, and prevents detection order from
   scrambling identities.
3. **State is stored per-`Track` dataclass instance**, in a `self.tracks: Dict[str, Track]`
   keyed by `track_id` — there is no shared mutable state between tracks
   other than the dict they live in.
4. **Consensus and submission are evaluated per track, per frame**, inside
   the same loop iteration but writing only to that track's own
   `consecutive_acceptable` / `submitted` fields.

## Verified behavior (actually run in this pass, not asserted from memory)

The following was executed against the real `face_engine.py` in this
container (`python3`, no mocks) — see the session's tool history for the
literal commands:

```
Two synthetic faces at (50,50) and (400,50), 7 consecutive frames, both
"acceptable quality + live":
  distinct track_ids across all frames: 2   (expected 2 — stable identity)
  Face A reached temporal consensus and submitted: True
  Face B reached temporal consensus and submitted: True

Frame 8, same two faces again:
  Re-submitted while still locked (should be False): False   [confirmed]

Cross-talk check — for every (track, detection) pair returned, the track's
bbox x-position was checked against which embedding value it carried:
  No cross-talk between the two tracks: PASSED

Separate run — a single low-quality face for 10 consecutive frames:
  Low-quality face ever submitted (should be False): False   [confirmed]

Separate run — a track with no further detections, 0.3s past a 0.2s
track_expiry_sec:
  Active tracks after expiry window (should be 0): 0   [confirmed]
```

This confirms, for the code as it stands:

- Two simultaneous faces get and keep **distinct, stable track IDs**.
- Each track reaches temporal consensus **independently** and submits
  **exactly once** while locked, not once per frame.
- Track state does **not** leak between simultaneously-tracked faces.
- A track that never clears the quality gate **never** reaches consensus.
- Stale tracks are **reclaimed** after `track_expiry_sec`.

## What was not verified

- **Four real, simultaneous human faces from a physical camera.** The above
  used synthetic bounding boxes and embeddings (no camera hardware, no human
  test subjects available in this environment). The Haar-cascade detector's
  real-world behavior at 4 close-together real faces (partial occlusion,
  overlapping bounding boxes, non-frontal poses) is untested here — Haar
  cascades are known to be less robust than DNN-based detectors (e.g.
  YuNet/RetinaFace) for exactly this scenario, so validate this on real
  hardware with real people before relying on it operationally.
- **Throughput/latency at 4 faces on actual Raspberry Pi hardware.** No Pi
  was available in this environment; only the algorithmic correctness was
  tested, not performance. See `FACE_ACCURACY_CALIBRATION.md` for the
  benchmark script to run on real hardware.
- **The end-to-end four-face scenario through the live Next.js API** (i.e.
  posting a 4-face `entry-events` payload against a running MongoDB-backed
  server) — this exists as `scripts/biometric-runtime-test.ts` (TEST 4:
  "MULTIPLE FACES (4 Simultaneous Candidates)") but requires `npm install`
  and a reachable MongoDB, neither available in this sandbox. Run it with
  `npx tsx scripts/biometric-runtime-test.ts` (or the project's configured
  script runner) once you have network/DB access.
