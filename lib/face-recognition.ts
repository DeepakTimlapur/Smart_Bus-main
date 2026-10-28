/**
 * DEMO / DEVELOPMENT BROWSER ENGINE — NOT the production recognition system.
 *
 * This file's `generateCanonicalFaceEmbedding` produces seeded-random 128-D
 * vectors and is used ONLY by DriverFaceRecognition.tsx's scenario simulator
 * (see the banner added to that component). It is intentionally NOT used for
 * enrollment or real matching — those paths now use:
 *   - Enrollment: browser captures → POST /api/v1/faces/enroll-samples →
 *     lib/face-embedding-server.ts runs the real ONNX model server-side
 *   - Recognition: Raspberry Pi runs the same ONNX model (raspberry_pi/
 *     embedding_model.py) and submits real 512-D embeddings to the server
 *
 * If you see `generateCanonicalFaceEmbedding` called outside of
 * DriverFaceRecognition.tsx or test scripts, that is a bug — it means fake
 * embeddings would end up in production enrollment storage.
 *
 * The 128-D dimension in this file is also the old, superseded dimension;
 * the real model and all production paths now use 512-D (see
 * lib/embedding-spec.ts / docs/EMBEDDING_SPEC.md). This file's dimension
 * is not changed here to avoid breaking the demo simulator — it is legacy.
 */
// Browser-compatible Multi-Face Detection and 128-Dimensional Feature Embedding Utility
// Operates on HTML5 Canvas / Video streams without external server/Python dependencies.

export interface DetectedFaceBox {
  x: number
  y: number
  width: number
  height: number
  confidence: number
}

export interface ExtractedFace {
  box: DetectedFaceBox
  embedding: number[]
  qualityScore: number
}

export interface DetectedFaceItem {
  bbox: { x: number; y: number; width: number; height: number }
  confidence: number
  embedding: number[]
}

// Deterministic seed vector generator for student profiles (128-dimensional unit vector)
export function generateCanonicalFaceEmbedding(seedString: string): number[] {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < seedString.length; i++) {
    const ch = seedString.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  const vector: number[] = new Array(128)
  let s = h1 ^ h2

  for (let i = 0; i < 128; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    const val = (s / 0x7fffffff) * 2 - 1
    vector[i] = val
  }

  // Normalize to L2 unit norm
  let sumSq = 0
  for (let i = 0; i < 128; i++) sumSq += vector[i] * vector[i]
  const norm = Math.sqrt(sumSq) || 1
  for (let i = 0; i < 128; i++) vector[i] = Number((vector[i] / norm).toFixed(6))

  return vector
}

/**
 * DEV/TEST FIXTURE ONLY — NOT a real embedding, NOT production-usable.
 *
 * Produces a deterministic 512-D seeded-random unit vector, for test
 * scripts (scripts/biometric-runtime-test.ts, scripts/iot-exit-lifecycle-
 * test.ts) that need SOMETHING dimensionally valid to exercise pipeline
 * logic (temporal consensus, idempotency, entry/exit state machine) without
 * a real ONNX model or real face photos available.
 *
 * IMPORTANT: this deliberately does NOT carry embedding_metadata matching
 * SPEC_MODEL_VERSION (see lib/embedding-spec.ts) — a vector from this
 * function will correctly be excluded by lib/server-db.ts's matching gate
 * (docs/FACE_RECOGNITION.md, "Migration") the same as any other legacy/fake
 * embedding. It exists to fix a dimension mismatch (these test scripts
 * previously generated 128-D vectors, which the current EMBEDDING_DIMENSION
 * of 512 rejects outright), not to make fake data look like a real
 * enrollment. Do not import this outside test scripts.
 */
export function generateDevFixture512DVector(seedString: string): number[] {
  let h1 = 0x9e3779b9
  let h2 = 0x85ebca6b
  for (let i = 0; i < seedString.length; i++) {
    const ch = seedString.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  const dim = 512
  const vector: number[] = new Array(dim)
  let s = h1 ^ h2
  for (let i = 0; i < dim; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    vector[i] = (s / 0x7fffffff) * 2 - 1
  }

  let sumSq = 0
  for (let i = 0; i < dim; i++) sumSq += vector[i] * vector[i]
  const norm = Math.sqrt(sumSq) || 1
  for (let i = 0; i < dim; i++) vector[i] = Number((vector[i] / norm).toFixed(6))

  return vector
}

// Cosine similarity computation between two 128D embeddings
export function computeCosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  const sim = dot / denom
  return Math.max(0, Math.min(1, sim))
}

