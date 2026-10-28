import fs from "node:fs"
import path from "node:path"
import sharp from "sharp"
import * as ort from "onnxruntime-node"

export interface ServerFaceBox {
  x: number
  y: number
  width: number
  height: number
}

const MODEL_PATH = path.join(
  process.cwd(),
  "raspberry_pi/models/scrfd_500m_bnkps_shape640x640.onnx"
)

const INPUT_SIZE = 640
const DET_THRESHOLD = 0.5
const NMS_THRESHOLD = 0.4
const STRIDES = [8, 16, 32] as const
const NUM_ANCHORS = 2

let sessionPromise: Promise<ort.InferenceSession> | null = null

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      if (!fs.existsSync(MODEL_PATH)) {
        throw new Error(`SCRFD model not found: ${MODEL_PATH}`)
      }

      return ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ["cpu"],
      })
    })()
  }

  return sessionPromise
}

function iou(a: ServerFaceBox, b: ServerFaceBox): number {
  const ax2 = a.x + a.width
  const ay2 = a.y + a.height
  const bx2 = b.x + b.width
  const by2 = b.y + b.height

  const ix1 = Math.max(a.x, b.x)
  const iy1 = Math.max(a.y, b.y)
  const ix2 = Math.min(ax2, bx2)
  const iy2 = Math.min(ay2, by2)

  const iw = Math.max(0, ix2 - ix1)
  const ih = Math.max(0, iy2 - iy1)
  const intersection = iw * ih

  const areaA = Math.max(0, a.width) * Math.max(0, a.height)
  const areaB = Math.max(0, b.width) * Math.max(0, b.height)

  const union = areaA + areaB - intersection

  return union > 0 ? intersection / union : 0
}

function nms(
  detections: Array<{ box: ServerFaceBox; score: number }>
): Array<{ box: ServerFaceBox; score: number }> {
  const sorted = [...detections].sort((a, b) => b.score - a.score)
  const kept: Array<{ box: ServerFaceBox; score: number }> = []

  for (const detection of sorted) {
    let suppressed = false

    for (const existing of kept) {
      if (iou(detection.box, existing.box) > NMS_THRESHOLD) {
        suppressed = true
        break
      }
    }

    if (!suppressed) {
      kept.push(detection)
    }
  }

  return kept
}

async function decodeImage(buffer: Buffer) {
  const metadata = await sharp(buffer).metadata()

  const originalWidth = metadata.width
  const originalHeight = metadata.height

  if (!originalWidth || !originalHeight) {
    throw new Error("Unable to determine input image dimensions")
  }

  const scale = Math.min(
    INPUT_SIZE / originalWidth,
    INPUT_SIZE / originalHeight
  )

  const resizedWidth = Math.max(
    1,
    Math.round(originalWidth * scale)
  )

  const resizedHeight = Math.max(
    1,
    Math.round(originalHeight * scale)
  )

  const resized = await sharp(buffer)
    .flatten({
      background: {
        r: 0,
        g: 0,
        b: 0,
      },
    })
    .resize(resizedWidth, resizedHeight, {
      fit: "fill",
    })
    .toColourspace("srgb")
    .raw()
    .toBuffer()

  const input = new Float32Array(
    3 * INPUT_SIZE * INPUT_SIZE
  )

  const paddingValue = (0 - 127.5) / 128.0
  input.fill(paddingValue)

  const planeSize = INPUT_SIZE * INPUT_SIZE

  for (let y = 0; y < resizedHeight; y++) {
    for (let x = 0; x < resizedWidth; x++) {
      const src = (y * resizedWidth + x) * 3

      const r = resized[src]
      const g = resized[src + 1]
      const b = resized[src + 2]

      const dst = y * INPUT_SIZE + x

      input[dst] = (r - 127.5) / 128.0
      input[planeSize + dst] = (g - 127.5) / 128.0
      input[2 * planeSize + dst] = (b - 127.5) / 128.0
    }
  }

  return {
    input,
    originalWidth,
    originalHeight,
    detScale: scale,
    resizedWidth,
    resizedHeight,
  }
}

export async function detectFacesServer(
  buffer: Buffer
): Promise<Array<{ box: ServerFaceBox; score: number }>> {
  const session = await getSession()

  const {
    input,
    originalWidth,
    originalHeight,
    detScale,
  } = await decodeImage(buffer)

  const inputTensor = new ort.Tensor(
    "float32",
    input,
    [1, 3, INPUT_SIZE, INPUT_SIZE]
  )

  const output = await session.run({
    "input.1": inputTensor,
  })

  const detections: Array<{
    box: ServerFaceBox
    score: number
  }> = []

  for (let level = 0; level < STRIDES.length; level++) {
    const stride = STRIDES[level]

    const scoreTensor = output[`score_${stride}`]
    const bboxTensor = output[`bbox_${stride}`]

    if (!scoreTensor || !bboxTensor) {
      throw new Error(
        `SCRFD output missing for stride ${stride}`
      )
    }

    const scores = scoreTensor.data as Float32Array
    const bbox = bboxTensor.data as Float32Array

    const featureWidth = INPUT_SIZE / stride
    const featureHeight = INPUT_SIZE / stride

    for (let index = 0; index < scores.length; index++) {
      const score = scores[index]

      if (score < DET_THRESHOLD) {
        continue
      }

      const cell = Math.floor(index / NUM_ANCHORS)

      const gridX = cell % featureWidth
      const gridY = Math.floor(cell / featureWidth)

      const centerX = gridX * stride
      const centerY = gridY * stride

      const bboxOffset = index * 4

      const left = bbox[bboxOffset] * stride
      const top = bbox[bboxOffset + 1] * stride
      const right = bbox[bboxOffset + 2] * stride
      const bottom = bbox[bboxOffset + 3] * stride

      const x1 = (centerX - left) / detScale
      const y1 = (centerY - top) / detScale
      const x2 = (centerX + right) / detScale
      const y2 = (centerY + bottom) / detScale

      const clampedX1 = Math.max(
        0,
        Math.min(originalWidth, x1)
      )

      const clampedY1 = Math.max(
        0,
        Math.min(originalHeight, y1)
      )

      const clampedX2 = Math.max(
        0,
        Math.min(originalWidth, x2)
      )

      const clampedY2 = Math.max(
        0,
        Math.min(originalHeight, y2)
      )

      const width = clampedX2 - clampedX1
      const height = clampedY2 - clampedY1

      if (width < 20 || height < 20) {
        continue
      }

      detections.push({
        box: {
          x: clampedX1,
          y: clampedY1,
          width,
          height,
        },
        score,
      })
    }
  }

  return nms(detections)
}

export async function detectExactlyOneFace(
  buffer: Buffer
): Promise<ServerFaceBox> {
  const detections = await detectFacesServer(buffer)

  if (detections.length === 0) {
    throw new Error(
      "No face detected. Please capture the enrollment image with exactly one face clearly visible."
    )
  }

  if (detections.length > 1) {
    throw new Error(
      `Multiple faces detected (${detections.length}). Please capture the enrollment image with only the student visible.`
    )
  }

  return detections[0].box
}
