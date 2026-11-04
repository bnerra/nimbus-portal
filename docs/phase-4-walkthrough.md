# Phase 4 walkthrough: real-time updates

Phase 4 turns "the browser keeps asking" into "the server tells you". The simulator announces each
tick on **Redis Pub/Sub**, every API instance hears it, and each one **pushes** fresh status to its
browsers over **Server-Sent Events (SSE)**. Polling stays only as a fallback. It also works across
**several API instances**, which is what makes Redis worth having.

Read "The big ideas" first; the step notes assume them. Cross-project explanations (SSE vs
WebSockets, load balancer vs Redis, tenant isolation) also live in `talking-points.md`.

---

## What was built

| File                                               | Purpose                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/simulator/publisher.py`                      | `TickPublisher`: publishes a "new data" nudge after each tick (best-effort)          |
| `apps/simulator/main.py`, `config.py`              | Publish after each insert; new `REDIS_URL` setting; listener count in the minute log |
| `apps/simulator/requirements.txt`                  | + `redis`                                                                            |
| `apps/simulator/ruff.toml`, `requirements-dev.txt` | Ruff formatter/linter for the Python code                                            |
| `apps/api/src/db/feedStatus.ts`                    | The "status of every feed" query, shared by `/status` and the stream                 |
| `apps/api/src/realtime/statusBroadcaster.ts`       | Subscribes to Redis; keeps SSE clients; pushes snapshots; heartbeats; clean shutdown |
| `apps/api/src/redis.ts`                            | + `createSubscriber()`: a dedicated listening connection                             |
| `apps/api/src/routes/feeds.ts`                     | + `GET /api/feeds/status/stream`                                                     |
| `apps/api/src/index.ts`, `app.ts`                  | Create/start/close the broadcaster; pass it in as a dependency                       |
| `apps/api/test/api.test.ts`                        | 3 stream tests (initial snapshot, push on publish, disconnect cleanup)               |
| `apps/web/src/useLiveFeedStatus.ts`                | `EventSource` → TanStack cache; `live` / `connecting` / `reconnecting`               |
| `apps/web/src/queries.ts`                          | `useFeedStatus({ live })`: polls only when the stream is down                        |
| `apps/web/src/components/FeedStatusGrid.tsx`       | Live badge; "pushed live" vs "polling" footer                                        |
| `apps/web/vite.config.ts`                          | `API_PROXY_TARGET` so a second dev server can use a second API                       |
| `.vscode/settings.json`                            | Python: 4-space indents, Ruff on save, Ruff-only import sorting                      |

## Running it

Same as before (Docker up, `npm run dev`, simulator in its own terminal). Useful extras:

```powershell
# Watch the Redis channel (repo root)
docker compose exec redis redis-cli SUBSCRIBE nimbus:feed-status
docker compose exec redis redis-cli PUBSUB NUMSUB nimbus:feed-status   # how many APIs listen

# Watch the SSE stream (curl.exe, not PowerShell's curl alias)
curl.exe -N http://localhost:4000/api/feeds/status/stream
```

**The two-instance demo** (four terminals):

| Terminal | Where            | Command                                                      | Result                     |
| -------- | ---------------- | ------------------------------------------------------------ | -------------------------- |
| 1        | repo root        | `npm run dev`                                                | API :4000 + web :5173      |
| 2        | `apps/simulator` | `.venv\Scripts\Activate.ps1`, `python main.py`               | simulator                  |
| 3        | `apps/api`       | `$env:PORT=4001; npm run dev`                                | second API on :4001        |
| 4        | `apps/web`       | `$env:API_PROXY_TARGET='http://localhost:4001'; npm run dev` | second web server on :5174 |

`$env:NAME=value` lasts only for that terminal. `dotenv` never overrides a variable that's already
set, so `PORT=4001` beats the `.env` file.

---

## The big ideas in plain English

### 1. From asking to being told

```
Phase 3 (polling):  Browser: "anything new?"   API: "here's the status"    ...every 3 s, forever
Phase 4 (push):     Browser: "tell me when something changes"   API: "new data!"   ...the moment it exists
```

How one reading travels:

```
Simulator ──1. write rows──► Postgres
    │                           ▲
    └─2. PUBLISH "new data!"    │ 4. read the latest status (once)
         on Redis ──3. radio──► API ──5. push over SSE──► every open browser
