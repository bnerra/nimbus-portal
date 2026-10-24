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
> about stale data. Next I'm adding real-time push with server-sent events and Redis Pub/Sub, then
> logins with each client seeing only their own feeds."

**Stack:** React 19 + Vite + TypeScript · TanStack Query · Recharts · Node/Express 5 + TypeScript ·
zod · PostgreSQL 16 · Redis 7 · Python 3 (psycopg) · Docker Compose · Vitest + Supertest.

## The phases in one line each

| Phase | Theme | One line |
| --- | --- | --- |
| 1 | **Foundation** | Monorepo, API conventions (one error shape, input validation, migrations, dependency injection, real-DB tests), feed catalog UI |
| 2 | **Data source** | Python simulator writing one health snapshot per feed per second, with injected incidents |
| 3 | **Live dashboard** | SQL endpoints that summarize the data; a UI that polls, caches and visualizes it, with honest staleness |
| 4 | **Real-time** _(next)_ | The server pushes updates (SSE + Redis Pub/Sub) instead of the browser asking |
| 5 | **Auth & multi-tenancy** _(planned)_ | Logins; each client organization sees only its own subscriptions |

## Architecture (as of Phase 3)

```
                       ┌────────────────────────── Docker Compose ──┐
Python simulator ──writes 1 row/feed/sec──► PostgreSQL               │
                                               ▲          Redis      │
                                               │ SQL        ▲ (ping  │
React (Vite) ──/api, polling──► Express API ───┘            │  only, │
  └ TanStack Query cache                     └──────────────┘  so far)
                       └────────────────────────────────────────────┘
```

Phase 4 changes the left side: the API pushes over SSE, with Redis Pub/Sub carrying updates between
API instances.

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

| | TanStack | Redis |
| --- | --- | --- |
| Lives in | one user's browser tab | a shared server |
| Shared by | one user | every user and every API instance |
| Survives | until page refresh | API restarts |
| Saves | network round trips | database work |

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

**In this project:** Redis is only health-checked so far. Its first real job (Phase 4) is Pub/Sub.

### Pub/sub vs message queue (SNS, SQS & friends)

| Pattern | Delivery | Examples |
| --- | --- | --- |
| **Pub/sub** | every message to **every** subscriber; no backlog for the absent | Redis Pub/Sub, AWS SNS |
| **Queue** | each message stored until **one** consumer handles it and **acks** | AWS SQS, RabbitMQ |
| **Fan-out** | broadcast _and_ durable: each subscriber gets its own queue | SNS → several SQS queues |
| **Log / stream** | kept for a while; each consumer tracks its position and can replay | Kafka, Redis Streams |

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
- **Redis Pub/Sub:** with **one** API server, Node's built-in event emitter could broadcast updates
  in-process. Redis becomes necessary with **several** API instances, which production always has.

> "With one server I'd use an in-process event emitter; Redis is there because broadcasts have to
> reach every API instance."

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

---

## Parking lot

Ideas for after Phase 5 (decide then):

- **Durable alert notifications (SNS → SQS).** When a feed goes down, publish an event; SNS fans out
  to SQS queues for a "notifier" worker (fake email inbox) and an "audit" worker (incidents table).
  Stop a worker, cause an outage, restart it: the message is still waiting. Add a dead-letter queue.
  Locally via LocalStack (check its current free tier) or ElasticMQ.
- Phases 6–8 from the original plan.
- Deploy, then present the project on **nberra.dev**.

## Questions to revisit

_Add anything that still feels fuzzy here, and clear it in a later session._

-
