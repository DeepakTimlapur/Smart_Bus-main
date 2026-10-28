"""Canonical Python mirror of lib/embedding-spec.ts."""

MODEL_NAME = "w600k_mbf"
MODEL_FAMILY = "arcface-insightface-buffalo_sc"
MODEL_VERSION = "arcface-w600k_mbf-v1"

EMBEDDING_DIMENSION = 512
INPUT_SIZE = 112
INPUT_COLOR_ORDER = "RGB"

PREPROCESSING_VERSION = "1.0"
ALIGNMENT_VERSION = "none-v1"

PREPROCESS_MEAN = 127.5
PREPROCESS_STD = 128.0

NORMALIZATION_METHOD = "l2"

# Retain this value only as a provisional threshold pending calibration.
DEFAULT_COSINE_THRESHOLD = 0.363

# Default model path relative to the raspberry_pi directory
DEFAULT_MODEL_PATH = "models/face_embedding.onnx"

def metadata():
    """Return metadata matching lib/embedding-spec.ts."""
    return {
        "model_name": MODEL_NAME,
        "model_family": MODEL_FAMILY,
        "model_version": MODEL_VERSION,
        "embedding_dimension": EMBEDDING_DIMENSION,
        "preprocessing_version": PREPROCESSING_VERSION,
        "alignment_version": ALIGNMENT_VERSION,
        "embedding_normalization": NORMALIZATION_METHOD,
        "production_ready": True,
    }