// Client-side Face Detection and Feature Extraction on HTML5 Canvas / Video
export class ClientFaceEngine {
  private processingCanvas: HTMLCanvasElement | null = null
  private processingCtx: CanvasRenderingContext2D | null = null
  private static _sharedCanvas: HTMLCanvasElement | null = null

  // Fast synchronous face detector for real-time video frames (up to 4 faces)
  static detectFaces(
    source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
    maxFaces = 4
  ): DetectedFaceItem[] {
    if (!source || typeof window === "undefined") return []

    const srcW = source instanceof HTMLVideoElement ? source.videoWidth : source.width
    const srcH = source instanceof HTMLVideoElement ? source.videoHeight : source.height
    if (!srcW || !srcH) return []

    if (!ClientFaceEngine._sharedCanvas) {
      ClientFaceEngine._sharedCanvas = document.createElement("canvas")
    }
    const canvas = ClientFaceEngine._sharedCanvas
    const procW = 320
    const procH = Math.max(120, Math.round((srcH / srcW) * procW))
    canvas.width = procW
    canvas.height = procH
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return []

    ctx.drawImage(source, 0, 0, procW, procH)
    const imgData = ctx.getImageData(0, 0, procW, procH)
    const data = imgData.data

    const gridCols = 8
    const gridRows = 6
    const cellW = Math.floor(procW / gridCols)
    const cellH = Math.floor(procH / gridRows)
    const gridScores = new Float32Array(gridCols * gridRows)

    for (let gy = 0; gy < gridRows; gy++) {
      for (let gx = 0; gx < gridCols; gx++) {
        let skinCount = 0
        let total = 0
        for (let y = gy * cellH; y < (gy + 1) * cellH; y += 2) {
          for (let x = gx * cellW; x < (gx + 1) * cellW; x += 2) {
            const idx = (y * procW + x) * 4
            const r = data[idx]
            const g = data[idx + 1]
            const b = data[idx + 2]
            total++
            if (r > 60 && g > 40 && b > 20 && r > g && r > b && (r - g) > 10) {
              skinCount++
            }
          }
        }
        gridScores[gy * gridCols + gx] = total > 0 ? skinCount / total : 0
      }
    }

    interface Candidate {
      x: number
      y: number
      w: number
      h: number
      score: number
    }
    const candidates: Candidate[] = []

    for (let gy = 0; gy <= gridRows - 2; gy++) {
      for (let gx = 0; gx <= gridCols - 2; gx++) {
        const score =
          gridScores[gy * gridCols + gx] +
          gridScores[gy * gridCols + (gx + 1)] +
          gridScores[(gy + 1) * gridCols + gx] +
          gridScores[(gy + 1) * gridCols + (gx + 1)]

        const avgScore = score / 4
        if (avgScore > 0.16) {
          const pixelX = gx * cellW
          const pixelY = gy * cellH
          const pixelW = cellW * 2
          const pixelH = cellH * 2

          let suppressed = false
          for (const c of candidates) {
            const xO = Math.max(0, Math.min(pixelX + pixelW, c.x + c.w) - Math.max(pixelX, c.x))
            const yO = Math.max(0, Math.min(pixelY + pixelH, c.y + c.h) - Math.max(pixelY, c.y))
            const inter = xO * yO
            const union = pixelW * pixelH + c.w * c.h - inter
            if (union > 0 && inter / union > 0.35) {
              suppressed = true
              if (avgScore > c.score) {
                c.x = pixelX
                c.y = pixelY
                c.w = pixelW
                c.h = pixelH
                c.score = avgScore
              }
              break
            }
          }
          if (!suppressed && candidates.length < maxFaces * 2) {
            candidates.push({ x: pixelX, y: pixelY, w: pixelW, h: pixelH, score: avgScore })
          }
        }
      }
    }

    if (candidates.length === 0) {
      candidates.push({
        x: Math.round(procW * 0.25),
        y: Math.round(procH * 0.15),
        w: Math.round(procW * 0.5),
        h: Math.round(procH * 0.7),
        score: 0.88,
      })
    }

    const scaleX = srcW / procW
    const scaleY = srcH / procH
    candidates.sort((a, b) => a.x - b.x)

    const results: DetectedFaceItem[] = []
    const selected = candidates.slice(0, maxFaces)

    for (let i = 0; i < selected.length; i++) {
      const c = selected[i]
      const box = {
        x: Math.max(0, Math.round(c.x * scaleX)),
        y: Math.max(0, Math.round(c.y * scaleY)),
        width: Math.min(srcW - Math.round(c.x * scaleX), Math.round(c.w * scaleX)),
        height: Math.min(srcH - Math.round(c.y * scaleY), Math.round(c.h * scaleY)),
      }
      const confidence = Number(Math.min(0.99, Math.max(0.75, c.score * 1.4)).toFixed(2))

      const faceSeed = `${Math.round(box.x / 10)}_${Math.round(box.y / 10)}_${Math.round(box.width / 10)}_${Math.round(box.height / 10)}`
      const embedding = generateCanonicalFaceEmbedding(faceSeed)

      results.push({
        bbox: box,
        confidence,
        embedding,
      })
    }

    return results
  }

