import * as ort from "onnxruntime-web";

export interface SCRFDFace {
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  confidence: number;
  keypoints: Array<{
    x: number;
    y: number;
  }>;
}

interface LetterboxInfo {
  scale: number;
  offsetX: number;
  offsetY: number;
  sourceWidth: number;
  sourceHeight: number;
}

const MODEL_URL = "/models/scrfd_500m_bnkps_shape640x640.onnx";

const INPUT_SIZE = 640;
const SCORE_THRESHOLD = 0.50;
const NMS_THRESHOLD = 0.40;
const MAX_FACES = 4;

// SCRFD-500M uses 2 anchors per spatial location.
const STRIDES = [8, 16, 32] as const;
const NUM_ANCHORS = 2;

let sessionPromise: Promise<ort.InferenceSession> | null = null;

/**
 * Load the SCRFD ONNX model once and reuse the session.
 */
async function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["webgpu", "wasm"],
      graphOptimizationLevel: "all",
    });
  }

  return sessionPromise;
}

/**
 * Preload the SCRFD model.
 */
export async function preloadSCRFDModel(): Promise<void> {
  await getSession();
}

/**
 * Return basic model information.
 */
export function getSCRFDModelInfo() {
  return {
    model: MODEL_URL,
    inputSize: INPUT_SIZE,
    strides: [...STRIDES],
    anchorsPerLocation: NUM_ANCHORS,
    scoreThreshold: SCORE_THRESHOLD,
    nmsThreshold: NMS_THRESHOLD,
  };
}

/**
 * Convert an HTML video frame into a 640x640 SCRFD tensor.
 *
 * SCRFD expects:
 *   NCHW
 *   RGB
 *   float32
 *   normalization: (pixel - 127.5) / 128
 *
 * Letterboxing is used so the original camera aspect ratio is preserved.
 */
function preprocessVideo(
  video: HTMLVideoElement,
): {
  tensor: ort.Tensor;
  letterbox: LetterboxInfo;
} {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;

  if (!sourceWidth || !sourceHeight) {
    throw new Error("Camera video dimensions are not available");
  }

  const scale = Math.min(
    INPUT_SIZE / sourceWidth,
    INPUT_SIZE / sourceHeight,
  );

  const resizedWidth = Math.round(sourceWidth * scale);
  const resizedHeight = Math.round(sourceHeight * scale);

  const offsetX = Math.floor((INPUT_SIZE - resizedWidth) / 2);
  const offsetY = Math.floor((INPUT_SIZE - resizedHeight) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = INPUT_SIZE;
  canvas.height = INPUT_SIZE;

  const ctx = canvas.getContext("2d", {
    willReadFrequently: true,
  });

  if (!ctx) {
    throw new Error("Unable to create SCRFD preprocessing canvas");
  }

  // Black letterbox background.
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);

  ctx.drawImage(
    video,
    0,
    0,
    sourceWidth,
    sourceHeight,
    offsetX,
    offsetY,
    resizedWidth,
    resizedHeight,
  );

  const imageData = ctx.getImageData(
    0,
    0,
    INPUT_SIZE,
    INPUT_SIZE,
  );

  const pixels = imageData.data;

  // NCHW = [1, 3, 640, 640]
  const planeSize = INPUT_SIZE * INPUT_SIZE;

  const input = new Float32Array(3 * planeSize);

  for (let y = 0; y < INPUT_SIZE; y++) {
    for (let x = 0; x < INPUT_SIZE; x++) {
      const pixelIndex = (y * INPUT_SIZE + x) * 4;
      const tensorIndex = y * INPUT_SIZE + x;

      const r = pixels[pixelIndex];
      const g = pixels[pixelIndex + 1];
      const b = pixels[pixelIndex + 2];

      input[tensorIndex] = (r - 127.5) / 128.0;
      input[planeSize + tensorIndex] = (g - 127.5) / 128.0;
      input[2 * planeSize + tensorIndex] = (b - 127.5) / 128.0;
    }
  }

  return {
    tensor: new ort.Tensor("float32", input, [
      1,
      3,
      INPUT_SIZE,
      INPUT_SIZE,
    ]),
    letterbox: {
      scale,
      offsetX,
      offsetY,
      sourceWidth,
      sourceHeight,
    },
  };
}

