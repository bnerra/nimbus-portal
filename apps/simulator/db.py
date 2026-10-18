"""Database helpers for the simulator."""

from uuid import UUID

import psycopg

from models import Feed, Metric


def connect(database_url: str) -> psycopg.Connection:
    # autocommit=True: each statement is saved as soon as it runs.
    # The simulator does simple one-off inserts, so it doesn't need to
    # group statements into transactions the way migrations do.
    return psycopg.connect(database_url, autocommit=True)


def load_feeds(conn: psycopg.Connection) -> list[Feed]:
    """Return every feed in the catalog, ordered by code."""
    rows = conn.execute("SELECT id, code FROM feeds ORDER BY code").fetchall()
    # Each row is a tuple like (UUID('...'), 'CME-MDP'). Unpack it into a Feed.
    return [Feed(id=feed_id, code=code) for feed_id, code in rows]


def last_sequence_numbers(conn: psycopg.Connection) -> dict[UUID, int]:
    """The most recent sequence number recorded for each feed.

    Lets the simulator pick up where it left off after a restart, instead
    of every feed's sequence jumping back to 0.
    """
    rows = conn.execute(
        """
        SELECT DISTINCT ON (feed_id) feed_id, sequence_number
        FROM feed_metrics
        ORDER BY feed_id, recorded_at DESC
        """
    ).fetchall()
    return {feed_id: sequence_number for feed_id, sequence_number in rows}


def insert_metrics(conn: psycopg.Connection, metrics: list[Metric]) -> None:
    """Write one tick's rows (one per feed) as a single transaction."""
    # All rows from the same tick land together or not at all, so the
    # dashboard never sees half a tick.
    with conn.transaction():
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO feed_metrics
                    (feed_id, status, latency_us, messages_per_sec, sequence_number, gap_count)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                [
                    (m.feed_id, m.status, m.latency_us, m.messages_per_sec,
                     m.sequence_number, m.gap_count)
                    for m in metrics
                ],
            )


def delete_old_metrics(conn: psycopg.Connection, older_than_minutes: int) -> int:
    """Delete metrics older than the retention window. Returns rows deleted."""
    cur = conn.execute(
        "DELETE FROM feed_metrics WHERE recorded_at < now() - make_interval(mins => %s)",
        (older_than_minutes,),
    )
    return cur.rowcount