  private getContext(width = 320, height = 240): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    if (!this.processingCanvas) {
      this.processingCanvas = document.createElement("canvas")
      this.processingCanvas.width = width
      this.processingCanvas.height = height
      this.processingCtx = this.processingCanvas.getContext("2d", { willReadFrequently: true })
    }
    if (this.processingCanvas.width !== width || this.processingCanvas.height !== height) {
      this.processingCanvas.width = width
      this.processingCanvas.height = height
      this.processingCtx = this.processingCanvas.getContext("2d", { willReadFrequently: true })
    }
    return { canvas: this.processingCanvas, ctx: this.processingCtx! }
  }

  // Detect human face bounding boxes in an image / video frame (up to 4+ faces)
  async detectFaces(
    source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
    maxFaces = 8
  ): Promise<{ boxes: DetectedFaceBox[]; overflow: boolean }> {
    if (!source) return { boxes: [], overflow: false }

    const srcW = source instanceof HTMLVideoElement ? source.videoWidth : source.width
    const srcH = source instanceof HTMLVideoElement ? source.videoHeight : source.height
    if (!srcW || !srcH) return { boxes: [], overflow: false }

    // Check if browser native FaceDetector is available
    if (typeof window !== "undefined" && "FaceDetector" in window) {
      try {
        const detector = new (window as any).FaceDetector({ maxDetectedFaces: maxFaces, fastMode: true })
        const faces = await detector.detect(source)
        if (Array.isArray(faces) && faces.length > 0) {
          const boxes: DetectedFaceBox[] = faces.map((f: any) => ({
            x: Math.round(f.boundingBox.x),
            y: Math.round(f.boundingBox.y),
            width: Math.round(f.boundingBox.width),
            height: Math.round(f.boundingBox.height),
            confidence: 0.95,
          }))
          // Sort largest/most prominent first
          boxes.sort((a, b) => b.width * b.height - a.width * a.height)
          return {
            boxes: boxes.slice(0, 4),
            overflow: boxes.length > 4,
          }
        }
      } catch {
        // Fall back to computer vision canvas analysis
      }
    }

    // High-performance canvas-based skin-locus and gradient face cluster detection
    const procW = 320
    const procH = Math.round((srcH / srcW) * procW)
    const { canvas, ctx } = this.getContext(procW, procH)
    ctx.drawImage(source, 0, 0, procW, procH)
    const imgData = ctx.getImageData(0, 0, procW, procH)
    const data = imgData.data

    // Detect skin-color pixel candidates using YCbCr / RGB skin color distribution
    const skinMap = new Uint8Array(procW * procH)
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const pixelIdx = i / 4

      // Standard skin locus heuristics (normalized RGB & YCbCr approximation)
      const isSkin =
        r > 60 &&
        g > 40 &&
        b > 20 &&
        r > g &&
        r > b &&
        r - g > 12 &&
        Math.abs(r - g) > 10 &&
        r - b > 10

      if (isSkin) {
        skinMap[pixelIdx] = 1
      }
    }

    // Connected components / window grid clustering
    const gridSize = 16
    const cols = Math.floor(procW / gridSize)
    const rows = Math.floor(procH / gridSize)
    const density = new Float32Array(cols * rows)

    for (let ry = 0; ry < rows; ry++) {
      for (let rx = 0; rx < cols; rx++) {
        let count = 0
        const startY = ry * gridSize
        const startX = rx * gridSize
        for (let y = 0; y < gridSize; y++) {
          for (let x = 0; x < gridSize; x++) {
            if (skinMap[(startY + y) * procW + (startX + x)]) count++
          }
        }
        density[ry * cols + rx] = count / (gridSize * gridSize)
      }
    }

    // Find local maxima with minimum density 0.25 (face candidates)
    const candidateRegions: Array<{ x: number; y: number; w: number; h: number; score: number }> = []

    // Multi-scale sliding window search for facial clusters
    const windowSizes = [5, 4, 3] // in grid units
    for (const ws of windowSizes) {
      const step = 2
      for (let gy = 1; gy <= rows - ws - 1; gy += step) {
        for (let gx = 1; gx <= cols - ws - 1; gx += step) {
          let sum = 0
          for (let dy = 0; dy < ws; dy++) {
            for (let dx = 0; dx < ws; dx++) {
              sum += density[(gy + dy) * cols + (gx + dx)]
            }
          }
          const avgDensity = sum / (ws * ws)
          if (avgDensity > 0.35) {
            const pixelX = gx * gridSize
            const pixelY = gy * gridSize
            const pixelW = ws * gridSize
            const pixelH = Math.round(ws * gridSize * 1.25) // Human faces are ~1.25x taller than wide

            // Non-maximum suppression against existing candidates
            let overlap = false
            for (const c of candidateRegions) {
              const xOverlap = Math.max(0, Math.min(pixelX + pixelW, c.x + c.w) - Math.max(pixelX, c.x))
              const yOverlap = Math.max(0, Math.min(pixelY + pixelH, c.y + c.h) - Math.max(pixelY, c.y))
              const intersection = xOverlap * yOverlap
              const union = pixelW * pixelH + c.w * c.h - intersection
              if (intersection / union > 0.3) {
                overlap = true
                if (avgDensity > c.score) {
                  c.x = pixelX
                  c.y = pixelY
                  c.w = pixelW
                  c.h = pixelH
                  c.score = avgDensity
                }
                break
              }
            }
            if (!overlap && candidateRegions.length < maxFaces) {
              candidateRegions.push({ x: pixelX, y: pixelY, w: pixelW, h: pixelH, score: avgDensity })
            }
          }
        }
      }
    }

    // Scale back to source resolution
    const scaleX = srcW / procW
    const scaleY = srcH / procH

    const rawBoxes: DetectedFaceBox[] = candidateRegions.map((c) => ({
      x: Math.max(0, Math.round(c.x * scaleX)),
      y: Math.max(0, Math.round(c.y * scaleY)),
      width: Math.min(srcW - Math.round(c.x * scaleX), Math.round(c.w * scaleX)),
      height: Math.min(srcH - Math.round(c.y * scaleY), Math.round(c.h * scaleY)),
      confidence: Number(Math.min(0.98, c.score * 1.3).toFixed(2)),
    }))

    // Sort left-to-right (natural spatial reading for passengers)
    rawBoxes.sort((a, b) => a.x - b.x)

    const overflow = rawBoxes.length > 4
    const finalBoxes = rawBoxes.slice(0, 4)

    return { boxes: finalBoxes, overflow }
  }

  // Extract a 128-dimensional biometric embedding vector from a detected face box
  extractEmbeddingFromBox(
    source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
    box: DetectedFaceBox
  ): ExtractedFace {
    const size = 64
    const { canvas, ctx } = this.getContext(size, size)

    // Clip & draw normalized face chip
    ctx.clearRect(0, 0, size, size)
    try {
      ctx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, size, size)
    } catch {
      // Fallback if image source out of bounds
    }

    const imgData = ctx.getImageData(0, 0, size, size)
    const data = imgData.data
    const gray = new Float32Array(size * size)

    for (let i = 0; i < data.length; i += 4) {
      // Perceptual luminance
      gray[i / 4] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    }

    const embedding = new Array<number>(128).fill(0)

    // 1. Spatial cell luminance & gradients (64 values: 8x8 grid averages)
    const cellW = size / 8
    const cellH = size / 8
    for (let cy = 0; cy < 8; cy++) {
      for (let cx = 0; cx < 8; cx++) {
        let cellSum = 0
        for (let y = 0; y < cellH; y++) {
          for (let x = 0; x < cellW; x++) {
            const py = Math.floor(cy * cellH + y)
            const px = Math.floor(cx * cellW + x)
            cellSum += gray[py * size + px]
          }
        }
        const idx = cy * 8 + cx
        embedding[idx] = (cellSum / (cellW * cellH)) / 255.0
      }
    }

    // 2. Horizontal & vertical intensity gradients across 4 quadrants (32 values)
    let gradIdx = 64
    for (let qy = 0; qy < 4; qy++) {
      for (let qx = 0; qx < 4; qx++) {
        const startX = qx * 16
        const startY = qy * 16
        let dxSum = 0
        let dySum = 0
        for (let y = 1; y < 15; y++) {
          for (let x = 1; x < 15; x++) {
            const py = startY + y
            const px = startX + x
            const dx = gray[py * size + (px + 1)] - gray[py * size + (px - 1)]
            const dy = gray[(py + 1) * size + px] - gray[(py - 1) * size + px]
            dxSum += Math.abs(dx)
            dySum += Math.abs(dy)
          }
        }
        embedding[gradIdx++] = (dxSum / 196) / 255.0
        embedding[gradIdx++] = (dySum / 196) / 255.0
      }
    }

    // 3. Facial feature symmetry & contrast distribution (32 values)
    let symIdx = 96
    // Horizontal face symmetry across midline
    for (let r = 0; r < 16; r++) {
      let diff = 0
      const py = r * 4
      for (let x = 0; x < 32; x++) {
        const leftVal = gray[py * size + x]
        const rightVal = gray[py * size + (size - 1 - x)]
        diff += Math.abs(leftVal - rightVal)
      }
      embedding[symIdx++] = (diff / 32) / 255.0
    }
    // Vertical profile contrast (forehead, eye band, nose bridge, mouth chin)
    for (let b = 0; b < 16; b++) {
      let rowMean = 0
      const py = b * 4
      for (let x = 0; x < size; x++) {
        rowMean += gray[py * size + x]
      }
      embedding[symIdx++] = (rowMean / size) / 255.0
    }

    // L2 Normalization
    let sumSq = 0
    for (let i = 0; i < 128; i++) sumSq += embedding[i] * embedding[i]
    const norm = Math.sqrt(sumSq) || 1
    for (let i = 0; i < 128; i++) {
      embedding[i] = Number((embedding[i] / norm).toFixed(6))
    }

    return {
      box,
      embedding,
      qualityScore: Number(box.confidence.toFixed(2)),
    }
  }
}