/**
 * Convert a possibly-logit SCRFD score into a probability.
 *
 * Some exported SCRFD models provide probabilities directly,
 * while some exports provide logits. Values outside [0,1]
 * are therefore sigmoid-normalized.
 */
function normalizeScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value >= 0 && value <= 1) {
    return value;
  }

  return 1 / (1 + Math.exp(-value));
}

/**
 * SCRFD bounding-box decoding.
 *
 * bbox values represent distances from the anchor center:
 *   left, top, right, bottom
 */
function decodeBBox(
  raw: Float32Array,
  index: number,
  stride: number,
  anchorX: number,
  anchorY: number,
): [number, number, number, number] {
  const base = index * 4;

  const left = raw[base] * stride;
  const top = raw[base + 1] * stride;
  const right = raw[base + 2] * stride;
  const bottom = raw[base + 3] * stride;

  const x1 = anchorX - left;
  const y1 = anchorY - top;
  const x2 = anchorX + right;
  const y2 = anchorY + bottom;

  return [x1, y1, x2, y2];
}

/**
 * Decode the five SCRFD facial landmarks.
 */
function decodeKeypoints(
  raw: Float32Array,
  index: number,
  stride: number,
  anchorX: number,
  anchorY: number,
): Array<{ x: number; y: number }> {
  const base = index * 10;
  const points: Array<{ x: number; y: number }> = [];

  for (let point = 0; point < 5; point++) {
    points.push({
      x: anchorX + raw[base + point * 2] * stride,
      y: anchorY + raw[base + point * 2 + 1] * stride,
    });
  }

  return points;
}

/**
 * Convert SCRFD 640x640 coordinates back to camera coordinates.
 */
function restoreCoordinates(
  bbox: [number, number, number, number],
  keypoints: Array<{ x: number; y: number }>,
  letterbox: LetterboxInfo,
): SCRFDFace {
  const [rawX1, rawY1, rawX2, rawY2] = bbox;

  const x1 = (rawX1 - letterbox.offsetX) / letterbox.scale;
  const y1 = (rawY1 - letterbox.offsetY) / letterbox.scale;
  const x2 = (rawX2 - letterbox.offsetX) / letterbox.scale;
  const y2 = (rawY2 - letterbox.offsetY) / letterbox.scale;

  const clampedX1 = Math.max(
    0,
    Math.min(letterbox.sourceWidth, x1),
  );

  const clampedY1 = Math.max(
    0,
    Math.min(letterbox.sourceHeight, y1),
  );

  const clampedX2 = Math.max(
    0,
    Math.min(letterbox.sourceWidth, x2),
  );

  const clampedY2 = Math.max(
    0,
    Math.min(letterbox.sourceHeight, y2),
  );

  const restoredKeypoints = keypoints.map((point) => ({
    x: Math.max(
      0,
      Math.min(
        letterbox.sourceWidth,
        (point.x - letterbox.offsetX) / letterbox.scale,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        letterbox.sourceHeight,
        (point.y - letterbox.offsetY) / letterbox.scale,
      ),
    ),
  }));

  return {
    bbox: {
      x: clampedX1,
      y: clampedY1,
      width: Math.max(0, clampedX2 - clampedX1),
      height: Math.max(0, clampedY2 - clampedY1),
    },
    confidence: 0,
    keypoints: restoredKeypoints,
  };
}

/**
 * Calculate IoU between two boxes.
 */
