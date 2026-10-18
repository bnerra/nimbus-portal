# Phase 2 walkthrough: the feed simulator

Phase 2 gives the portal something to monitor. A small **Python** service pretends to be the
monitoring system for Nimbus's 8 market data feeds: once a second it records each feed's health
(status, latency, message rate, sequence number, gaps) into Postgres, and now and then it injects an
incident (a latency spike, missing messages, or an outage).

Phase 3's dashboard reads this data. Nothing in the API or web app changed in this phase.

---

## What was built

| File                                              | Purpose                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/api/migrations/002_create_feed_metrics.sql` | The `feed_metrics` table + index                                        |
| `apps/simulator/requirements.txt`                 | Python dependencies (psycopg, python-dotenv), pinned                    |
| `apps/simulator/.env.example`                     | Settings template: `DATABASE_URL`, `TICK_SECONDS`, `RETENTION_MINUTES`  |
| `apps/simulator/config.py`                        | Reads + validates settings, fails fast (twin of `config.ts`)            |
| `apps/simulator/models.py`                        | Shared data shapes: `Feed`, `Metric`                                    |
| `apps/simulator/db.py`                            | Connect, load feeds, insert metrics, resume sequences, delete old rows  |
| `apps/simulator/simulation.py`                    | Pure logic: turns one tick into one metric per feed, incidents included |
| `apps/simulator/main.py`                          | The loop: tick, write, clean up, stop gracefully on Ctrl+C / SIGTERM    |

## Running it

First time only (from `apps/simulator`, PowerShell):

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Every time (Docker running, migrations applied):

```powershell
cd apps/simulator
.venv\Scripts\Activate.ps1     # once per terminal; prompt shows (.venv)
python main.py                 # Ctrl+C to stop
python simulation.py           # preview the logic without a database
```

---

## The domain in one page

A **feed** (e.g. Nasdaq TotalView) is a non-stop stream of tiny messages covering _every_ symbol on
an exchange: hundreds of thousands per second. We don't monitor individual stocks; we monitor the
**health of the pipe**.

A **tick** is our once-a-second health snapshot of one feed (one row in `feed_metrics`), like a
fitness tracker logging your heart rate once a minute while your heart beats constantly.

| Measure            | Meaning                                                   | Why a client cares                                                                                                  |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `status`           | `up` / `degraded` / `down`                                | "Can I trust the data right now?" Pause a strategy or fail over to a backup feed                                    |
| `latency_us`       | Exchange → client delay, in microseconds (NULL when down) | Slower than competitors = acting on stale prices                                                                    |
| `messages_per_sec` | Volume that second                                        | Capacity planning; a sudden drop is often the first sign of trouble                                                 |
| `sequence_number`  | Number stamped on the last message received               | Every message is numbered 1, 2, 3…; we sample it once a second, so it jumps by that second's message count          |
| `gap_count`        | Messages that never arrived                               | Missing messages = a silently wrong order book. Detected because the sequence jumped further than what was received |

Worked gap example: sequence went 3,397,288 → 3,597,487 (200,199 sent), but only 197,433 arrived, so
**2,766 gaps**. In an outage the sequence **freezes**, since nothing is arriving.

---

## Step by step: what to notice

### Step 1: `feed_metrics` migration

- **`bigint GENERATED ALWAYS AS IDENTITY`** for the id instead of a UUID: a fast-growing, internal-only
  table benefits from small sequential keys. `bigint` because ~8 rows/s would pass the `integer` limit
  in ~8 years.
- **Whole-number microseconds** (`latency_us integer`) instead of fractional milliseconds: avoids
  floating-point rounding (`0.1 + 0.2 = 0.30000000000000004`). Money uses the same trick (cents).
- **A constraint across two columns:** `(status = 'down') = (latency_us IS NULL)`. Named with
  `CONSTRAINT ...` so violations say which rule broke.
- **Index `(feed_id, recorded_at DESC)`:** serves "latest row per feed" and "feed X over the last N
  minutes", the leftmost-column rule from Phase 1 applied to time-series data.
- **Volume:** 8 feeds × 1/s ≈ 690k rows/day, so the simulator deletes rows older than
  `RETENTION_MINUTES`. Real systems use retention policies or table partitioning.

### Step 2a: Python setup

- **Virtual environment (`.venv`)** = a private set of libraries for this project, like
  `node_modules`. Activate it once per terminal; the prompt shows `(.venv)`.
- **`requirements.txt`** ≈ `package.json` dependencies; `==` pins exact versions.
- `.venv/` and `__pycache__/` are git-ignored (recreatable, like `node_modules`).

### Step 2b: config and first connection

- `config.py` collects **all** config errors and reports them together, like zod, then `sys.exit(1)`.
- `with connect(...) as conn:` is a **context manager**: closes the connection even on errors
  (≈ `try/finally`).
- `autocommit=True`: each statement saves immediately, which suits independent writes.

### Step 2c: the simulation logic

- **Pure logic, no I/O.** `simulation.py` only does math on objects. Separating "thinking" from
  "talking to the database" makes it runnable and testable on its own (`python simulation.py`).
- **Randomness is injected (`rng`)**, the same dependency-injection idea as `createApp(deps)`. A
  seeded `random.Random(42)` gives identical output every run, which is what tests need.
- **Each feed's "normal" is seeded by its code**, so NYSE-INT keeps the same baseline across restarts.
- **Incidents:** `latency_spike` (50%) and `gaps` (35%) → `degraded`; `outage` (15%) → `down`. Each
  lasts 5–30 ticks. `INCIDENT_CHANCE_PER_TICK = 0.004` ≈ one new incident every ~30 s across 8 feeds.

### Step 2d: the loop

- **`models.py` breaks a circular import.** `db.py` needed `Metric` and `simulation.py` needed
  `Feed` from `db.py`. Shared shapes moved to a third file both can import.
- **`%s` placeholders** (psycopg) vs `$1` (node-postgres): different spelling, same SQL-injection
  safety.
- **`DISTINCT ON (feed_id) ... ORDER BY feed_id, recorded_at DESC`** = "newest row per feed", used to
  resume sequence numbers after a restart. Phase 3 reuses it for "current status of every feed".
- **One transaction per tick** (`with conn.transaction():`) so the dashboard never sees half a tick.
- **Graceful shutdown:** SIGINT (Ctrl+C) and SIGTERM (what Docker sends) set a flag; the loop finishes
  its tick and the connection closes cleanly, like the API's `shutdown()`.
- **Drift-free timing:** schedule tick N at `start + N × TICK_SECONDS` using `time.monotonic()` (a
  clock that never jumps backward) instead of sleeping a flat second each time.

### Gotchas we hit

- **A file named `.config.py`**: Python imports by exact filename, so `from config import ...` fails.
- **Pylance "Import could not be resolved"**: VS Code was checking with the global Python. Fix:
  _Python: Select Interpreter_ → `apps\simulator\.venv\Scripts\python.exe`.
- **A new terminal needs `.venv\Scripts\Activate.ps1` again**, or `python` is the global one.

---

## Explain it back

Answer out loud or in writing first, then compare with the answer key at the bottom.

1. What is a tick, and why don't we store every individual message?
2. Why do sequence numbers jump by ~150,000 between ticks, and how does that let us detect gaps?
3. Why is `simulation.py` kept free of database code, and why does it take an `rng` parameter?
4. What problem does `models.py` solve?
5. What does `DISTINCT ON` do here, and which index makes it fast?
6. Why is each tick's insert wrapped in a transaction even though the connection is autocommit?
7. What happens, step by step, when you press Ctrl+C?
8. Why does the simulator delete old rows, and what would a production system do instead?

## Change something (write it yourself)

Pick one or more:

1. **Make it configurable:** read `INCIDENT_CHANCE_PER_TICK` from `.env` (default `0.004`) through
   `config.py`, with validation.
2. **Write a test:** add `pytest` to `requirements.txt` and create `test_simulation.py`. With a seeded
   `random.Random`, force an `outage` incident and assert the metric is `down`, has `latency_us is None`
   and the sequence number didn't move. Then force `gaps` and assert
   `new_sequence - old_sequence == messages_per_sec + gap_count` (with `tick_seconds=1`).
3. **Survive a database restart:** instead of exiting on `OperationalError`, close the connection,
   wait 5 seconds, reconnect, and carry on (feed state is already in memory).
4. **A new incident kind:** e.g. `stale`, where messages arrive but the sequence number stops
   advancing (a stuck publisher). Decide its status and add it to `INCIDENT_WEIGHTS`.

## Known shortcuts (deliberate)

- **No npm script** for the simulator: the venv path differs on Windows vs Mac/Linux. Phase 7's
  Docker setup will run it the same way everywhere.
- **No automatic reconnect:** it exits cleanly on a lost connection (see exercise 3).
- **No Python tests yet** (see exercise 2).

---

## Answer key / interview answers

> **1. What is a tick?**
> "A feed is a continuous stream of hundreds of thousands of messages a second, so we don't store
> them; we monitor the pipe. A tick is a once-a-second health snapshot per feed: status, latency,
> message rate, the last sequence number seen and how many messages were missed. One row per feed
> per second is enough to chart health and detect incidents without storing the firehose."

> **2. Sequence numbers and gaps**
> "Every message the exchange sends carries an increasing sequence number. We sample the latest one
> each second, so it jumps by that second's message count. If the jump is bigger than the number of
> messages we actually received, the difference is messages that were lost: that's how gap detection
> works on real market data feeds, and it's what triggers a retransmission request."

> **3. Pure logic and injected randomness**
> "The simulation module only transforms state into metrics; all database I/O lives elsewhere. That
> keeps the logic easy to reason about and test. Randomness is passed in as a random generator, so in
> tests I can pass a seeded one and get deterministic output, the same dependency-injection idea I
> used for the API's database and Redis clients."

> **4. models.py**
> "The database module and the simulation module both needed the same data classes, and importing
> each from the other would have been circular. Moving shared types into a small module with no
> internal imports breaks the cycle and gives both sides one source of truth."

> **5. DISTINCT ON**
> "`DISTINCT ON (feed_id)` with `ORDER BY feed_id, recorded_at DESC` keeps only the newest row for
> each feed. The composite index on `(feed_id, recorded_at DESC)` matches that ordering exactly, so
> Postgres can read the first index entry per feed instead of scanning the table."

> **6. Transaction per tick**
> "Each tick writes one row per feed. Wrapping them in a transaction makes the tick atomic, so a
> reader never sees some feeds updated and others not. Autocommit is still the default for the
> simple one-off statements."

> **7. Ctrl+C**
> "Ctrl+C sends SIGINT. Instead of letting Python raise KeyboardInterrupt wherever it happens to be,
> a signal handler sets a stop flag. The loop checks it, finishes the current tick, exits, and the
> context manager closes the database connection. SIGTERM, which Docker sends, takes the same path."

> **8. Retention**
> "At eight rows a second the table grows by about 690,000 rows a day, so the simulator deletes rows
> older than a configurable window. In production you'd usually partition the table by time and drop
> old partitions, or use a time-series extension, because deleting millions of rows is expensive."