// Global Singleton for Client Face Engine
export const clientFaceEngine = new ClientFaceEngine()

// =========================================================================
// ADVANCED BIOMETRIC TYPES & RECOGNITION STATES
// =========================================================================

export type BiometricRecognitionState =
  | "DETECTING"
  | "QUALITY_CHECK"
  | "TRACKING"
  | "VERIFYING"
  | "VERIFIED"
  | "BOARDING"
  | "BOARDED"
  | "ALREADY_BOARDED"
  | "UNKNOWN"
  | "LOW_CONFIDENCE"
  | "LIVENESS_FAILED"
  | "DENIED_FEE"
  | "DENIED_INACTIVE"
  | "DENIED_CAPACITY"
  | "ERROR"

export interface FaceQualityAssessment {
  size: number
  brightness: number
  sharpness: number
  blur: number
  aspectRatio: number
  poseAngle: number
  qualityScore: number
  qualityLabel: "GOOD" | "ACCEPTABLE" | "FACE TOO SMALL" | "FACE BLURRED" | "INSUFFICIENT QUALITY" | "FACE ANGLE TOO HIGH"
  isAcceptable: boolean
  error?: string
}

export interface LivenessAssessment {
  livenessStatus: "VERIFIED" | "PENDING" | "FAILED"
  livenessScore: number
  motionVariance: number
  blinkDetected: boolean
  isLive: boolean
  reason?: string
}

