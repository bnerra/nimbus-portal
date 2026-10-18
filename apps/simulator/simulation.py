"""The simulation itself: turns "time passing" into fake feed metrics.

This file is pure logic. It never touches the database, which makes it
easy to run on its own (see the preview at the bottom) and easy to test.
Randomness comes in through an `rng` parameter instead of the global
`random` module: the same dependency-injection idea as createApp(deps),
so a test can pass in a seeded generator and get repeatable results.
"""

import random
from dataclasses import dataclass

from models import Feed, Metric

# On average, how often a healthy feed starts an incident on any given tick.
# 0.004 per tick, across 8 feeds at 1 tick per second, is roughly one new
# incident every 30 seconds somewhere in the catalog.
INCIDENT_CHANCE_PER_TICK = 0.004

# Incident kinds, and how likely each is when one starts.
INCIDENT_WEIGHTS = {
    "latency_spike": 0.5,  # data still flows, but slowly
    "gaps": 0.35,  # data flows, but some messages go missing
    "outage": 0.15,  # nothing at all
}


@dataclass
class Incident:
    kind: str
    ticks_remaining: int


@dataclass
class FeedState:
    """Everything the simulator remembers about one feed between ticks."""

    feed: Feed
    base_latency_us: int
    base_rate: int
    sequence_number: int = 0
    incident: Incident | None = None


def initial_state(feed: Feed) -> FeedState:
    """Pick this feed's "normal" latency and message rate.

    The generator is seeded with the feed code, so NYSE-INT gets the same
    normal values every time the simulator starts. That keeps charts
    believable across restarts instead of every feed jumping around.
    """
    per_feed_rng = random.Random(feed.code)
    return FeedState(
        feed=feed,
        base_latency_us=per_feed_rng.randint(20, 150),
        base_rate=per_feed_rng.randint(20_000, 200_000),
    )


def next_metric(state: FeedState, tick_seconds: float, rng: random.Random) -> Metric:
    """Advance one feed by one tick and return the metric to record.

    Mutates `state` (sequence number, incident countdown) on purpose:
    the state object is this feed's memory from one tick to the next.
    """
    _update_incident(state, rng)

    kind = state.incident.kind if state.incident else None

    # --- Outage: nothing arrives, nothing to measure ----------------------
    if kind == "outage":
        _count_down_incident(state)
        return Metric(
            feed_id=state.feed.id,
            status="down",
            latency_us=None,
            messages_per_sec=0,
            sequence_number=state.sequence_number,  # stuck where it stopped
            gap_count=0,
        )

    # --- Normal-ish traffic, with a little natural jitter ------------------
    rate = max(1, round(state.base_rate * rng.uniform(0.85, 1.15)))
    latency = max(1, round(state.base_latency_us * rng.gauss(1.0, 0.1)))
    status = "up"
    gap_count = 0

    if kind == "latency_spike":
        latency = round(latency * rng.uniform(5, 20))
        status = "degraded"
    elif kind == "gaps":
        # Some fraction of this tick's messages never arrived.
        gap_count = max(1, round(rate * tick_seconds * rng.uniform(0.001, 0.02)))
        status = "degraded"

    # The sequence number advances by every message the exchange SENT,
    # including the missed ones. That jump is exactly how a receiver
    # notices a gap: it expected N+1 and got N+5.
    delivered = round(rate * tick_seconds)
    state.sequence_number += delivered + gap_count

    _count_down_incident(state)
    return Metric(
        feed_id=state.feed.id,
        status=status,
        latency_us=latency,
        messages_per_sec=rate,
        sequence_number=state.sequence_number,
        gap_count=gap_count,
    )


def _update_incident(state: FeedState, rng: random.Random) -> None:
    """End a finished incident, or maybe start a new one."""
    if state.incident and state.incident.ticks_remaining <= 0:
        state.incident = None  # recovered

    if state.incident is None and rng.random() < INCIDENT_CHANCE_PER_TICK:
        kind = rng.choices(
            list(INCIDENT_WEIGHTS.keys()),
            weights=list(INCIDENT_WEIGHTS.values()),
        )[0]
        state.incident = Incident(kind=kind, ticks_remaining=rng.randint(5, 30))


def _count_down_incident(state: FeedState) -> None:
    if state.incident:
        state.incident.ticks_remaining -= 1


# --- Preview: python simulation.py ------------------------------------------
# Runs the simulation for one made-up feed, forcing one of each incident kind,
# and prints what each tick would record. No database needed.
if __name__ == "__main__":
    from uuid import uuid4

    demo_rng = random.Random(42)  # fixed seed: same output every run
    state = initial_state(Feed(id=uuid4(), code="DEMO-FEED"))
    print(f"DEMO-FEED normal: ~{state.base_latency_us} µs, ~{state.base_rate:,} msg/s\n")
    print(f"{'tick':>4}  {'status':<9} {'latency_us':>10} {'msg/s':>8} {'gaps':>5} {'sequence':>12}")

    for tick in range(1, 31):
        if tick == 8:
            state.incident = Incident(kind="latency_spike", ticks_remaining=4)
        if tick == 18:
            state.incident = Incident(kind="outage", ticks_remaining=5)
        if tick == 26:
            state.incident = Incident(kind="gaps", ticks_remaining=3)

        m = next_metric(state, tick_seconds=1.0, rng=demo_rng)
        latency = "-" if m.latency_us is None else str(m.latency_us)
        print(
            f"{tick:>4}  {m.status:<9} {latency:>10} {m.messages_per_sec:>8,} "
            f"{m.gap_count:>5} {m.sequence_number:>12,}"
        )