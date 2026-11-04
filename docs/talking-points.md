# Project notes & talking points

A **living document** for the ideas that span the whole project rather than one phase: how to explain
the app, the concepts behind it, and the conversations that made them click. The `phase-N-walkthrough.md`
files hold the step-by-step detail; this file is the overview to review before an interview or demo.

**How to grow it:** add to it whenever a discussion clarifies something. Each concept follows the same
shape: _plain English → what to say → likely follow-up_. New ideas for later go in the
[Parking lot](#parking-lot).

---

## The 60-second tour

> "Nimbus Portal is a mock client portal for a market-data company. Clients subscribe to real-time
> exchange feeds, like NYSE or CME, and the portal shows them whether those feeds are healthy right
> now: status, latency, message rates and gaps, with history charts. A Python service simulates eight
> feeds, writing a health snapshot once a second into Postgres. A TypeScript/Express API summarizes
> that data in SQL, and a React dashboard shows live status tiles and latency charts, and is honest
> about stale data. Updates are pushed to the browser the moment they exist, using server-sent events,
> with Redis Pub/Sub fanning each update out to every API instance. Next is logins, with each client
> seeing only their own feeds."

**Stack:** React 19 + Vite + TypeScript · TanStack Query · Recharts · Node/Express 5 + TypeScript ·
zod · PostgreSQL 16 · Redis 7 · Python 3 (psycopg) · Docker Compose · Vitest + Supertest.

## The phases in one line each

| Phase | Theme                             | One line                                                                                                                        |
| ----- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1     | **Foundation**                    | Monorepo, API conventions (one error shape, input validation, migrations, dependency injection, real-DB tests), feed catalog UI |
| 2     | **Data source**                   | Python simulator writing one health snapshot per feed per second, with injected incidents                                       |
| 3     | **Live dashboard**                | SQL endpoints that summarize the data; a UI that polls, caches and visualizes it, with honest staleness                         |
| 4     | **Real-time**                     | The server pushes updates (SSE + Redis Pub/Sub) instead of the browser asking; works across API instances                       |
| 5     | **Auth & multi-tenancy** _(next)_ | Logins; each client organization sees only its own subscriptions                                                                |

## Architecture (as of Phase 4)

```
                ┌─────────────────────────── Docker Compose ───────────────────┐
Python simulator ──1. write 1 row/feed/sec──► PostgreSQL ◄──3. read status once──┐
       │                                                                         │
       └──2. PUBLISH "new data" ──► Redis Pub/Sub ──fan-out──► API #1, API #2 ───┘
                └──────────────────────────────────────────────────────────────┘
                                                                  │ 4. SSE push
React (Vite) ◄────────────────────────────────────────────────────┘
  └ TanStack Query cache (filled by the stream; polling only as a fallback)
```

In production a **load balancer** (e.g. AWS ALB, Nginx) would sit in front of the API instances and
spread browsers across them. Locally there isn't one: pointing each dev server at a different API
does that job by hand.

---

## Concepts

### TanStack Query: server state vs client state

**Plain English.** A cache in the browser for data that belongs to the server. Components ask for data
by a **key**, and TanStack decides whether it already has a fresh copy or needs to call `api.ts`. It
doesn't make requests itself; `api.ts` does (`fetch`). TanStack decides **when** to call it and
**stores** the result. Versions exist for React, Vue, Svelte, Solid and Angular.

**The Redux comparison** (a common interview question):

- **Client state**: data the UI owns and that's true because the app says so (selected tab, form
  draft, cart). Lives in `useState` / Redux. Ours: `selectedCode`, the region filter, the chart range.
- **Server state**: data the server owns. The browser only holds a **copy**, which can go stale, so
  something must track loading, errors, freshness and refetching. Lives in TanStack. Ours: everything
  in `queries.ts`.
- Before tools like TanStack, teams put API data in Redux and hand-wrote the loading flags, thunks and
  refetch logic.

**What to say:**

> "TanStack Query is a client-side cache for server data. Instead of each component fetching and
> storing API results itself, components ask for data by a key, and TanStack handles loading and error
> states, caching, de-duplication and refreshing, like polling every few seconds for our live
> dashboard. I think of it as the counterpart to Redux: Redux holds UI state the app owns, while
> TanStack manages copies of data the server owns, which can go stale."