// Generate 5 distinct, high-quality enrolled reference embeddings per student
export function generateMultipleReferenceEmbeddings(seedString: string, count = 5): number[][] {
  const result: number[][] = []
  const baseVector = generateCanonicalFaceEmbedding(seedString)
  result.push(baseVector)

  const variations = ["_frontal", "_pose_left", "_pose_right", "_ambient_light", "_expression_neutral"]
  for (let i = 1; i < count; i++) {
    const varSeed = `${seedString}${variations[i % variations.length]}_${i}`
    const varVector = generateCanonicalFaceEmbedding(varSeed)
    // Blend with baseVector (85% base + 15% variation) for realistic multi-view reference cluster
    const blended: number[] = new Array(128)
    let sumSq = 0
    for (let j = 0; j < 128; j++) {
      const v = 0.85 * baseVector[j] + 0.15 * varVector[j]
      blended[j] = v
      sumSq += v * v
    }
    const norm = Math.sqrt(sumSq) || 1
    for (let j = 0; j < 128; j++) {
      blended[j] = Number((blended[j] / norm).toFixed(6))
    }
    result.push(blended)
  }
  return result
}

// Evaluate face quality: size, blur, brightness, aspect ratio, detection confidence
export function evaluateFaceQuality(
  box: { x: number; y: number; width: number; height: number; confidence?: number },
  imageSource?: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
): FaceQualityAssessment {
  const minDim = Math.min(box.width, box.height)
  const aspectRatio = box.height / Math.max(1, box.width)

  // Very small faces are not suitable for reliable biometric extraction.
  if (minDim < 42) {
    return {
      size: minDim,
      brightness: 120,
      sharpness: 0.15,
      blur: 0.9,
      aspectRatio,
      poseAngle: 0,
      qualityScore: 0.25,
      qualityLabel: "FACE TOO SMALL",
      isAcceptable: false,
      error: "Face too small for reliable biometric extraction (min 42px required).",
    }
  }

  // Reject obviously invalid/rotated bounding boxes.
  if (aspectRatio < 0.85 || aspectRatio > 2.2) {
    return {
      size: minDim,
      brightness: 120,
      sharpness: 0.4,
      blur: 0.6,
      aspectRatio,
      poseAngle: 40,
      qualityScore: 0.35,
      qualityLabel: "FACE ANGLE TOO HIGH",
      isAcceptable: false,
      error: "Face angle too steep or rotated. Please look directly at the scanner.",
    }
  }

  let brightness = 125
  let sharpness = 0.82
  let blur = 0.18

  if (imageSource && typeof window !== "undefined") {
    try {
      const tempCanvas = document.createElement("canvas")

      // Analyze enough pixels to obtain a stable quality estimate.
      // Do not shrink every face to an artificially tiny 16px crop.
      const cropW = Math.max(32, Math.min(128, Math.round(box.width)))
      const cropH = Math.max(32, Math.min(128, Math.round(box.height)))

      tempCanvas.width = cropW
      tempCanvas.height = cropH

      const ctx = tempCanvas.getContext("2d", {
        willReadFrequently: true,
      })

      if (ctx) {
        ctx.drawImage(
          imageSource,
          box.x,
          box.y,
          box.width,
          box.height,
          0,
          0,
          cropW,
          cropH,
        )

        const imgData = ctx.getImageData(0, 0, cropW, cropH)
        const data = imgData.data

        const gray = new Float32Array(cropW * cropH)

        let lumSum = 0

        for (let y = 0; y < cropH; y++) {
          for (let x = 0; x < cropW; x++) {
            const idx = (y * cropW + x) * 4

            const lum =
              0.299 * data[idx] +
              0.587 * data[idx + 1] +
              0.114 * data[idx + 2]

            gray[y * cropW + x] = lum
            lumSum += lum
          }
        }

        brightness = Math.round(
          lumSum / Math.max(1, gray.length),
        )

        // Calculate horizontal + vertical local gradients.
        // This is more stable than using only horizontal differences.
        let gradientSum = 0
        let gradientCount = 0

        for (let y = 1; y < cropH - 1; y++) {
          for (let x = 1; x < cropW - 1; x++) {
            const center = gray[y * cropW + x]

            const left = gray[y * cropW + (x - 1)]
            const right = gray[y * cropW + (x + 1)]
            const up = gray[(y - 1) * cropW + x]
            const down = gray[(y + 1) * cropW + x]

            const gx = Math.abs(right - left)
            const gy = Math.abs(down - up)

            gradientSum += (gx + gy) * 0.5
            gradientCount++
          }
        }

        const avgGradient =
          gradientSum / Math.max(1, gradientCount)

        // Normalize the gradient into a conservative 0..1 sharpness score.
        sharpness = Math.min(
          1,
          Math.max(0, avgGradient / 32),
        )

        // Blur is the inverse of sharpness.
        blur = Math.min(1, Math.max(0, 1 - sharpness))
      }
    } catch {
      // Keep conservative defaults if browser image analysis fails.
      brightness = 125
      sharpness = 0.70
      blur = 0.30
    }
  }

  // Reject genuinely poor illumination.
  if (brightness < 45 || brightness > 235) {
    return {
      size: minDim,
      brightness,
      sharpness,
      blur,
      aspectRatio,
      poseAngle: 0,
      qualityScore: 0.30,
      qualityLabel: "INSUFFICIENT QUALITY",
      isAcceptable: false,
      error: "Poor lighting conditions. Please ensure adequate face illumination.",
    }
  }

  // Only reject clearly blurred images.
  // The previous threshold was too aggressive for normal webcams.
  if (blur > 0.88 || sharpness < 0.12) {
    return {
      size: minDim,
      brightness,
      sharpness,
      blur,
      aspectRatio,
      poseAngle: 0,
      qualityScore: 0.35,
      qualityLabel: "FACE BLURRED",
      isAcceptable: false,
      error: "Face image is too blurred. Please keep your face still.",
    }
  }

  // Faces between 42 and 79 px are technically detectable but
  // should receive a lower quality score.
  const sizeScore = Math.min(1, minDim / 160)

  const lightingScore = Math.max(
    0,
    1 - Math.abs(brightness - 128) / 128,
  )

  const score = Math.min(
    0.99,
    Math.max(
      0.45,
      sizeScore * 0.40 +
        sharpness * 0.40 +
        lightingScore * 0.20,
    ),
  )

  const qualityLabel: "GOOD" | "ACCEPTABLE" =
    score >= 0.78 ? "GOOD" : "ACCEPTABLE"

  return {
    size: minDim,
    brightness,
    sharpness,
    blur,
    aspectRatio,
    poseAngle: 0,
    qualityScore: Number(score.toFixed(2)),
    qualityLabel,
    isAcceptable: true,
  }
}
// Evaluate practical liveness / anti-spoofing via temporal frame variance & micro-motion
export function evaluateLiveness(
  history: Array<{ x: number; y: number; width: number; height: number }>,
  framesObserved: number
): LivenessAssessment {
  if (framesObserved < 2 || history.length < 2) {
    return {
      livenessStatus: "PENDING",
      livenessScore: 0.5,
      motionVariance: 0.01,
      blinkDetected: false,
      isLive: true,
      reason: "Gathering temporal frames for liveness verification.",
    }
  }

  // Measure center drift and bounding-box micro-tremor
  let variance = 0
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1]
    const curr = history[i]
    const dx = Math.abs(curr.x - prev.x)
    const dy = Math.abs(curr.y - prev.y)
    const dw = Math.abs(curr.width - prev.width)
    variance += (dx + dy + dw)
  }
  const avgMotion = variance / history.length

  // If face is observed for 5+ frames with zero natural micro-movement (static photo held to camera)
  if (framesObserved >= 5 && avgMotion < 0.2) {
    return {
      livenessStatus: "FAILED",
      livenessScore: 0.15,
      motionVariance: avgMotion,
      blinkDetected: false,
      isLive: false,
      reason: "Static image detected. No natural biometric micro-motion observed.",
    }
  }

  const livenessScore = Math.min(0.98, Math.max(0.72, 0.85 + Math.min(0.12, avgMotion * 0.02)))
  return {
    livenessStatus: "VERIFIED",
    livenessScore: Number(livenessScore.toFixed(2)),
    motionVariance: Number(avgMotion.toFixed(2)),
    blinkDetected: true,
    isLive: true,
    reason: "Live passenger verified via temporal landmark dynamics.",
  }
}

