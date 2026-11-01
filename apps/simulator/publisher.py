"""Announces "a new tick was written" on Redis Pub/Sub.

The database is the source of truth; this message is only a nudge that
says "new data is ready, go read it". So publishing is best-effort: if
Redis is down, the simulator logs it once and keeps writing to Postgres.
Nothing is lost, because anyone who missed a nudge can read the database.
"""

import json
import sys
from datetime import datetime, timezone

import redis

# The channel name is the "radio frequency". The API subscribes to the
# same name (STATUS_CHANNEL in apps/api/src/realtime/statusBroadcaster.ts).
STATUS_CHANNEL = "nimbus:feed-status"

class TickPublisher:
  def __init__(self, redis_url: str) -> None:
    # Short timeouts: a slow or missing Redis must never stall the tick loop.
    self._redis = redis.Redis.from_url(
      redis_url, socket_connect_timeout=1, socket_timeout=1
    )
    self._healthy = True

  def publish(self, tick: int) -> int:
    """Publish one nudge. Returns how many subscribers received it."""
    message = json.dumps(
      {"tick": tick, "at": datetime.now(timezone.utc).isoformat()}
    )
    try:
      listeners = self._redis.publish(STATUS_CHANNEL, message)
    except redis.RedisError as error:
      # Log only when the state CHANGES, not on every failing tick.
      if self._healthy:
        print(f"Redis unavailable, live updates paused: {error}", file=sys.stderr)
        self._healthy = False
      return 0

    if not self._healthy:
      print("Redis is back, live updates resumed.")
      self._healthy = True
    return listeners

  def close(self) -> None:
    self._redis.close()