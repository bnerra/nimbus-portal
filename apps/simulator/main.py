"""Entry point: python main.py

Every tick (TICK_SECONDS), generate one metric per feed and write them to
Postgres. Runs until you press Ctrl+C.
"""

import random
import signal
import sys
import threading
import time

import psycopg

from config import Config, load_config
from db import connect, delete_old_metrics, insert_metrics, last_sequence_numbers, load_feeds
from simulation import FeedState, initial_state, next_metric

# Delete old rows once a minute (at 1 tick/second), not on every tick.
CLEANUP_EVERY_N_TICKS = 60

# Set by Ctrl+C (SIGINT) or a stop request (SIGTERM). The loop checks it.
stop_requested = threading.Event()


def request_stop(signum: int, _frame: object) -> None:
    print(f"\n{signal.Signals(signum).name} received, finishing the current tick and stopping...")
    stop_requested.set()


def main() -> None:
    config = load_config()

    # Instead of Python's default (crash with KeyboardInterrupt wherever the
    # code happens to be), just raise a flag and let the loop exit cleanly.
    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    try:
        conn = connect(config.database_url)
    except psycopg.OperationalError as error:
        print(f"Could not connect to the database: {error}", file=sys.stderr)
        print("Is Docker running? Try `npm run infra:up` from the repo root.", file=sys.stderr)
        sys.exit(1)

    with conn:
        feeds = load_feeds(conn)
        if not feeds:
            print("No feeds found. Did you run `npm run db:seed`?")
            return

        states = [initial_state(feed) for feed in feeds]

        # Resume each feed's sequence number from the last row we wrote.
        last_seen = last_sequence_numbers(conn)
        for state in states:
            state.sequence_number = last_seen.get(state.feed.id, 0)

        deleted = delete_old_metrics(conn, config.retention_minutes)
        print(
            f"Simulating {len(states)} feeds every {config.tick_seconds}s "
            f"(keeping {config.retention_minutes} min of history; removed {deleted} old rows)."
        )
        print("Press Ctrl+C to stop.\n")

        try:
            run(conn, states, config)
        except psycopg.OperationalError as error:
            # Postgres went away mid-run (e.g. `docker compose stop postgres`).
            print(f"\nLost the database connection: {error}", file=sys.stderr)
            sys.exit(1)

    print("Simulator stopped.")


def run(conn: psycopg.Connection, states: list[FeedState], config: Config) -> None:
    rng = random.Random()  # unseeded: different every run
    last_status = {state.feed.id: "up" for state in states}

    tick = 0
    started = time.monotonic()

    while not stop_requested.is_set():
        tick += 1
        metrics = [next_metric(state, config.tick_seconds, rng) for state in states]
        insert_metrics(conn, metrics)

        # Only print when something changes, so the terminal stays readable.
        for state, metric in zip(states, metrics):
            previous = last_status[state.feed.id]
            if metric.status != previous:
                reason = f" ({state.incident.kind})" if state.incident else " (recovered)"
                print(f"[tick {tick}] {state.feed.code}: {previous} -> {metric.status}{reason}")
                last_status[state.feed.id] = metric.status

        if tick % CLEANUP_EVERY_N_TICKS == 0:
            deleted = delete_old_metrics(conn, config.retention_minutes)
            print(f"[tick {tick}] wrote {tick * len(states):,} rows so far; removed {deleted} old rows")

        # Wait until the next tick is due. Scheduling from a fixed start time
        # (instead of sleeping a flat TICK_SECONDS) stops small delays from
        # adding up, so tick 3600 really happens about an hour after tick 1.
        next_tick_at = started + tick * config.tick_seconds
        stop_requested.wait(timeout=max(0.0, next_tick_at - time.monotonic()))


if __name__ == "__main__":
    main()