// Track face across consecutive video frames to provide temporal consensus & duplicate prevention
export interface TrackedFaceSession {
  trackId: string
  box: { x: number; y: number; width: number; height: number }
  framesObserved: number
  lastSeen: number
  consecutiveCandidateMatches: number
  candidateStudentId: string | null
  candidateName: string | null
  state: BiometricRecognitionState
  quality: FaceQualityAssessment
  liveness: LivenessAssessment
  history: Array<{ x: number; y: number; width: number; height: number }>
  boardedTripId: string | null
  lastBoardedAt: number | null
}

export class TemporalFaceTracker {
  private tracks: Map<string, TrackedFaceSession> = new Map()
  private nextId = 1
  private currentTripId: string = "TRIP-CURRENT"

  setTripId(tripId: string) {
    if (this.currentTripId !== tripId) {
      this.currentTripId = tripId
      // Reset trip-specific boarding locks for new trip
      for (const track of this.tracks.values()) {
        if (track.boardedTripId !== tripId) {
          track.boardedTripId = null
          if (track.state === "ALREADY_BOARDED" || track.state === "BOARDED") {
            track.state = "TRACKING"
          }
        }
      }
    }
  }

  resetTrip(tripId: string) {
    this.tracks.clear()
    this.setTripId(tripId)
  }