```

### 2. A nudge, not the data

The Redis message is tiny (`{"tick": 42, "at": "..."}`) and only says "go look". The **database
stays the source of truth**. That means:

- A lost nudge loses nothing; the next one, a heartbeat, or a reconnect catches up.
- Each API reads the status **once** per tick and writes it to **all** its browsers, so 100 tabs
  cost 1 query.
- **Commit, then notify:** the simulator publishes only _after_ the insert commits, so nobody reads
  too early.
- Publishing is **best-effort**: if Redis is down, the simulator logs it once and keeps writing to
  Postgres.

The road not taken: a "fat" message carrying the data saves the per-instance query, but makes the
message the source of truth and brings back the missed-message problem.

### 3. Server-Sent Events

An HTTP response that **never ends**: the server keeps the connection open and writes whenever it
has news. The wire format is plain text:

```
retry: 3000

event: status
data: {"checkedAt":"...","feeds":[...]}

```

`event:` names the message, `data:` carries it, a **blank line** ends it, and `retry:` says how long
to wait before reconnecting. In the browser, the built-in `EventSource` does the rest, including
reconnecting.

**SSE vs WebSockets:** SSE is one-way (server → browser) over plain HTTP with automatic reconnect;
WebSockets are two-way, their own protocol, and you build reconnection yourself. A dashboard only
receives, so SSE is the simpler fit.

### 4. Snapshot + stream, plus heartbeats

- **Snapshot first:** every new (or reconnected) connection immediately gets the full current status.
  Whatever it missed doesn't matter, and any API instance can serve any browser (no sticky sessions).
- **Then the stream:** a fresh snapshot per tick.
- **Heartbeats, because silence is ambiguous.** No nudge for 5 s → send a snapshot anyway. When the
  simulator stops, the stale flags still show up, and idle-timeout proxies don't cut the connection.

### 5. Push when you can, pull when you must

The browser drops each pushed snapshot into **TanStack's cache** (`setQueryData`) under the same key
the tiles already read, so **the tiles didn't change at all**. Polling is switched off while the
stream is live and comes back if it drops.

| Situation         | Badge               | How data arrives                                                  |
| ----------------- | ------------------- | ----------------------------------------------------------------- |
| All healthy       | ● **Live**          | pushed every second                                               |
| Simulator stopped | ● **Live**          | heartbeat every 5 s; tiles turn stale after 10 s                  |
| Redis stopped     | ● **Live**          | heartbeat every 5 s (data still fresh; ticks no longer announced) |
| API down          | ● **Reconnecting…** | polling every 3 s (failing until the API returns)                 |

### 6. Why Redis: many API instances

```
                         ┌──► API #1 ──SSE──► browsers A, B, C
simulator ──► Redis ─────┤
   (one tick)  (fan-out) └──► API #2 ──SSE──► browsers D, E, F
