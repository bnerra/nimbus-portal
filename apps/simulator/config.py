"""Simulator configuration, read from environment variables.

Same idea as apps/api/src/config.ts: read every setting once at startup,
check it, and stop immediately with a clear message if anything is wrong.
"""

import os
import sys
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass(frozen=True)
class Config:
    database_url: str
    tick_seconds: float
    retention_minutes: int


def load_config() -> Config:
    # Reads .env from the current folder into os.environ.
    # Variables already set in the real environment win over the file.
    load_dotenv()

    errors: list[str] = []

    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url.startswith(("postgres://", "postgresql://")):
        errors.append("DATABASE_URL must be set and start with postgres:// or postgresql://")

    tick_seconds = _read_number("TICK_SECONDS", default=1.0, errors=errors)
    retention_minutes = int(_read_number("RETENTION_MINUTES", default=60, errors=errors))

    if errors:
        print("Invalid simulator configuration:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        print("\nDid you copy apps/simulator/.env.example to apps/simulator/.env?", file=sys.stderr)
        sys.exit(1)

    return Config(
        database_url=database_url,
        tick_seconds=tick_seconds,
        retention_minutes=retention_minutes,
    )


def _read_number(name: str, default: float, errors: list[str]) -> float:
    """Read a positive number from the environment, or record an error."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        errors.append(f"{name} must be a number (got {raw!r})")
        return default
    if value <= 0:
        errors.append(f"{name} must be greater than 0 (got {raw!r})")
        return default
    return value