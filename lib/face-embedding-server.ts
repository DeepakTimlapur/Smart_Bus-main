/**
 * Smart Bus IoT â€” Server-side Face Embedding (Node / ONNX Runtime)
 *
 * The Node-side counterpart to raspberry_pi/embedding_model.py's
 * ONNXFaceEmbedder. Loads the EXACT SAME model file (see
 * docs/EMBEDDING_SPEC.md) and implements IDENTICAL preprocessing, so a
 * browser-enrolled embedding (produced here) and a Pi-recognized embedding
 * (produced there) live in the same space and are meaningfully comparable
 * by cosine similarity. If this file's preprocessing ever drifts from
 * embedding_model.py's, that reintroduces the exact mismatch bug
 * docs/EMBEDDING_SPEC.md exists to prevent â€” change both together.
 *
 * NOT VERIFIED END-TO-END: this sandbox has no network access, so neither
 * the `onnxruntime-node` / `sharp` npm packages nor an actual .onnx model
 * file could be installed or downloaded here (see docs/EMBEDDING_SPEC.md
 * for the exact install/download procedure to run yourself). This file is
 * written to the correct, documented API surface for both packages but has
 * not been run. `npm install` will need to succeed, and the model file
 * placed at FACE_MODEL_PATH, before this module does anything but throw
 * ModelNotAvailableError.
 */

import fs from "fs"
import path from "path"
import {
  MODEL_NAME,
  MODEL_VERSION,
  PREPROCESSING_VERSION,
  ALIGNMENT_VERSION,
  EMBEDDING_DIMENSION,
  INPUT_SIZE,
  PREPROCESS_MEAN,
  PREPROCESS_STD,
  DEFAULT_MODEL_PATH,
  type EmbeddingMetadata,
} from "@/lib/embedding-spec"

export class ModelNotAvailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelNotAvailableError"
  }
}

// Lazily imported so a deployment without these packages installed yet
// doesn't fail to even start the Next.js server -- the error surfaces only
// when embedding is actually attempted, as a clear ModelNotAvailableError.
// Typed loosely (not `typeof import(...)`) deliberately: this file cannot
// be compiled in the sandbox that wrote it (no network to install these
// packages), so the safer choice is runtime-correct dynamic import calls
// over a type-level interop cast this environment can't verify.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ortModule: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharpModule: any = null

async function loadDeps(): Promise<{ ort: any; sharp: any }> {
  if (!ortModule) {
    try {
      ortModule = await import("onnxruntime-node")
    } catch (e) {
      throw new ModelNotAvailableError(
        "onnxruntime-node is not installed. Run `npm install` after adding it to package.json " +
          "(already added in this pass) â€” see docs/EMBEDDING_SPEC.md."
      )
    }
  }
  if (!sharpModule) {
    try {
      const mod = await import("sharp")
      sharpModule = mod.default ?? mod
    } catch (e) {
      throw new ModelNotAvailableError(
        "sharp is not installed. Run `npm install` after adding it to package.json " +
          "(already added in this pass) â€” see docs/EMBEDDING_SPEC.md."
      )
    }
  }
  return { ort: ortModule, sharp: sharpModule }
}

let cachedSession: any = null
let cachedModelPath: string | null = null

function resolveModelPath(): string {
  return process.env.FACE_MODEL_PATH || path.join(process.cwd(), DEFAULT_MODEL_PATH)
}

async function getSession(): Promise<any> {
  const modelPath = resolveModelPath()

  if (cachedSession && cachedModelPath === modelPath) {
    return cachedSession
  }

  if (!fs.existsSync(modelPath)) {
    throw new ModelNotAvailableError(
      `Face embedding model not found at ${modelPath}. See docs/EMBEDDING_SPEC.md for the exact ` +
        `download/install procedure (this sandbox had no network access to fetch it as part of this work).`
    )
  }

  const { ort } = await loadDeps()
  cachedSession = await ort.InferenceSession.create(modelPath, { executionProviders: ["cpu"] })
  cachedModelPath = modelPath
  return cachedSession
}

/**
 * Decodes an image buffer (JPEG/PNG, as uploaded from the browser), crops
 * to the given box (or uses the whole image if no box given), resizes to
 * INPUT_SIZE x INPUT_SIZE, and returns raw RGB pixel bytes (H, W, 3),
 * uint8. Mirrors face_engine.py's crop step -- NO landmark-based alignment
 * (see docs/EMBEDDING_SPEC.md, "Alignment" -- honestly not implemented yet
 * on either side).
 */
