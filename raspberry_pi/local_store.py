"""
Smart Bus IoT — Local Store-and-Forward Queue

Persists events to SQLite on the Pi's local storage (SSD/eMMC/SD card) so that
GPS, entry, and exit events are never lost when the bus loses connectivity.
Extracted out of api_client.py so the persistence layer can be reasoned about,
tested, and swapped (e.g. for a different embedded DB) independently of the
HTTP transport.

Design notes:
- Every row has a globally unique event_id (UUID4), enforced UNIQUE at the
  DB level, so re-enqueuing the same event_id is a no-op (INSERT OR IGNORE).
- Failed sync attempts use exponential backoff (base * 2^retry_count, capped)
  via a `next_retry_at` column, so a flaky connection doesn't hammer the
  server every `batch_sync_interval_sec` with the same doomed request.
- All access is guarded by a threading.Lock because the vision loop thread
  and the background sync thread both touch the same SQLite file.
"""

import json
import logging
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("SmartBusIoT.LocalStore")


class LocalEventStore:
    def __init__(
        self,
        db_path: str = "iot_events_queue.db",
        retry_backoff_base_sec: float = 5.0,
        retry_backoff_max_sec: float = 300.0,
        max_retry_count: int = 50,
    ):
        self.db_path = db_path
        self.retry_backoff_base_sec = retry_backoff_base_sec
        self.retry_backoff_max_sec = retry_backoff_max_sec
        self.max_retry_count = max_retry_count
        self._lock = threading.Lock()
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self):
        with self._lock:
            conn = self._connect()
            cur = conn.cursor()
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS queued_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT UNIQUE,
                    event_type TEXT,
                    payload TEXT,
                    created_at TEXT,
                    retry_count INTEGER DEFAULT 0,
                    next_retry_at TEXT,
                    last_error TEXT,
                    dead_letter INTEGER DEFAULT 0
                )
                """
            )
            # Lightweight migration for DBs created before backoff columns existed.
            existing_cols = {row[1] for row in cur.execute("PRAGMA table_info(queued_events)").fetchall()}
            for col, ddl in (
                ("next_retry_at", "ALTER TABLE queued_events ADD COLUMN next_retry_at TEXT"),
                ("last_error", "ALTER TABLE queued_events ADD COLUMN last_error TEXT"),
                ("dead_letter", "ALTER TABLE queued_events ADD COLUMN dead_letter INTEGER DEFAULT 0"),
            ):
                if col not in existing_cols:
                    cur.execute(ddl)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_queued_next_retry ON queued_events(next_retry_at)")
            conn.commit()
            conn.close()

    @staticmethod
    def new_event_id() -> str:
        return str(uuid.uuid4())

    def enqueue(self, event_id: Optional[str], event_type: str, payload: Dict[str, Any]) -> str:
        """Persists an event. Idempotent on event_id — re-enqueuing is a no-op."""
        event_id = event_id or self.new_event_id()
        with self._lock:
            try:
                conn = self._connect()
                conn.execute(
                    """
                    INSERT OR IGNORE INTO queued_events
                        (event_id, event_type, payload, created_at, retry_count, next_retry_at)
                    VALUES (?, ?, ?, ?, 0, ?)
                    """,
                    (
                        event_id,
                        event_type,
                        json.dumps(payload),
                        datetime.now(timezone.utc).isoformat(),
                        datetime.now(timezone.utc).isoformat(),
                    ),
                )
                conn.commit()
                conn.close()
                logger.info("Queued offline event: %s (%s)", event_id, event_type)
            except Exception as e:
                logger.error("Failed to enqueue offline event %s: %s", event_id, e)
        return event_id

    def due_batch(self, max_batch_size: int = 25) -> List[sqlite3.Row]:
        """Returns the oldest events whose backoff window has elapsed and are not dead-lettered."""
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._lock:
            conn = self._connect()
            rows = conn.execute(
                """
                SELECT id, event_id, event_type, payload, retry_count
                FROM queued_events
                WHERE dead_letter = 0
                  AND (next_retry_at IS NULL OR next_retry_at <= ?)
                ORDER BY id ASC
                LIMIT ?
                """,
                (now_iso, max_batch_size),
            ).fetchall()
            conn.close()
        return rows

    def mark_synced(self, row_ids: List[int]):
        """Removes successfully acknowledged events from the queue."""
        if not row_ids:
            return
        with self._lock:
            conn = self._connect()
            conn.execute(
                f"DELETE FROM queued_events WHERE id IN ({','.join(['?'] * len(row_ids))})",
                row_ids,
            )
            conn.commit()
            conn.close()

    def mark_failed(self, row_id: int, retry_count: int, error: str = ""):
        """
        Bumps retry_count and schedules the next attempt with exponential backoff:
        delay = min(base * 2^retry_count, max). Past max_retry_count, the event is
        dead-lettered (kept for inspection, excluded from further sync attempts)
        rather than retried forever or silently dropped.
        """
        new_retry_count = retry_count + 1
        delay_sec = min(self.retry_backoff_base_sec * (2 ** retry_count), self.retry_backoff_max_sec)
        next_retry = datetime.now(timezone.utc).timestamp() + delay_sec
        next_retry_iso = datetime.fromtimestamp(next_retry, tz=timezone.utc).isoformat()
        dead_letter = 1 if new_retry_count > self.max_retry_count else 0

        with self._lock:
            conn = self._connect()
            conn.execute(
                """
                UPDATE queued_events
                SET retry_count = ?, next_retry_at = ?, last_error = ?, dead_letter = ?
                WHERE id = ?
                """,
                (new_retry_count, next_retry_iso, str(error)[:500], dead_letter, row_id),
            )
            conn.commit()
            conn.close()

        if dead_letter:
            logger.error(
                "Event row %d exceeded max_retry_count (%d); moved to dead-letter state.",
                row_id, self.max_retry_count,
            )
        else:
            logger.debug("Row %d will retry in %.1fs (attempt %d)", row_id, delay_sec, new_retry_count)

    def pending_count(self, include_dead_letter: bool = False) -> int:
        with self._lock:
            conn = self._connect()
            if include_dead_letter:
                count = conn.execute("SELECT COUNT(*) FROM queued_events").fetchone()[0]
            else:
                count = conn.execute("SELECT COUNT(*) FROM queued_events WHERE dead_letter = 0").fetchone()[0]
            conn.close()
        return int(count)

    def dead_letter_count(self) -> int:
        with self._lock:
            conn = self._connect()
            count = conn.execute("SELECT COUNT(*) FROM queued_events WHERE dead_letter = 1").fetchone()[0]
            conn.close()
        return int(count)