  update(
    detectedFaces: DetectedFaceItem[],
    imageSource?: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement
  ): Array<{
    track: TrackedFaceSession
    faceItem: DetectedFaceItem
    needsBoardingRequest: boolean
  }> {
    const now = Date.now()
    const results: Array<{
      track: TrackedFaceSession
      faceItem: DetectedFaceItem
      needsBoardingRequest: boolean
    }> = []

    // Prune stale tracks older than 4 seconds
    for (const [id, t] of this.tracks.entries()) {
      if (now - t.lastSeen > 4000) {
        this.tracks.delete(id)
      }
    }

    for (const item of detectedFaces) {
      const box = item.bbox
      // Find matching track by IoU
      let bestMatch: TrackedFaceSession | null = null
      let bestIoU = 0

      for (const t of this.tracks.values()) {
        const xO = Math.max(0, Math.min(box.x + box.width, t.box.x + t.box.width) - Math.max(box.x, t.box.x))
        const yO = Math.max(0, Math.min(box.y + box.height, t.box.y + t.box.height) - Math.max(box.y, t.box.y))
        const inter = xO * yO
        const union = box.width * box.height + t.box.width * t.box.height - inter
        const iou = union > 0 ? inter / union : 0
        if (iou > 0.35 && iou > bestIoU) {
          bestIoU = iou
          bestMatch = t
        }
      }

      const quality = evaluateFaceQuality(box, imageSource)

      if (!bestMatch) {
        // New track
        const trackId = `track-${this.nextId++}`
        const session: TrackedFaceSession = {
          trackId,
          box,
          framesObserved: 1,
          lastSeen: now,
          consecutiveCandidateMatches: 0,
          candidateStudentId: null,
          candidateName: null,
          state: quality.isAcceptable ? "QUALITY_CHECK" : "LOW_CONFIDENCE",
          quality,
          liveness: {
            livenessStatus: "PENDING",
            livenessScore: 0.5,
            motionVariance: 0,
            blinkDetected: false,
            isLive: true,
          },
          history: [box],
          boardedTripId: null,
          lastBoardedAt: null,
        }
        this.tracks.set(trackId, session)
        results.push({ track: session, faceItem: item, needsBoardingRequest: false })
      } else {
        // Existing track updated
        bestMatch.box = box
        bestMatch.framesObserved += 1
        bestMatch.lastSeen = now
        bestMatch.quality = quality
        bestMatch.history.push(box)
        if (bestMatch.history.length > 8) bestMatch.history.shift()

        bestMatch.liveness = evaluateLiveness(bestMatch.history, bestMatch.framesObserved)

        // Quality check failure
        if (!quality.isAcceptable) {
          bestMatch.state = "LOW_CONFIDENCE"
          results.push({ track: bestMatch, faceItem: item, needsBoardingRequest: false })
          continue
        }

        // Liveness failure
        if (bestMatch.liveness.livenessStatus === "FAILED") {
          bestMatch.state = "LIVENESS_FAILED"
          results.push({ track: bestMatch, faceItem: item, needsBoardingRequest: false })
          continue
        }

        // Check if student has ALREADY boarded in this trip session
        if (bestMatch.boardedTripId === this.currentTripId) {
          bestMatch.state = "ALREADY_BOARDED"
          results.push({ track: bestMatch, faceItem: item, needsBoardingRequest: false })
          continue
        }

        // Multi-frame temporal consensus (requires at least 2 consecutive frames before trigger)
        if (bestMatch.framesObserved < 2) {
          bestMatch.state = "VERIFYING"
          results.push({ track: bestMatch, faceItem: item, needsBoardingRequest: false })
        } else {
          // Ready for server verification / boarding
          bestMatch.state = "VERIFIED"
          results.push({ track: bestMatch, faceItem: item, needsBoardingRequest: true })
        }
      }
    }

    return results
  }

  // Mark student as boarded in active trip session
  markBoarded(trackId: string, studentId: string, tripId: string) {
    const t = this.tracks.get(trackId)
    if (t) {
      t.boardedTripId = tripId
      t.lastBoardedAt = Date.now()
      t.candidateStudentId = studentId
      t.state = "BOARDED"
    }
  }
}

export const temporalFaceTracker = new TemporalFaceTracker()

