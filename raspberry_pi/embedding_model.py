"""Shared 512-D ONNX face embedder for the Smart Bus project."""

import logging
import os
from typing import Any, Dict, List, Optional

import numpy as np
import cv2
import onnxruntime as ort

try:
    from . import embedding_spec as spec
except ImportError:
    import embedding_spec as spec

logger = logging.getLogger("SmartBusIoT.EmbeddingModel")


def _l2_normalize(vec: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(vec)
    return vec / norm if norm > 1e-9 else vec


def _seeded_random_projection(input_dim: int, output_dim: int, seed: int = 1337) -> np.ndarray:
    """
    Fixed (deterministic) Gaussian random projection matrix. Used ONLY by
    the non-production HOGLBPEmbedder to reach the spec's dimension for
    pipeline-testing purposes -- never applied to the real ONNX model's
    native output (see docs/EMBEDDING_SPEC.md: forcing a real model's
    output through an unrelated projection just to hit a schema number is
    exactly the anti-pattern this spec exists to avoid).
    """
    rng = np.random.default_rng(seed)
    mat = rng.standard_normal((input_dim, output_dim)).astype(np.float32)
    mat /= np.linalg.norm(mat, axis=0, keepdims=True)
    return mat




class EmbeddingModel:
    model_name = spec.MODEL_NAME
    model_version = spec.MODEL_VERSION
    embedding_dim = spec.EMBEDDING_DIMENSION
    normalization = "l2"
    production_ready = True

    def embed_batch(self, face_chips: List[np.ndarray]) -> List[List[float]]:
        raise NotImplementedError

    def embed(self, face_chip: np.ndarray) -> List[float]:
        return self.embed_batch([face_chip])[0]

    def metadata(self) -> Dict[str, Any]:
        return {
            "model_name": self.model_name,
            "model_family": spec.MODEL_FAMILY,
            "model_version": self.model_version,
            "embedding_dimension": self.embedding_dim,
            "preprocessing_version": spec.PREPROCESSING_VERSION,
            "alignment_version": spec.ALIGNMENT_VERSION,
            "embedding_normalization": self.normalization,
            "production_ready": self.production_ready,
        }


class ONNXFaceEmbedder(EmbeddingModel):
    """Runs the shared ArcFace-family model using the canonical preprocessing."""

    def __init__(self, model_path: str):
        self.model_path = os.path.abspath(model_path)

        if not os.path.isfile(self.model_path):
            raise FileNotFoundError(
                f"Face embedding model not found: {self.model_path}"
            )

        self.session = ort.InferenceSession(
            self.model_path,
            providers=["CPUExecutionProvider"],
        )

        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name

        input_shape = self.session.get_inputs()[0].shape
        output_shape = self.session.get_outputs()[0].shape

        if len(input_shape) != 4 or input_shape[1:] != [
            3, spec.INPUT_SIZE, spec.INPUT_SIZE
        ]:
            raise ValueError(
                f"Unexpected ONNX input shape {input_shape}; "
                "expected [N, 3, 112, 112]."
            )

        if output_shape[-1] != spec.EMBEDDING_DIMENSION:
            raise ValueError(
                f"Model output shape {output_shape} is not "
                f"{spec.EMBEDDING_DIMENSION}-D."
            )

        logger.info(
            "Loaded shared face model: %s; input=%s; output=%s",
            self.model_path,
            input_shape,
            output_shape,
        )

    def embed_batch(self, face_chips: List[np.ndarray]) -> List[List[float]]:
        if not face_chips:
            return []

        results = []

        # Run one face at a time because this ONNX model may have a
        # fixed batch-size output. The public API still accepts batches.
        for chip in face_chips:
            if chip is None or not isinstance(chip, np.ndarray) or chip.size == 0:
                raise ValueError("Cannot embed an empty or invalid face crop.")

            if chip.ndim != 3 or chip.shape[2] != 3:
                raise ValueError(
                    f"Expected a three-channel color crop; got shape {chip.shape}."
                )

            # OpenCV camera frames/crops are BGR; the canonical model uses RGB.
            rgb = cv2.cvtColor(chip, cv2.COLOR_BGR2RGB)

            resized = cv2.resize(
                rgb,
                (spec.INPUT_SIZE, spec.INPUT_SIZE),
                interpolation=cv2.INTER_LINEAR,
            )

            # HWC RGB uint8 -> NCHW float32, normalized as (pixel - 127.5)/128.
            tensor = resized.astype(np.float32)
            tensor = (tensor - spec.PREPROCESS_MEAN) / spec.PREPROCESS_STD
            tensor = np.transpose(tensor, (2, 0, 1))[np.newaxis, ...]

            output = self.session.run(
                [self.output_name],
                {self.input_name: np.ascontiguousarray(tensor)},
            )[0]

            vector = np.asarray(output, dtype=np.float32).reshape(-1)

            if vector.size != spec.EMBEDDING_DIMENSION:
                raise ValueError(
                    f"Expected {spec.EMBEDDING_DIMENSION} embedding values; "
                    f"model returned {vector.size}."
                )

            if not np.all(np.isfinite(vector)):
                raise ValueError("Model produced non-finite embedding values.")

            norm = float(np.linalg.norm(vector))
            if norm <= 1e-12:
                raise ValueError("Model produced a zero-length embedding.")

            vector = vector / norm
            results.append(np.round(vector, 5).tolist())

        return results


class HOGLBPEmbedder(EmbeddingModel):
    """
    Dev/testing embedding derived from a face crop's gradient structure
    (HOG) and local texture (LBP), concatenated and projected to the spec's
    dimension so it can flow through the same pipeline/schema as a real
    model. This is a classical (pre-deep-learning) computer vision
    technique -- LBPH specifically is a long-established, published face
    recognition method (Ahonen et al., 2004) shipped in OpenCV's `cv2.face`
    module for exactly this purpose -- but it is NOT a deep neural network,
    measurably does not separate genuine/impostor faces well enough for
    biometric access control (~20% FAR/FRR at best operating point, see
    docs/FACE_ACCURACY_CALIBRATION.md), and MUST NOT be used as the
    production identity source. `production_ready = False` is enforced
    here and checked by callers (identity_matcher.py, main.py) so a
    RECOGNIZED result from this embedder is never treated as a real
    biometric match.
    """

    model_name = "hog-lbp-classical-cv"
    model_version = "1.0"
    normalization = "l2"
    production_ready = False

    def __init__(self, chip_size: int = 64):
        self.chip_size = chip_size
        self.embedding_dim = spec.EMBEDDING_DIMENSION

        self._hog = None
        if cv2 is not None:
            win = (chip_size, chip_size)
            block = (16, 16)
            block_stride = (8, 8)
            cell = (8, 8)
            nbins = 9
            self._hog = cv2.HOGDescriptor(win, block, block_stride, cell, nbins)
            probe = self._hog.compute(np.zeros((chip_size, chip_size), dtype=np.uint8))
            hog_dim = int(probe.shape[0])
        else:
            hog_dim = 0
            logger.error("OpenCV unavailable; HOGLBPEmbedder cannot compute real features.")

        lbp_dim = 256
        self._raw_dim = hog_dim + lbp_dim
        self._projection = (
            _seeded_random_projection(self._raw_dim, self.embedding_dim) if self._raw_dim else None
        )

    def _lbp_histogram(self, gray_chip: np.ndarray) -> np.ndarray:
        """Vectorized 3x3, 8-neighbor LBP histogram (no skimage dependency)."""
        img = gray_chip.astype(np.int16)
        h, w = img.shape
        center = img[1:h - 1, 1:w - 1]
        offsets = [(-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1)]
        code = np.zeros_like(center, dtype=np.uint8)
        for bit, (dy, dx) in enumerate(offsets):
            neighbor = img[1 + dy: h - 1 + dy, 1 + dx: w - 1 + dx]
            code |= ((neighbor >= center).astype(np.uint8)) << bit
        hist, _ = np.histogram(code, bins=256, range=(0, 256))
        hist = hist.astype(np.float32)
        hist_sum = hist.sum()
        return hist / hist_sum if hist_sum > 0 else hist

    def _extract_raw(self, face_chip: np.ndarray) -> np.ndarray:
        if cv2 is None or face_chip is None or face_chip.size == 0:
            return np.zeros(self._raw_dim, dtype=np.float32)

        if face_chip.ndim == 3:
            gray = cv2.cvtColor(face_chip, cv2.COLOR_BGR2GRAY)
        else:
            gray = face_chip

        resized = cv2.resize(gray, (self.chip_size, self.chip_size), interpolation=cv2.INTER_AREA)
        resized = cv2.equalizeHist(resized)

        hog_feat = self._hog.compute(resized).flatten()
        lbp_feat = self._lbp_histogram(resized)
        return np.concatenate([hog_feat, lbp_feat]).astype(np.float32)

    def embed_batch(self, face_chips: List[np.ndarray]) -> List[List[float]]:
        if self._projection is None:
            return [[0.0] * self.embedding_dim for _ in face_chips]

        raw_batch = (
            np.stack([self._extract_raw(chip) for chip in face_chips])
            if face_chips else np.zeros((0, self._raw_dim))
        )
        raw_batch = np.array([_l2_normalize(v) for v in raw_batch])
        projected = raw_batch @ self._projection
        projected = np.array([_l2_normalize(v) for v in projected])
        return [np.round(v, 5).tolist() for v in projected]


# ---------------------------------------------------------------------------
# Backend 2: real deep embedding model via ONNX Runtime, per
# docs/EMBEDDING_SPEC.md. Correctly implemented, but UNTESTED against real
# weights in this environment (no network here to fetch the model file).
# production_ready=True once actually loaded -- this is the ONLY backend
# that should ever be treated as a real biometric identity source.
# ---------------------------------------------------------------------------



def build_default_embedder(model_path: Optional[str] = None) -> EmbeddingModel:
    if model_path:
        resolved_path = model_path
    else:
        resolved_path = os.path.join(
            os.path.dirname(__file__),
            "models",
            "face_embedding.onnx",
        )

    # Fail explicitly instead of silently using an incompatible 128-D model.
    return ONNXFaceEmbedder(resolved_path)
