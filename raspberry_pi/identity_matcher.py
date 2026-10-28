"""
Smart Bus IoT — Local Identity Matcher

Implements the UNKNOWN / AMBIGUOUS / RECOGNIZED decision against a set of
enrolled student templates, using cosine similarity and configurable
thresholds (never a single hard-coded cutoff — see device_manager.py, which
sources these from the server-issued config).

SCOPE NOTE — this is a real, independently-tested decision engine, but it
currently has no live data feed: there is no server endpoint yet that syncs
enrolled student templates down to the Pi (see docs/IOT_ARCHITECTURE.md,
"Known gaps"). Until that exists, `LocalIdentityMatcher.templates` stays
empty and every call correctly returns UNKNOWN — which is the safe default,
not a bug. The server remains the sole authority for the actual
entry/exit decision regardless (see "Security model" in
docs/IOT_ARCHITECTURE.md) — this class is for optional on-device
pre-feedback (e.g. instant LED/buzzer response before the network round
trip completes), never a replacement for server-side authorization.
"""

import logging
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from face_engine import cosine_similarity

logger = logging.getLogger("SmartBusIoT.IdentityMatcher")


@dataclass
class MatchResult:
    status: str  # "RECOGNIZED" | "UNKNOWN" | "AMBIGUOUS"
    student_id: Optional[str]
    similarity: float
    second_best_similarity: float
    confidence: str  # "HIGH" | "LOW" | "NONE"


class LocalIdentityMatcher:
    def __init__(
        self,
        face_match_threshold: float = 0.62,
        high_confidence_threshold: float = 0.78,
        ambiguous_margin: float = 0.05,
    ):
        self.face_match_threshold = face_match_threshold
        self.high_confidence_threshold = high_confidence_threshold
        self.ambiguous_margin = ambiguous_margin
        self.templates: Dict[str, List[float]] = {}

    def sync_templates(self, templates: Dict[str, List[float]]):
        """Replaces the local template cache. Call this once a real template-sync endpoint exists."""
        self.templates = dict(templates)
        logger.info("Local identity templates synced: %d students", len(self.templates))

    def update_thresholds(self, face_match_threshold=None, high_confidence_threshold=None, ambiguous_margin=None):
        if face_match_threshold is not None:
            self.face_match_threshold = face_match_threshold
        if high_confidence_threshold is not None:
            self.high_confidence_threshold = high_confidence_threshold
        if ambiguous_margin is not None:
            self.ambiguous_margin = ambiguous_margin

    def match(self, embedding: List[float]) -> MatchResult:
        """
        Never guesses: returns UNKNOWN below the match threshold, AMBIGUOUS
        when the top two candidates are too close to call, RECOGNIZED
        (with a HIGH/LOW confidence label) only when a single candidate
        clearly wins.
        """
        if not self.templates:
            return MatchResult(status="UNKNOWN", student_id=None, similarity=0.0,
                                second_best_similarity=0.0, confidence="NONE")

        scored: List[Tuple[str, float]] = [
            (student_id, cosine_similarity(embedding, template))
            for student_id, template in self.templates.items()
        ]
        scored.sort(key=lambda pair: pair[1], reverse=True)

        best_id, best_score = scored[0]
        second_score = scored[1][1] if len(scored) > 1 else -1.0

        if best_score < self.face_match_threshold:
            return MatchResult("UNKNOWN", None, best_score, second_score, "NONE")

        if (best_score - second_score) < self.ambiguous_margin and second_score >= self.face_match_threshold:
            # Two candidates too close to safely tell apart -- refuse to guess.
            return MatchResult("AMBIGUOUS", None, best_score, second_score, "LOW")

        confidence = "HIGH" if best_score >= self.high_confidence_threshold else "LOW"
        return MatchResult("RECOGNIZED", best_id, best_score, second_score, confidence)
