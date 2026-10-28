/**
 * Smart Bus IoT — Embedding Specification (TypeScript / Node side)
 *
 * Mirrors docs/EMBEDDING_SPEC.md exactly. That doc is the canonical
 * human-readable source of truth; this file and
 * raspberry_pi/embedding_spec.py are its two machine-readable copies.
 * There is no shared build system between Python and TypeScript in this
 * repo, so keeping these two files in sync is a MANUAL responsibility —
 * if you change one, change the other and docs/EMBEDDING_SPEC.md in the
 * same commit. A mismatch between them silently reintroduces the
 * embedding-space-mismatch bug this spec exists to prevent.
 */

export const MODEL_NAME = "w600k_mbf"
export const MODEL_FAMILY = "arcface-insightface-buffalo_sc"
export const MODEL_VERSION = "arcface-w600k_mbf-v1" // bump on ANY change below; never reinterpret old embeddings under a new spec
export const PREPROCESSING_VERSION = "1.0"
export const ALIGNMENT_VERSION = "none-v1" // honest: no landmark-based alignment yet, see docs/EMBEDDING_SPEC.md

export const EMBEDDING_DIMENSION = 512
export const INPUT_SIZE = 112 // pixels, square
export const INPUT_COLOR_ORDER = "RGB"
export const NORMALIZATION_METHOD = "l2" // applied to the OUTPUT embedding
export const PREPROCESS_MEAN = 127.5
export const PREPROCESS_STD = 128.0

export const DEFAULT_MODEL_PATH = "raspberry_pi/models/face_embedding.onnx" // relative to repo root

export interface EmbeddingMetadata {
  model_name: string
  model_family: string
  model_version: string
  embedding_dimension: number
  preprocessing_version: string
  alignment_version: string
  embedding_normalization: string
  production_ready: boolean
}

/** The metadata object stored alongside every real embedding produced under this spec. */
export function specMetadata(): EmbeddingMetadata {
  return {
    model_name: MODEL_NAME,
    model_family: MODEL_FAMILY,
    model_version: MODEL_VERSION,
    embedding_dimension: EMBEDDING_DIMENSION,
    preprocessing_version: PREPROCESSING_VERSION,
    alignment_version: ALIGNMENT_VERSION,
    embedding_normalization: NORMALIZATION_METHOD,
    production_ready: true,
  }
}

/**
 * True only if the given metadata was produced under THIS exact spec
 * version. Anything else (missing metadata, an old model_version, a
 * different embedding_dimension) must be treated as not comparable to a
 * real embedding — see docs/FACE_RECOGNITION.md, "Migration".
 */
export function isSpecCompliant(metadata: Partial<EmbeddingMetadata> | null | undefined): boolean {
  if (!metadata) return false
  return (
    metadata.model_version === MODEL_VERSION &&
    metadata.embedding_dimension === EMBEDDING_DIMENSION &&
    metadata.production_ready === true
  )
}