**Likely follow-up: "Why not just `useEffect` + `useState`?"**

> "I wrote that hook by hand first. It worked, but caching, polling, sharing data between components
> and avoiding stale or duplicate requests all had to be built manually, and that's exactly what
> TanStack provides."

### Caches, from browser to database

**Plain English.** Both TanStack and Redis follow the **cache-aside** pattern: look up by key →
_hit_: use it → _miss_: get it from the slower source and store it → expire it after a while
(`staleTime` ≈ Redis **TTL**).

```
Browser                    Server                        Database
[TanStack cache] ──HTTP──► [API] ──► [Redis cache] ──► [Postgres]
 per user, in memory               shared by everyone
```

|           | TanStack               | Redis                             |
| --------- | ---------------------- | --------------------------------- |
| Lives in  | one user's browser tab | a shared server                   |
| Shared by | one user               | every user and every API instance |
| Survives  | until page refresh     | API restarts                      |
| Saves     | network round trips    | database work                     |

**Likely follow-up:** _"There are only two hard things in computer science: cache invalidation and
naming things."_ Both tools give the same two answers: **expire after time** (`staleTime`, TTL) or
**explicitly throw it out when you know it changed** (`queryClient.invalidateQueries`, `DEL key`).

### Redis: more than a cache

**Plain English.** Redis is an in-memory data server with several features; caching is just one.

- **Cache** (`SET key value EX 60` / `GET key`) is like a **whiteboard**: write it, anyone reads it
  later, it expires.
- **Pub/Sub** (`PUBLISH channel msg` / `SUBSCRIBE channel`) is like a **radio broadcast**: delivered
  instantly to whoever is listening, nothing stored, missed if you weren't tuned in.
- **Streams** are a durable log, Redis's answer to Kafka-style "catch up later".

**In this project:** Redis Pub/Sub carries the simulator's "new data is ready" nudge to every API
instance (Phase 4). The general connection also backs the health check. A subscribed connection can
_only_ listen, so the API keeps two connections.

### Pub/sub vs message queue (SNS, SQS & friends)

| Pattern          | Delivery                                                           | Examples                 |
| ---------------- | ------------------------------------------------------------------ | ------------------------ |
| **Pub/sub**      | every message to **every** subscriber; no backlog for the absent   | Redis Pub/Sub, AWS SNS   |
| **Queue**        | each message stored until **one** consumer handles it and **acks** | AWS SQS, RabbitMQ        |
| **Fan-out**      | broadcast _and_ durable: each subscriber gets its own queue        | SNS → several SQS queues |
| **Log / stream** | kept for a while; each consumer tracks its position and can replay | Kafka, Redis Streams     |

**The deciding question:** _is a missed message a **problem**, or just **slightly out of date**?_

- **Live status** is perishable (a 5-minute-old reading is worthless) and the database is the source
  of truth, so lightweight pub/sub is fine. A client that missed updates re-fetches a snapshot on
  reconnect (**snapshot + stream**).
- **Alert emails, PDF jobs, payments** must happen exactly once, even if a worker is down, so they
  need a durable queue with retries and a **dead-letter queue**.

**What to say:**

> "I pick delivery guarantees per message type. Live status is perishable and the database is the
> source of truth, so I use lightweight pub/sub and have clients re-fetch a snapshot on reconnect.
> Anything with consequences, like notifications or jobs, goes through a durable queue with acks,
> retries and a dead-letter queue."

### When a tool is (and isn't) necessary

None of these tools are "always" needed; each solves a problem that appears at a certain scale.

- **TanStack:** plain `fetch` in a small hook is fine for load-once data. It earns its place with
  polling, shared data and caching, which a live dashboard needs.
- **Redis Pub/Sub:** needed here because the producer (the simulator) is a **separate process**, so
  the nudge has to cross processes, and with several API instances every one of them must hear it.
  (An in-process event emitter only works when the producer lives _inside_ the API.)

> "The producer is a separate service, so I needed cross-process messaging even with one API. Redis
> Pub/Sub does that and also fans out to every API instance. An alternative is Postgres
> LISTEN/NOTIFY, since we already have Postgres. It's simpler to run, but it ties messaging to database
> connections, while Redis keeps them separate and scales further."

