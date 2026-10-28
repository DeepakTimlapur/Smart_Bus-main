"use client"

import * as ort from "onnxruntime-web"

const MODEL_URL = "/models/face_embedding.onnx"
const INPUT_SIZE = 112
const EMBEDDING_DIMENSION = 512
const PREPROCESS_MEAN = 127.5
const PREPROCESS_STD = 128.0

let sessionPromise: Promise<ort.InferenceSession> | null = null

async function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["webgpu", "wasm"],
      graphOptimizationLevel: "all",
    })
  }

  return sessionPromise
}

function l2Normalize(values: Float32Array | number[]): number[] {
  let sumSq = 0

  for (const value of values) {
    sumSq += value * value
  }

  const norm = Math.sqrt(sumSq)

  if (!Number.isFinite(norm) || norm <= 0) {
    throw new Error("Invalid face embedding norm")
  }

  return Array.from(values, (value) => value / norm)
}

function canvasToTensor(
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
  box: {
    x: number
    y: number
    width: number
    height: number
  }
): ort.Tensor {
  const canvas = document.createElement("canvas")

  canvas.width = INPUT_SIZE
  canvas.height = INPUT_SIZE

  const ctx = canvas.getContext("2d", {
    willReadFrequently: true,
  })

  if (!ctx) {
    throw new Error("Unable to create face preprocessing canvas")
  }

  ctx.drawImage(
    source,
    box.x,
    box.y,
    box.width,
    box.height,
    0,
    0,
    INPUT_SIZE,
    INPUT_SIZE
  )

  const image = ctx.getImageData(
    0,
    0,
    INPUT_SIZE,
    INPUT_SIZE
  )

  const chw = new Float32Array(
    3 * INPUT_SIZE * INPUT_SIZE
  )

  const planeSize = INPUT_SIZE * INPUT_SIZE

  for (let y = 0; y < INPUT_SIZE; y++) {
    for (let x = 0; x < INPUT_SIZE; x++) {
      const pixelIndex =
        (y * INPUT_SIZE + x) * 4

      const r = image.data[pixelIndex]
      const g = image.data[pixelIndex + 1]
      const b = image.data[pixelIndex + 2]

      const index =
        y * INPUT_SIZE + x

      chw[index] =
        (r - PREPROCESS_MEAN) /
        PREPROCESS_STD

      chw[planeSize + index] =
        (g - PREPROCESS_MEAN) /
        PREPROCESS_STD

      chw[2 * planeSize + index] =
        (b - PREPROCESS_MEAN) /
        PREPROCESS_STD
    }
  }

  return new ort.Tensor(
    "float32",
    chw,
    [1, 3, INPUT_SIZE, INPUT_SIZE]
  )
}

export async function embedFaceFromVideo(
  video: HTMLVideoElement,
  box: {
    x: number
    y: number
    width: number
    height: number
  }
): Promise<number[]> {
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error("Camera frame is not ready")
  }

  const session = await getSession()

  const input = canvasToTensor(
    video,
    box
  )

  const inputName =
    session.inputNames[0]

  const outputName =
    session.outputNames[0]

  const result = await session.run({
    [inputName]: input,
  })

  const output = result[outputName]

  if (!(output.data instanceof Float32Array)) {
    throw new Error(
      "Unexpected ONNX embedding output type"
    )
  }

  if (
    output.data.length !==
    EMBEDDING_DIMENSION
  ) {
    throw new Error(
      `Invalid production embedding dimension: ${output.data.length}; expected ${EMBEDDING_DIMENSION}`
    )
  }

  const embedding =
    l2Normalize(output.data)

  if (
    embedding.length !==
    EMBEDDING_DIMENSION
  ) {
    throw new Error(
      "Embedding dimension validation failed"
    )
  }

  if (
    embedding.some(
      (value) => !Number.isFinite(value)
    )
  ) {
    throw new Error(
      "Embedding contains NaN or Infinity"
    )
  }

  return embedding
}

export async function embedFacesFromVideo(
  video: HTMLVideoElement,
  faces: Array<{
    x: number
    y: number
    width: number
    height: number
  }>
): Promise<number[][]> {
  if (faces.length === 0) {
    return []
  }

  // One face is the normal bus-entry case.
  // Avoid Promise overhead for the common path.
  if (faces.length === 1) {
    return [
      await embedFaceFromVideo(
        video,
        faces[0]
      ),
    ]
  }

  // Process multiple faces sequentially to reduce concurrent GPU inference.
  const embeddings: number[][] = []

  for (const face of faces) {
    embeddings.push(await embedFaceFromVideo(video, face))
  }

  return embeddings
}


export async function preloadBrowserFaceModel(): Promise<void> {
  await getSession()
}
export function getBrowserFaceModelInfo() {
  return {
    model: "w600k_mbf",
    modelVersion: "arcface-w600k_mbf-v1",
    dimension: EMBEDDING_DIMENSION,
    inputSize: INPUT_SIZE,
    preprocessing: "(pixel-127.5)/128.0",
    colorOrder: "RGB",
    layout: "NCHW",
    alignment: "none-v1",
  }
}