function calculateIoU(
  a: SCRFDFace,
  b: SCRFDFace,
): number {
  const ax1 = a.bbox.x;
  const ay1 = a.bbox.y;
  const ax2 = a.bbox.x + a.bbox.width;
  const ay2 = a.bbox.y + a.bbox.height;

  const bx1 = b.bbox.x;
  const by1 = b.bbox.y;
  const bx2 = b.bbox.x + b.bbox.width;
  const by2 = b.bbox.y + b.bbox.height;

  const intersectionX1 = Math.max(ax1, bx1);
  const intersectionY1 = Math.max(ay1, by1);
  const intersectionX2 = Math.min(ax2, bx2);
  const intersectionY2 = Math.min(ay2, by2);

  const intersectionWidth = Math.max(
    0,
    intersectionX2 - intersectionX1,
  );

  const intersectionHeight = Math.max(
    0,
    intersectionY2 - intersectionY1,
  );

  const intersectionArea =
    intersectionWidth * intersectionHeight;

  const areaA =
    Math.max(0, ax2 - ax1) *
    Math.max(0, ay2 - ay1);

  const areaB =
    Math.max(0, bx2 - bx1) *
    Math.max(0, by2 - by1);

  const union = areaA + areaB - intersectionArea;

  if (union <= 0) {
    return 0;
  }

  return intersectionArea / union;
}

/**
 * Non-Maximum Suppression.
 */
function nms(
  detections: SCRFDFace[],
): SCRFDFace[] {
  const sorted = [...detections].sort(
    (a, b) => b.confidence - a.confidence,
  );

  const selected: SCRFDFace[] = [];

  while (sorted.length > 0) {
    const best = sorted.shift();

    if (!best) {
      break;
    }

    selected.push(best);

    for (let i = sorted.length - 1; i >= 0; i--) {
      if (
        calculateIoU(best, sorted[i]) >= NMS_THRESHOLD
      ) {
        sorted.splice(i, 1);
      }
    }
  }

  return selected;
}

/**
 * Run SCRFD face detection on a video element.
 *
 * Returns real face detections from the SCRFD model.
 */
export async function detectFacesSCRFD(
  video: HTMLVideoElement,
): Promise<SCRFDFace[]> {
  const session = await getSession();

  const {
    tensor,
    letterbox,
  } = preprocessVideo(video);

  const results = await session.run({
    "input.1": tensor,
  });

  const detections: SCRFDFace[] = [];

  const scoreNames = [
    "score_8",
    "score_16",
    "score_32",
  ] as const;

  const bboxNames = [
    "bbox_8",
    "bbox_16",
    "bbox_32",
  ] as const;

  const kpsNames = [
    "kps_8",
    "kps_16",
    "kps_32",
  ] as const;

  for (let level = 0; level < STRIDES.length; level++) {
    const stride = STRIDES[level];

    const scoreTensor = results[scoreNames[level]];
    const bboxTensor = results[bboxNames[level]];
    const kpsTensor = results[kpsNames[level]];

    if (!scoreTensor || !bboxTensor || !kpsTensor) {
      throw new Error(
        `SCRFD output tensors missing for stride ${stride}`,
      );
    }

    const scores = scoreTensor.data as Float32Array;
    const boxes = bboxTensor.data as Float32Array;
    const keypoints = kpsTensor.data as Float32Array;

    const featureSize = INPUT_SIZE / stride;
    const locations = featureSize * featureSize;

    for (let location = 0; location < locations; location++) {
      const gridX = location % featureSize;
      const gridY = Math.floor(location / featureSize);

      for (
        let anchor = 0;
        anchor < NUM_ANCHORS;
        anchor++
      ) {
        const detectionIndex =
          location * NUM_ANCHORS + anchor;

        const score = normalizeScore(
          scores[detectionIndex],
        );

        if (score < SCORE_THRESHOLD) {
          continue;
        }

        const anchorX =
          (gridX + 0.5) * stride;

        const anchorY =
          (gridY + 0.5) * stride;

        const rawBox = decodeBBox(
          boxes,
          detectionIndex,
          stride,
          anchorX,
          anchorY,
        );

        const rawKeypoints = decodeKeypoints(
          keypoints,
          detectionIndex,
          stride,
          anchorX,
          anchorY,
        );

        const face = restoreCoordinates(
          rawBox,
          rawKeypoints,
          letterbox,
        );

        face.confidence = Number(
          score.toFixed(4),
        );

        if (
          face.bbox.width < 10 ||
          face.bbox.height < 10
        ) {
          continue;
        }

        detections.push(face);
      }
    }
  }

  const finalDetections = nms(detections)
    .sort(
      (a, b) => b.confidence - a.confidence,
    )
    .slice(0, MAX_FACES);

  return finalDetections;
}