### Do the heavy lifting where the data lives

**Plain English.** Don't ship 3,600 rows to the browser to draw a chart ~1,000 pixels wide. The
database groups rows into time buckets and returns ~180 summary points (see the 10-row example and
SQL cheat sheet in `phase-3-walkthrough.md`).

> "We store one row per feed per second. The database buckets them with `date_bin`, groups by bucket
> and returns average and max latency, total gaps, and the worst status per bucket. That's about 180
> points regardless of range. Worst status, because a short outage shouldn't be averaged away."

### Showing staleness honestly

> "A monitoring screen must say when its own data is old. If the API is down, we keep the last values
> and say so. If the API is fine but readings stop arriving, computed in SQL with the database's
> clock, tiles fade and are labeled stale. If every feed goes stale at once, one banner says the
> pipeline stopped, because that's far more likely than eight simultaneous outages."

### React: lifting state up (and keeping it local)

> "The status grid sets the selected feed and the chart reads it. They're siblings, so the state lives
> in their closest common parent, `App`, which passes a setter down to the grid and the value down to
> the chart. State only one component cares about, like the chart's time range, stays local."

### Accessibility for free

> "Use the right element and you get accessibility for free. Our tiles use a real `<button>`, so
> keyboard focus, Enter/Space and screen-reader support come built in; a clickable `<div>` gives none
> of that. Color is never the only signal: every status dot has a text label."

### Server-Sent Events vs WebSockets vs polling

|                | Direction               | Transport                              | Reconnect                     | Fits when                                                                    |
| -------------- | ----------------------- | -------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| **Polling**    | browser asks on a timer | normal HTTP requests                   | n/a                           | simple, infrequent updates; a good fallback                                  |
| **SSE**        | server → browser only   | one long-lived HTTP response           | **automatic** (`EventSource`) | the server announces, the browser listens (dashboards, feeds, notifications) |
| **WebSockets** | both ways               | its own protocol after an HTTP upgrade | you build it                  | both sides talk constantly (chat, games, collaborative editing)              |

**What to say:**

> "The dashboard only receives, so I used Server-Sent Events: plain HTTP, works through proxies,
> and the browser reconnects automatically. WebSockets would be the choice if the client needed to
> send a steady stream back."

**The wire format** is plain text: `event: status`, a `data: {...}` line, and a blank line to end the
message. `retry: 3000` tells the browser how long to wait before reconnecting.

### Push when you can, pull when you must

**Plain English.** The browser listens to the stream and drops each pushed snapshot straight into
TanStack's cache (`queryClient.setQueryData`), under the same key the tiles already read. The tiles
never know how the data arrived. If the stream drops, polling every 3 seconds takes over until it
returns.

> "I fed the SSE stream into the existing TanStack cache, so the UI components didn't change at all.
> While the stream is up there's no polling; if it drops, the same query falls back to polling every
> few seconds, and switches off again when the stream reconnects."

