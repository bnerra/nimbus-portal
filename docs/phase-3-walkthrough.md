# Phase 3 walkthrough: the live dashboard

Phase 3 turns the simulator's data into something a client can watch. The API gained two endpoints
(**current status of every feed** and **one feed's recent history**), and the web app gained **live
status tiles** and a **latency chart**, both refreshing on their own. Along the way the hand-written
`useApi` hook was replaced with **TanStack Query**.

Unlike earlier walkthroughs, this one leads with the plain-English ideas and worked examples. Read
"The big ideas" first; the step notes after it assume them.

---

## What was built

| File | Purpose |
| --- | --- |
| `apps/api/src/routes/feeds.ts` | `GET /api/feeds/status` and `GET /api/feeds/:code/metrics` |
| `apps/api/test/api.test.ts` | Tests for both endpoints (shape, newest row, bucketing, 400/404) |
| `apps/web/src/main.tsx` | Creates the `QueryClient` (the cache) and the devtools panel |
| `apps/web/src/queries.ts` | Every data hook: `useHealth`, `useFeeds`, `useFeedStatus`, `useFeedMetrics` |
| `apps/web/src/api.ts` | New response types + `getFeedStatus`, `getFeedMetrics` |
| `apps/web/src/format.ts` | Shared `formatLatency` / `formatRate` |
| `apps/web/src/components/FeedStatusGrid.tsx` | Live status tiles, summary, staleness banners, tile selection |
| `apps/web/src/components/FeedLatencyChart.tsx` | Recharts latency chart with incident shading |
| `apps/web/src/App.tsx` | Holds `selectedCode` (the feed picked in the grid) |
| `apps/web/src/useApi.ts` | **Deleted**, replaced by TanStack Query |
| `.vscode/settings.json` | Venv interpreter path; stops VS Code typing into your terminals |

New packages (web): `@tanstack/react-query`, `@tanstack/react-query-devtools`, `recharts`.

## Running it

Three things running at once (Docker Desktop up):

```powershell
# Terminal 1 (repo root): API + web
npm run dev

# Terminal 2: the simulator
cd apps/simulator
.venv\Scripts\Activate.ps1
python main.py
```

Open http://localhost:5173. Useful URLs while poking around:

- http://localhost:4000/api/feeds/status
- http://localhost:4000/api/feeds/NYSE-INT/metrics?minutes=5

---

## The big ideas in plain English

### 1. TanStack Query: a front desk for server data

**The problem.** Every component that shows server data needs the same chores: show loading, show
errors and offer a retry, cancel abandoned requests, refresh on demand, refresh on a timer, avoid
fetching the same thing twice, remember what it already fetched. `useApi` did about half of those in
~40 careful lines (and set the `useCallback` trap). TanStack Query does all of them.

**The mental model.** Components no longer fetch. They ask a **cache** for data **by name**, and the
cache decides whether it already has a fresh answer or needs to call `api.ts`:

```
FeedCatalog ── "I need ['feeds','NA']" ──► Query cache ──(only if needed)──► api.getFeeds('NA') ──► API
SystemHealth ── "I need ['health']"    ──►     │
                                         stores each answer under its key,
                                         decides when to re-fetch
```

- **`main.tsx`** creates the cache (`new QueryClient()`) and makes it reachable everywhere
  (`<QueryClientProvider>`), the React version of passing `deps` into `createApp(deps)`.
- **Each hook in `queries.ts`** describes one piece of data:
  - `queryKey`: its **name**. Same key = same cache entry. `['feeds','NA']` and `['feeds','EMEA']` are different entries.
  - `queryFn`: how to get it (always via `api.ts`).
  - freshness options: `refetchInterval` = "re-fetch every N ms no matter what" (monitoring data);
    `staleTime` = "data is good for N ms, don't bother re-fetching" (reference data).

| Old `useApi` | TanStack `useQuery` | Meaning |
| --- | --- | --- |
| `status === 'loading' && !data` | `isPending` | No data yet (first load) |
| `status === 'loading'` | `isFetching` | A request is in flight right now, even a background one |
| `status === 'error'`, `error` | same | It failed |
| `reload()` | `refetch()` | Fetch again now |

**Why the region filter got simpler.** `useApi` re-fetched when its *function* changed, so the region
had to be smuggled in through `useCallback([region])`. With TanStack the region is **part of the
key** (`['feeds', region]`): a new region is a new name, so the cache fetches it. No function identity
to manage. Bonus: revisiting a region is instant (it's cached for 5 minutes).

### 2. A chain of caches (and why Redis is more than a cache)

TanStack is a cache in the **browser** in front of the API; Redis can be a cache on the **server** in
front of the database. Same pattern (*cache-aside*): look up by key → hit: use it → miss: fetch from the
slower source and store it → expire after a while (`staleTime` ≈ Redis TTL).

```
Browser                    Server                        Database
[TanStack cache] ──HTTP──► [API] ──► [Redis cache] ──► [Postgres]
 per user, in memory               shared by everyone
```

Differences: TanStack is per user and disappears on refresh; Redis is shared by every user and every
API instance. And Redis does more than caching:

- **Cache** (`SET`/`GET` with expiry) is like a **whiteboard**: write it, anyone reads it later.
- **Pub/Sub** (`PUBLISH`/`SUBSCRIBE`) is like a **radio broadcast**: delivered instantly to whoever is
  listening, gone for anyone who isn't. Phase 4 uses this.

**Pub/sub vs queue.** A queue (SQS, RabbitMQ) keeps each message until one consumer handles it and
acks it. Live status doesn't need that: the database is the source of truth, and status is
**perishable** (a 5-minute-old latency reading is worthless). A client that missed messages just
re-fetches `/api/feeds/status` (**snapshot + stream**). Anything that must happen exactly once
(sending an alert email, generating a PDF) belongs in a durable queue with retries and a dead-letter
queue. (The SNS → SQS "durable alert notifications" stretch phase is parked for after Phase 5.)

### 3. Showing staleness honestly

"Is the data current?" matters as much as the data itself. Two different failures get two different
messages:

| Situation | How we know | What the user sees |
| --- | --- | --- |
| The **API** is down | the request fails (`status.isError`) | red "Live status unavailable", last values kept on screen |
| The API is fine, but **data stopped arriving** | `stale` flag from SQL (newest reading > 10 s old) | tiles fade, "Stale · last reading …", summary says "8 stale" |
| **Every** feed is stale at once | all `stale: true` | one yellow banner: the *pipeline* stopped, not 8 separate outages |

Staleness is computed **in SQL with the database's clock** (`now()`), the same clock that stamped
the rows, so differences between server clocks can't cause bugs.

### 4. Bucketing: 3,600 rows → 180 points

The simulator writes one row per feed per second. A chart can't use 3,600 points per hour, so the
**database** summarizes: group rows into time buckets, then squash each bucket into one row.

Worked example, 10 rows, 5-second buckets:

```
time      status    latency_us
12:00:00  up        100  ┐
12:00:01  up        120  │
12:00:02  degraded  900  │ bucket 12:00:00
12:00:03  up        110  │
12:00:04  up        100  ┘
12:00:05  up        105  ┐
12:00:06  down      NULL │
12:00:07  down      NULL │ bucket 12:00:05
12:00:08  up        115  │
12:00:09  up        95   ┘
```

| | `avg(latency_us)` | `max(latency_us)` | worst status |
| --- | --- | --- | --- |
| **12:00:00** | (100+120+900+110+100) ÷ 5 = **266** | **900** | **degraded** |
| **12:00:05** | NULLs skipped: (105+115+95) ÷ 3 = **105** | **115** | **down** |

10 rows in, 2 rows out. **Worst** status, not most common, so a 1-second outage can never be averaged
away. A bucket where the feed was down the *whole* time gets `avg = NULL`, which the chart draws as a
**gap**, not a fake zero.

### 5. Lifting state up

The grid **sets** the selected feed; the chart **reads** it. Siblings can't talk sideways in React,
so the state lives in their closest shared parent:

```
App   ← holds: selectedCode
├── FeedStatusGrid   gets onSelect   → a tile click CHANGES it
└── FeedLatencyChart gets code       → reads it and fetches that feed
```

The flip side: **lift state only as high as needed.** The chart's 5/15/60-minute range lives *inside*
the chart, because nothing else cares about it.

---

## Step by step: what to notice

### Step 1: `GET /api/feeds/status`

- **Route order:** `/status` is registered **before** `/:code`, because `/:code` matches any single
  segment, so `status` would otherwise be treated as a feed code (404 `feed_not_found`). Specific
  routes before catch-alls; the regression test "is not mistaken for a feed code" guards it.
- **`LEFT JOIN LATERAL`** = "for each feed, run this small query": its newest metric row
  (`ORDER BY recorded_at DESC LIMIT 1`). Eight tiny index lookups, however big the table grows.
  `LEFT` keeps feeds with no metrics yet; `COALESCE(m.status, 'unknown')` fills in their status.
- **Test trick:** the dev DB is shared with a running simulator, so the test inserts a row dated a
  minute in the **future** (guaranteed newest) and deletes it in `finally`.

### Step 2: TanStack Query

- See big idea 1. Also: `retry: 1` (the default 3 makes "API down" slow to appear); polling pauses
  while the tab is hidden; refetch on window focus is on by default.
- **Two requests at startup in dev** = React StrictMode mounting everything twice. Not in production.
- Devtools (TanStack logo, bottom corner) show every key, its state, and refetches live.

### Step 3: status tiles

- `useFeedStatus` polls every **3 s**.
- **Color is never the only signal:** every dot has a text label, and problem tiles also get a border.
- **Stable tile order:** tiles that jump around every 3 seconds are hard to watch; the header summary
  answers "what's wrong?" instead.
- `font-variant-numeric: tabular-nums` makes digits equal width, so numbers don't wiggle on update.
- `<dl>/<dt>/<dd>` is the semantic element for label/value pairs.
- `data-status`, `data-stale`, `data-selected` attributes drive the CSS (`[data-status='down']`).
- **No `aria-live`** on tiles: screen readers would read 24 numbers every 3 seconds (Phase 4: announce
  only *changes*).

### Step 4a: `GET /api/feeds/:code/metrics?minutes=15`

- Big idea 4, as SQL: `date_bin` → `GROUP BY 1` → aggregates (`avg`, `max`, `sum`, `bool_or`) →
  `CASE` for worst status. Bucket size adapts: `ceil(minutes × 60 / 180)` gives 5 min → 2 s,
  15 min → 5 s, 60 min → 20 s.
- `z.coerce.number()` because query strings are always text (`"15"`).
- The feed is looked up **first**, so an unknown code is a clear 404, not an empty chart that looks
  like "no data yet".
- `/:code/metrics` (two segments) can't collide with `/:code` (one), unlike `/status`.
- `::int` casts: `round(avg(...))` is `numeric` and `sum(int)` is `bigint`, and node-pg returns both
  as strings. `max(int)` stays `int`.

### Step 4b: clickable tiles + chart

- **Stretched button:** a `<button>` can't contain the tile's `<dl>`, so only the feed code is a real
  button, and `::after { position: absolute; inset: 0 }` stretches its click area over the tile
  (`position: relative` on the tile is the frame). A real `<button>` gives keyboard focus, Enter/Space
  and screen-reader support **for free**; a clickable `<div>` gives none of it.
- `useFeedMetrics` uses `enabled: code !== null` (don't fetch until a tile is picked) and
  `keepPreviousData` + `isPlaceholderData` (keep the old chart, dimmed, while switching).
- **Recharts is LEGO:** `LineChart` + `CartesianGrid` + `ReferenceArea` + `XAxis` + `YAxis` +
  `Tooltip` + `Line`. `dataKey` says which field of each point a piece reads.
- **`findIncidents`** collapses consecutive non-"up" buckets into shaded bands (the same "group
  consecutive things" idea as `GROUP BY`, in TypeScript).
- **`connectNulls={false}`**: an outage is a gap, because a line across it would claim latency was fine.
- **`isAnimationActive={false}`**: re-animating every 5-second poll is distracting.
- **`COLORS` in TS:** SVG attributes can't read CSS variables, so the tokens are mirrored there.
- **Round-minute ticks** (`minuteTicks`) so labels never repeat "8:52 PM, 8:52 PM".

---

## Gotchas we hit

- **Region filter dropped during the TanStack migration.** The instructions were written against an
  older `getFeeds()` without the region parameter. Fixed by putting the region in the query key
  (`useFeeds(region)`), which also removed the `useCallback`.
- **"SIGINT received" / "Terminate batch job (Y/N)?" killing `npm run dev`.** VS Code's Python
  extension auto-activated the venv by typing into the *already-running* npm terminal. The clue was
  a line you didn't type: `(Set-ExecutionPolicy ...) ; (& ...Activate.ps1)`. Fix, in
  `.vscode/settings.json`:

  ```json
  {
    "python.defaultInterpreterPath": "${workspaceFolder}/apps/simulator/.venv/Scripts/python.exe",
    "python.terminal.activateEnvironment": false
  }
  ```

  Habit: when something stops unexpectedly, find the **first line that isn't yours**. "Exited with
  code 1" means "something stopped me", not "my code crashed".
- **`npm run build` warns about a chunk > 500 kB.** That's Recharts. Only a warning; code-splitting is
  a later optimization.

---

## SQL cheat sheet (from the DBeaver session)

| Concept | Example | Plain English |
| --- | --- | --- |
| Join | `FROM feed_metrics m JOIN feeds f ON f.id = m.feed_id` | Metrics only store a `feed_id`; join to `feeds` to filter by the human-readable `code` (normalization) |
| Logical order | FROM → WHERE → GROUP BY → SELECT → ORDER BY → LIMIT | Written SELECT-first, evaluated FROM-first; that's why `WHERE` can't use a `SELECT` alias |
| `date_bin` | `date_bin('5 seconds', recorded_at, TIMESTAMPTZ 'epoch')` | Round each timestamp **down** to its 5-second slot on a fixed grid starting at 1970-01-01 |
| Fixed origin | `'epoch'`, not `now()` | `now()` would shift the grid every query and make the chart jitter |
| `GROUP BY 1` | | Group by **column #1 of the SELECT**; same as `GROUP BY bucket` |
| The GROUP BY rule | | Every selected column is either grouped by or an aggregate, or Postgres refuses: "must appear in the GROUP BY clause or be used in an aggregate function" |
| Aggregates | `count(*)`, `avg`, `max`, `sum` | Squash a pile into one value. `avg` skips NULLs. No `GROUP BY` → the whole table is one pile |
| `bool_or` | `bool_or(status = 'down')` | "Was the condition true for **any** row in the pile?" |
| `CASE` | `CASE WHEN ... THEN ... ELSE ... END` | if / else-if / else; first true `WHEN` wins |
| `LIMIT` after `GROUP BY` | `LIMIT 10` | 10 **buckets**, not 10 rows |
| `LEFT JOIN LATERAL` | | "For each row on the left, run this subquery"; ideal for "newest row per group" |
| `COALESCE` | `COALESCE(m.status, 'unknown')` | First non-NULL value |
| `::int` | `sum(gap_count)::int` | node-pg returns `bigint`/`numeric` as strings; cast when the value is safely small |

---

## Explain it back

Answer out loud or in writing first, then compare with the answer key below.

1. What problem does TanStack Query solve, and what is a query key?
2. What's the difference between `staleTime` and `refetchInterval`? Which does each of our hooks use, and why?
3. Why did putting the region in the query key remove the need for `useCallback`?
4. TanStack and Redis are both caches. How are they alike, and how are they different?
5. Why is fire-and-forget pub/sub acceptable for live status, but not for alert emails?
6. Why does `/status` have to be registered before `/:code`, but `/:code/metrics` doesn't?
7. How does the dashboard tell "the API is down" apart from "the data stopped arriving"?
8. Walk through how 3,600 rows become ~180 chart points. Why the *worst* status per bucket?
9. Why does an outage appear as a gap in the chart rather than a drop to zero?
10. How do the status grid and the chart share the selected feed?

## Change something (write it yourself)

Pick one or more:

1. **Remember the selection in the URL.** Read `?feed=CME-MDP` on load and update it on click
   (`URLSearchParams` + `history.replaceState`), so a link opens straight to that feed's chart.
2. **A table view of the chart** (accessibility): a "Show as table" toggle listing time, average
   latency and status per bucket.
3. **Show max latency too**, as a thinner, lighter second `<Line dataKey="maxLatencyUs">`. Then decide
   whether it helps or clutters.
4. **Unit-test `findIncidents`.** Export it, add Vitest to the web app, and assert that
   `up, degraded, degraded, up, down` produces two incidents with the right `from`/`to`.
5. **Configurable staleness.** Move `STALE_AFTER_SECONDS` into `config.ts` (zod, default 10).
6. **Announce changes, not numbers.** A visually hidden `aria-live="polite"` region that says
   "EUREX-EOBI is down" only when a feed's status *changes*.

## Known shortcuts (deliberate)

- **Polling, not push.** Tiles poll every 3 s and the chart every 5 s. Phase 4 replaces this with
  server-sent events backed by Redis Pub/Sub.
- **Types are copied by hand** between `apps/api` and `apps/web`. A shared package can fix that later.
- **Tests share the dev database** with the simulator (hence the future-dated rows). Phase 7 gives
  tests their own database.
- **No frontend tests yet** (see exercise 4).
- **Recharts adds bundle size** (the build warning); code-splitting comes later.

---

## Answer key / interview answers

> **1. TanStack Query and query keys**
> "TanStack Query is a cache for server data. Components ask for data by key instead of fetching
> it themselves, and the library handles loading and error state, de-duplication, caching, retries,
> background refresh and polling. The query key is the cache entry's name: the same key means the
> same request and the same cached result, so the key should include every parameter that changes
> the data."

> **2. `staleTime` vs `refetchInterval`**
> "`staleTime` says how long data counts as fresh, during which nothing re-fetches it.
> `refetchInterval` re-fetches on a timer regardless. Health, status and the chart poll because
> they're monitoring data; the feed catalog uses a five-minute `staleTime` because it rarely changes."

> **3. Region in the key**
> "My hand-written hook re-fetched when its fetcher function changed, so the region had to be captured
> with `useCallback`, which is easy to get wrong. With TanStack the region is part of the query key,
> so a different region is simply a different cache entry. There's no function identity to manage,
> and revisiting a region is instant because it's cached."

> **4. TanStack vs Redis**
> "Both follow the cache-aside pattern: look up by key, fetch from the slower source on a miss, expire
> after a while. TanStack lives in one user's browser tab and saves network round trips; Redis is a
> shared server that every user and API instance hits, and it saves database work. Redis also does
> things that aren't caching, like Pub/Sub."

> **5. Pub/sub vs queue**
> "Live status is perishable and the database is the source of truth, so lightweight pub/sub is fine:
> a client that missed messages re-fetches a snapshot on reconnect. An alert email has to be sent
> exactly once even if a worker is down, so it goes through a durable queue with acks, retries and a
> dead-letter queue. I pick delivery guarantees per message type."

> **6. Route order**
> "Express matches routes top to bottom, and `/:code` matches any single path segment, including the
> word 'status', so `/status` must come first. `/:code/metrics` has two segments, so it can never
> match `/:code`. A regression test guards the order."

> **7. API down vs data stale**
> "If the request fails, TanStack sets an error but keeps the last data, so we say 'live status
> unavailable, showing the last values'. If the request succeeds but the newest reading is more than
> ten seconds old, computed in SQL with the database's own clock, the tile is marked stale. If every
> feed is stale at once, we show one banner saying the monitoring pipeline stopped, because that's far
> more likely than eight simultaneous outages."

> **8. Bucketing**
> "We store one row per feed per second. Instead of sending thousands of rows to the browser, the
> database rounds each timestamp down to a time bucket with `date_bin`, groups by bucket, and returns
> one summary row per bucket: average and max latency, total gaps, and the worst status. The bucket
> size adapts to the range so it's always about 180 points. Worst status, because a short outage
> shouldn't be averaged away."

> **9. Gaps for outages**
> "A down feed has no latency, so the column is NULL. `avg` skips NULLs, so a bucket that was down the
> whole time averages to NULL, and the chart is set not to connect nulls. Drawing a line across the
> outage, or dropping to zero, would misrepresent what happened; a gap plus red shading tells the
> truth."

> **10. Sharing state**
> "The selected feed is lifted into `App`, the closest common parent. The grid receives a setter as
> `onSelect` and calls it on click; the chart receives the value as `code` and fetches that feed.
> State that only one component cares about, like the chart's time range, stays local to it."
