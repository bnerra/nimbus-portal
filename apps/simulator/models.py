"""Plain data shapes shared by db.py and simulation.py.

Keeping them in their own file means db.py and simulation.py can both
import from here without importing from each other (which would be a
circular import: each file waiting for the other to finish loading).
"""

from dataclasses import dataclass
from uuid import UUID


@dataclass(frozen=True)
class Feed:
    id: UUID
    code: str


@dataclass
class Metric:
    """One row for the feed_metrics table."""

    feed_id: UUID
    status: str  # 'up' | 'degraded' | 'down'
    latency_us: int | None  # None when down
    messages_per_sec: int
    sequence_number: int
    gap_count: int