**Gotcha worth knowing:** `EventSource` reconnects by itself when a connection _drops_, but gives up
for good if the server answers with an _error_ (e.g. a proxy's 502 while the API restarts). The hook
handles that case by starting over after a pause.

### Snapshot + stream, nudges, heartbeats

- **Commit, then notify.** The simulator publishes only _after_ its insert commits, so a listener can
  never read the database too early.
- **A nudge, not the data.** The Redis message just says "new data is ready"; the database stays the
  source of truth. Each API reads the status **once per tick** and writes it to **all** its browsers
  (100 tabs = 1 query). The alternative, a "fat" message carrying the data, saves those queries but
  makes the message the source of truth, bringing back the missed-message problem.
- **Snapshot, then stream.** Every new or reconnected browser gets the full current status
  immediately, so nothing it missed matters. This is also why no "sticky sessions" are needed.
- **Heartbeats, because silence is ambiguous.** If no nudge arrives for 5 seconds, the API sends a
  snapshot anyway. That keeps stale detection working when the simulator stops, and keeps load
  balancers (ALB idle timeout: 60 s by default) from closing a quiet connection.

### Load balancer vs Redis: front side vs back side

```
browsers ──► [load balancer] ──┬──► API #1 ◄──┐
                               └──► API #2 ◄──┴── [Redis Pub/Sub] ◄── simulator
       "which server handles             "make sure EVERY server
        this new connection?"             hears about each tick"
```

- **Load balancer** (AWS ALB, Nginx, the hosting platform): spreads **incoming connections**; stops
  sending traffic to an instance that dies.
- **Redis Pub/Sub**: spreads **messages** to **all** instances, so it doesn't matter where a browser
  landed.

> "Multiple API instances give reliability and capacity. A load balancer spreads browsers across them,
> and Redis Pub/Sub makes sure every instance hears every update. The producer publishes once and
> doesn't know or care how many instances exist; that decoupling is the point of pub/sub."

### Long-lived connections change the rules

- **Shutdown must end them.** `server.close()` waits for open connections, and a stream never
  finishes, so the API ends its streams first or Ctrl+C would hang.
- **Don't block startup on an optional dependency.** Awaiting the Redis subscription at startup would
  hang the whole API if Redis were down. Instead the API starts, reports Redis as down on
  `/api/health`, and subscribes when Redis returns. _Report problems; don't hang on them._
- **Degrade, don't crash.** Redis down: updates slow to the 5-second heartbeat. One API down: only its
  browsers reconnect.

### Tenant isolation (Phase 5 preview)

Today every browser sees the same 8 feeds. With logins, each **organization** sees only the feeds it
subscribes to.

- **The facts are shared** (NYSE's latency is the same for everyone); **visibility differs**.
- So the broadcaster still reads the status **once per tick**, then filters it **per connection**
  before writing. Each connection remembers which organization it belongs to.
- **Filter on the server, never in the browser.** Sending all feeds and hiding some would leak other
  clients' data to anyone opening the Network tab.
- `EventSource` can't send custom headers (no `Authorization: Bearer ...`), which points toward
  **cookie-based sessions** for Phase 5.

> "Tenant isolation means one client's data never leaves the server for another client. Feed health is
> global, so I compute it once, but each live connection is tagged with its organization and gets a
> filtered copy."

---

## My background → this project

What I'd built before: the **request/response** side of a web app. UI → API → database; heavy work
offloaded to a **serverless worker** (a Lambda generating PDFs from HTML); results in **S3**, handed
to the user through a **signed URL** (temporary, scoped access without making the bucket public).

What this project adds: client-side caching, server-side caching and messaging, and push-based
real-time updates.

> "In my last role I built the request/response side: the API, the database, serverless PDF
> generation, S3 with signed URLs. This project is where I deliberately pushed into real-time
> systems and caching."

Parallels worth pointing out: the PDF Lambda and the Python simulator are both **separate workers**
doing one job outside the API.

## Debugging habits

- When something stops unexpectedly, find the **first line that isn't yours** in the output. (The
  `Set-ExecutionPolicy ... Activate.ps1` line exposed VS Code typing into the npm terminal.)
- **"Exited with code 1"** means "something stopped me", not "my code crashed". A real crash prints an
  error and a stack trace first.
- `ECONNREFUSED` almost always means the thing you're connecting to isn't running (Docker, the API).
- Read errors literally: _"must appear in the GROUP BY clause or be used in an aggregate function"_ is
  the rule itself.
- When a change keeps getting **undone on save**, look for **two tools claiming the same job** (two
  import sorters, two formatters). Fix: name the owner explicitly, e.g.
  `"source.organizeImports.ruff"`.
- Before blaming new code, check the **inputs are actually flowing**. (A "push only every 5 s" scare
  turned out to be the simulator not running, so only heartbeats were arriving.)

---

## Parking lot

Ideas for after Phase 5 (decide then):

- **Durable alert notifications (SNS → SQS).** When a feed goes down, publish an event; SNS fans out
  to SQS queues for a "notifier" worker (fake email inbox) and an "audit" worker (incidents table).
  Stop a worker, cause an outage, restart it: the message is still waiting. Add a dead-letter queue.
  Locally via LocalStack (check its current free tier) or ElasticMQ.
- **A real local load balancer:** Nginx in `docker-compose.yml` spreading traffic over two API
  instances (fits the Docker/deploy phase).
- Phases 6–8 from the original plan.
- Deploy, then present the project on **nberra.dev**.

## Questions to revisit

_Add anything that still feels fuzzy here, and clear it in a later session._

-