```

Each API knows only its own browsers, so every API must hear every tick. Redis delivers each message
to **all** subscribers. The simulator publishes once and doesn't know how many APIs exist
(**decoupling**).

- **Correction to an earlier claim:** "with one server, an in-process event emitter would do" is only
  true when the producer lives _inside_ the API. Our simulator is a separate process, so cross-process
  messaging is needed even with one API. (Alternative: Postgres `LISTEN/NOTIFY`.)
- **Redis is not the load balancer.** A load balancer (AWS ALB, Nginx) spreads _incoming connections_
  across instances; Redis spreads _messages_ to all of them. In the local demo, pointing each dev
  server at a different API was the load balancer, done by hand.

---

## Step by step: what to notice

### Step 1: simulator publishes (`publisher.py`)

- `TickPublisher.publish()` returns **how many subscribers** received the message: 0 before the API
  listens, 1 with one API, 2 in the demo. It appears in the once-a-minute log line.
- **Log on change only:** the `_healthy` flag prints "Redis unavailable" once and "Redis is back" once.
- **1-second timeouts:** a slow Redis must never stall the tick loop.
- The channel name `nimbus:feed-status` is duplicated in Python and TypeScript, with comments
  pointing at each other.

### Step 2: API stream (`statusBroadcaster.ts`)

- **Piece A, a refactor:** the status query moved to `db/feedStatus.ts` so `/status` and the stream
  share it. Tests passing before and after proved behavior didn't change.
- **Two Redis connections:** once a connection runs `SUBSCRIBE`, it can only listen.
- `addClient` reads the snapshot **before** sending headers, so a database failure becomes a normal
  JSON 500 rather than a broken stream.
- `res.on('close')` removes a client when the tab closes.
- The broadcaster is a **dependency** passed into `createApp`, like the pool and Redis, so tests
  create their own.
- **Testing a stream:** supertest waits for a response to end, and a stream never ends, so the tests
  start a real server on a random port (`listen(0)`) and read chunks with `fetch`. One test publishes
  on the channel itself, proving the Redis → API → stream path without the simulator.

**Three things caught while testing** (classic long-lived-connection mistakes):

1. **Ctrl+C would have hung for 10 s:** `server.close()` waits for open connections, and streams never
   end. `shutdown()` now calls `broadcaster.close()` first (≈0.1 s exit).
2. **API wouldn't start with Redis down:** startup awaited the subscription. Now it's _not_ awaited:
   the API starts, reports `redis: down`, and subscribes when Redis returns.
3. **A duplicate first message:** a heartbeat fired right after a new client's snapshot. Fixed by
   recording `lastSentAt` when the first client connects.

### Step 3: browser (`useLiveFeedStatus.ts`)

- `addEventListener('status', ...)` matches the server's `event: status` line.
- `setQueryData(queryKeys.feedStatus, snapshot)` is the bridge between push and TanStack.
- **Reconnection gotcha:** `EventSource` retries a _dropped_ connection itself, but gives up for good
  (`readyState === CLOSED`) if the server answers with an _error_ (the dev proxy's 502 while the API
  is down). `onerror` handles that by starting over after 3 s.
- The effect's cleanup closes the stream (StrictMode mounts twice in dev).
- **Call the hook once**: each call opens a connection, so it lives in `FeedStatusGrid` only.
- Still polling, on purpose: **System Health** (it checks the API itself) and the **chart** (history;
  a few seconds' delay is fine).
- The live dot respects `prefers-reduced-motion`.

### Step 4: two API instances

- The only code change: `vite.config.ts` reads `API_PROXY_TARGET` via `loadEnv`. The API already read
  `PORT` from the environment (Phase 1's zod config).
- Measured: both APIs pushed the same tick within ~2 ms of each other.
- Kill one API: only its browsers reconnect. Stop Redis: everything stays up, updates slow to the
  5-second heartbeat, and each API re-subscribes automatically when Redis returns.

---

## Gotchas we hit

- **Python indented with 2 spaces.** VS Code detects indentation from a file's contents, but a **new,
  empty** file falls back to the default tab size (2, from TypeScript work). Fix: a `[python]` block
  in `.vscode/settings.json` (`tabSize: 4`, `insertSpaces`, `detectIndentation: false`). Python only
  needs consistency _within a block_, so it still ran; PEP 8 says 4.
- **Ruff vs another import sorter.** The generic `"source.organizeImports"` on-save action let another
  organizer (via the Python extension) undo Ruff's blank line between third-party (`psycopg`) and
  local (`models`) imports. Fix: `"source.organizeImports.ruff": "explicit"`. Lesson: when a change
  keeps getting undone on save, look for two tools claiming the same job.
- **Ruff's formatter won't split the inside of a string.** A too-long f-string is a linter warning
  (`E501`) to fix by hand; two adjacent f-strings are joined automatically.
- **"Only heartbeats are arriving."** Check that the simulator is actually running before blaming the
  API.
- **PowerShell's `curl`** isn't real curl; use `curl.exe -N`.

---

## Explain it back

1. What's the difference between polling and push, and what does the user notice?
2. Why does the simulator publish a nudge instead of the data itself? What does that buy us?
3. Why publish _after_ the insert commits?
4. What is SSE, what does a message look like on the wire, and why SSE rather than WebSockets?
5. What does "snapshot + stream" mean, and why does it remove the need for sticky sessions?
6. Why does the API send heartbeats? Give two reasons.
7. Why does the API need two Redis connections?
8. How do pushed updates reach the tiles without changing the tile code?
9. When does the browser fall back to polling, and when doesn't it (and why is that correct)?
10. Redis vs a load balancer: what does each do? Why is Redis needed even with one API here?
11. Name the three long-lived-connection mistakes caught while testing and how each was fixed.
12. With logins (Phase 5), how will the broadcaster send each organization only its feeds, and why
    must that filtering happen on the server?

## Change something (write it yourself)

1. **Tick vs heartbeat (recommended).** Tag each event with why it was sent: change `toEvent` to
   include `trigger: 'tick' | 'heartbeat'` (the Redis `'message'` handler passes `'tick'`, the timer
   passes `'heartbeat'`, a new client's snapshot can be `'snapshot'`). In `useLiveFeedStatus`, track
   when the last `'tick'` arrived; if none for ~10 s while still connected, show
   **"● Live · live ticks paused, refreshing every 5s"**. Test it by stopping Redis. (Remember: the
   data is still fresh in that state; only the update frequency dropped.)
2. **Live chart.** Instead of polling every 5 s, invalidate the chart's query when a pushed snapshot
   arrives (`queryClient.invalidateQueries({ queryKey: ['feedMetrics'] })`), at most once every few
   seconds.
3. **Announce status changes.** Compare each pushed snapshot with the previous one and, when a feed's
   status changes, put "EUREX-EOBI is down" into a visually hidden `aria-live="polite"` region.
4. **Show which instance served you.** Add the API's port (or an `INSTANCE_NAME` env var) to
   `/api/health` and display it in the System Health card, then repeat the two-instance demo.
5. **A Python test for `TickPublisher`.** With `pytest`, pass a fake Redis object whose `publish`
   raises `redis.RedisError` and assert `publish()` returns 0 and logs only once.

## Known shortcuts (deliberate)

- **No real load balancer locally.** Pointing each dev server at a different API stands in for one.
  An Nginx container in front of both APIs is a candidate for the Docker/deploy phase.
- **Everyone sees the same data.** No logins yet; per-organization filtering arrives in Phase 5.
- **One status query per API instance per tick.** Fine at this scale (see "a nudge, not the data").
- **The chart and System Health still poll** (see exercise 2).
- **The channel name is duplicated** between Python and TypeScript.

---

## Answer key / interview answers

> **1. Polling vs push**
> "With polling the browser asks every few seconds, so data is up to one interval late and most
> requests return nothing new. With push the server sends an update the moment new data exists. The
> user sees changes immediately, and the server does less wasted work."

> **2. A nudge, not the data**
> "The message only says new data is ready; the database stays the source of truth. A lost message
> loses nothing, because the next nudge, a heartbeat or a reconnect reads the current state. Each API
> reads the status once per tick and sends it to all its connections, so a hundred tabs cost one
> query."

> **3. Commit, then notify**
> "If you announce before the write commits, a fast listener can read the database and get the old
> data. Publishing after the commit guarantees the data is really there."

> **4. SSE**
> "Server-Sent Events is an HTTP response that stays open; the server writes messages as text, an
> event name, a data line and a blank line to end each one. The browser's EventSource parses it and
> reconnects automatically. The dashboard only receives, so SSE is simpler than WebSockets, which are
> two-way and need their own reconnection logic."

> **5. Snapshot + stream**
> "Every new or reconnected connection first gets the full current status, then live updates. So a
> client is never out of date because of what it missed, and any API instance can serve any browser,
> no sticky sessions needed, because the snapshot comes from the shared database."

> **6. Heartbeats**
> "Silence is ambiguous: no updates could mean nothing changed or that the producer died. A heartbeat
> snapshot every five seconds keeps the stale flags flowing when the simulator stops, and keeps the
> connection from looking idle to load balancers that close idle connections."

> **7. Two Redis connections**
> "Once a Redis connection subscribes, it can only listen; it can't run normal commands. So the API
> keeps one connection for health checks and a dedicated one for the subscription."

> **8. Push into the cache**
> "The stream handler calls setQueryData with the same query key the tiles read. The tiles just see
> their cached data change, so they didn't need to change at all."

> **9. Fallback**
> "The browser polls only when its stream to the API breaks. If the API is fine but Redis or the
> simulator is down, the stream is still healthy and carries heartbeats, so polling wouldn't help:
> it would read the same database through the same API."

> **10. Redis vs load balancer**
> "A load balancer spreads incoming connections across API instances. Redis Pub/Sub spreads messages
> to all of them, so every instance hears every tick regardless of where a browser landed. Even with
> one API we need cross-process messaging, because the producer is a separate service. Postgres
> LISTEN/NOTIFY would be an alternative."

> **11. Long-lived connections**
> "Shutdown hung because server.close waits for open streams, so the API ends them first. Startup hung
> when Redis was down because it awaited the subscription, so now it starts anyway, reports Redis as
> down and subscribes when Redis returns. And a heartbeat duplicated a new client's first snapshot,
> fixed by recording when that snapshot was sent."

> **12. Tenant isolation**
> "Feed health is the same for everyone, so the broadcaster still reads it once per tick. Each
> connection is tagged with its organization when it connects, and gets a copy filtered to that
> organization's subscriptions. Filtering has to happen on the server: sending everything and hiding
> some feeds in the browser would leak other clients' data."