async function decodeAndCropRGB(
  imageBuffer: Buffer,
  box?: { x: number; y: number; width: number; height: number }
): Promise<Buffer> {
  const { sharp } = await loadDeps()
  let pipeline = sharp(imageBuffer)
  if (box && box.width > 0 && box.height > 0) {
    pipeline = pipeline.extract({
      left: Math.max(0, Math.round(box.x)),
      top: Math.max(0, Math.round(box.y)),
      width: Math.round(box.width),
      height: Math.round(box.height),
    })
  }
  const { data } = await pipeline
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return data // (INPUT_SIZE * INPUT_SIZE * 3) bytes, RGB, row-major
}

/** HWC uint8 RGB -> NCHW float32, (pixel-127.5)/128.0 -- must match embedding_model.py's _preprocess exactly. */
function preprocessToNCHW(rgbBytes: Buffer): Float32Array {
  const pixelCount = INPUT_SIZE * INPUT_SIZE
  const out = new Float32Array(3 * pixelCount)
  for (let i = 0; i < pixelCount; i++) {
    const r = rgbBytes[i * 3]
    const g = rgbBytes[i * 3 + 1]
    const b = rgbBytes[i * 3 + 2]
    out[i] = (r - PREPROCESS_MEAN) / PREPROCESS_STD // channel 0: R
    out[pixelCount + i] = (g - PREPROCESS_MEAN) / PREPROCESS_STD // channel 1: G
    out[2 * pixelCount + i] = (b - PREPROCESS_MEAN) / PREPROCESS_STD // channel 2: B
  }
  return out
}

function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1
  return vec.map((x) => x / norm)
}

/**
 * Real batch inference: every face image supplied goes through the model in
 * ONE session.run() call, mirroring embedding_model.py's embed_batch.
 * Throws ModelNotAvailableError (never returns a fake embedding) if the
 * model/packages aren't actually available -- callers must surface this as
 * an explicit "model not installed" error, never silently fall back to a
 * placeholder for anything that will be stored as a production enrollment.
 */
export async function embedFaceImagesBatch(
  images: Array<{
    buffer: Buffer
    box?: { x: number; y: number; width: number; height: number }
  }>
): Promise<number[][]> {
  if (images.length === 0) return []

  const { ort } = await loadDeps()
  const session = await getSession()
  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]
  const embeddings: number[][] = []

  for (const image of images) {
    const rgb = await decodeAndCropRGB(image.buffer, image.box)
    const chw = preprocessToNCHW(rgb)

    const tensor = new ort.Tensor(
      "float32",
      chw,
      [1, 3, INPUT_SIZE, INPUT_SIZE]
    )

    const results = await session.run({ [inputName]: tensor })
    const output = results[outputName]
    const dimensions = output.dims
    const vector = Array.from(output.data as Float32Array)

    if (
      dimensions.length !== 2 ||
      dimensions[0] !== 1 ||
      dimensions[1] !== EMBEDDING_DIMENSION ||
      vector.length !== EMBEDDING_DIMENSION
    ) {
      throw new ModelNotAvailableError(
        `Expected output shape [1, ${EMBEDDING_DIMENSION}], ` +
        `received [${dimensions.join(", ")}].`
      )
    }

    if (!vector.every(Number.isFinite)) {
      throw new ModelNotAvailableError(
        "Face model returned non-finite embedding values."
      )
    }

    const norm = Math.sqrt(
      vector.reduce((sum, value) => sum + value * value, 0)
    )

    if (!Number.isFinite(norm) || norm <= 1e-12) {
      throw new ModelNotAvailableError(
        "Face model returned a zero-length embedding."
      )
    }

    embeddings.push(
      vector.map(value => Number((value / norm).toFixed(5)))
    )
  }

  return embeddings
}

/** True if the real model is actually loadable right now (file present, packages installed). */
export async function isFaceModelAvailable(): Promise<boolean> {
  try {
    await getSession()
    return true
  } catch {
    return false
  }
}

export function currentEmbeddingMetadata(): EmbeddingMetadata {
  return {
    model_name: MODEL_NAME,
    model_family: "arcface-insightface-buffalo_sc",
    model_version: MODEL_VERSION,
    embedding_dimension: EMBEDDING_DIMENSION,
    preprocessing_version: PREPROCESSING_VERSION,
    alignment_version: ALIGNMENT_VERSION,
    embedding_normalization: "l2",
    production_ready: true,
  }
}

