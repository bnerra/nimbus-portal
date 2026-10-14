# Phase 1 walkthrough: how to review this code

Phase 1 is the foundation: nothing flashy, but every later phase builds on these patterns. The goal
of this review isn't to memorize the code. It's to be able to **explain why each piece exists** and
**change it confidently**.

Budget: about 2–4 hours, in two or three sittings.

---

## Step 0: Get it running first

Follow "First-time setup" in the README. Reading code is much easier once you've seen it work.
Then do the "Try breaking it" section, so you've seen the failure states with your own eyes.

---

## Step 1: Read in this order

Follow a request from the outside in. For each file, the bullet points are what to notice.

### The setup (15 min)

1. **`package.json` (root)**
   - `workspaces`: one `npm install` installs both apps; `-w apps/api` runs a script in one app.
   - `dev` uses `concurrently` to run the API and web app in one terminal.

2. **`docker-compose.yml`**
   - Only infrastructure (Postgres, Redis) runs in Docker for now; our code runs directly on your
     machine for fast reloads.
   - Why ports 5433/6380 instead of the defaults? (Answer in the file's comments.)
   - Named volume `pgdata`: what's the difference between `infra:down` and `infra:reset`?

3. **`apps/api/.env.example`** and **`apps/api/src/config.ts`**
   - Config comes only from environment variables. This is what makes the app deployable later
     without code changes.
   - `zod` validates them at startup. Try it: rename `DATABASE_URL` in your `.env` and run
     `npm run dev`. Read the error message, then put it back.

### The database (30–40 min)

4. **`apps/api/migrations/001_...sql`**
   - Three tables and how they relate. `subscriptions` is a _join table_ (many-to-many between
     organizations and feeds).
   - Constraints do validation inside the database: `NOT NULL`, `UNIQUE`, `CHECK`, foreign keys.
     Even buggy app code can't insert an asset class of `'crypto'`.
   - `ON DELETE CASCADE` vs `ON DELETE RESTRICT`: what happens when you delete an organization?
     A feed someone subscribes to?
   - Why is there an index on `feed_id` but not on `organization_id`?

5. **`apps/api/src/db/migrate.ts`**
   - The `schema_migrations` table is the runner's memory.
   - Each migration runs inside `BEGIN` / `COMMIT`, with `ROLLBACK` on error. Why does that matter?
   - The advisory lock: what problem does it solve? (Hint: two servers starting at once.)

6. **`apps/api/src/db/seed.ts`**
   - `$1, $2` parameters instead of string concatenation (SQL-injection prevention).
   - `ON CONFLICT ... DO UPDATE` makes the seed _idempotent_. Run `npm run db:seed` three times and
     confirm nothing duplicates.

7. **`apps/api/src/db/pool.ts`**: why a pool, and why the `pool.on('error')` listener.

   Explore in a SQL client (VS Code's PostgreSQL extension, DBeaver, or `psql`) using the
   connection details in `.env`:

   ```sql
   SELECT * FROM schema_migrations;
   SELECT o.name, f.code, s.delivery
   FROM subscriptions s
   JOIN organizations o ON o.id = s.organization_id
   JOIN feeds f ON f.id = s.feed_id
   ORDER BY o.name, f.code;
   ```

### The API (30–40 min)

8. **`apps/api/src/index.ts`**: where real connections get created and the server starts.
   Notice graceful shutdown: press Ctrl+C while `npm run dev` runs and watch the log.

9. **`apps/api/src/app.ts`**
   - `createApp(deps)` _receives_ its database and Redis connections (dependency injection).
     This is what lets tests call the app without starting a server.
   - Order matters: routes first, then `notFoundHandler`, then `errorHandler`.

10. **`apps/api/src/errors.ts`**
    - Every error has the same JSON shape: `{ error: { code, message } }`.
    - Unknown errors are logged in full but return a generic message to the client. Why?

11. **`apps/api/src/routes/feeds.ts`**
    - `AS "assetClass"`: snake_case in SQL, camelCase in JSON, converted in the query itself.
    - `LEFT JOIN` vs `JOIN`: which feed would disappear with a plain `JOIN`? (Look at `JPX-FLEX`.)
    - `COUNT(...)::int`: try removing `::int` and look at `subscriberCount` in the response.
    - Input validation with zod before touching the database → clear 400 errors.
    - `throw new HttpError(...)` inside an async handler: Express 5 forwards it to `errorHandler`
      automatically (Express 4 needed extra wrapping for this).

12. **`apps/api/src/routes/health.ts`**
    - Checks run in parallel with `Promise.all`.
    - `timedCheck` adds a timeout so a hung dependency can't hang the health endpoint.
    - Returns **503** when anything is down. Load balancers rely on that status code.

13. **`apps/api/test/api.test.ts`** + **`global-setup.ts`**
    - These are _integration_ tests: real Postgres, real Redis, no mocks.
    - `supertest` calls the Express app in-process.
    - Run `npm test`, then break something on purpose (e.g. change `'NYSE Integrated'` in the test)
      to see what a failure looks like.

### The web app (30 min)

14. **`apps/web/vite.config.ts`**: the `/api` proxy, and why it means no CORS setup.

15. **`apps/web/src/api.ts`**
    - The only file that calls `fetch`. Components ask `api.getFeeds()`, never a URL.
    - `fetch` does **not** throw on 404/500, only on network failure. That's why the code checks
      `res.ok` itself. A very common bug in real codebases.
    - `alsoAccept: [503]`: health's 503 is still a meaningful answer, not a failure.

16. **`apps/web/src/useApi.ts`**
    - Loading / success / error modeled as a union type, so TypeScript knows `error` exists only in
      the error state.
    - `AbortController` + effect cleanup: why it prevents stale responses overwriting fresh ones.
    - Keeps old data visible while reloading (no flash of empty content).
    - Phase 3 replaces this with TanStack Query. Knowing what it does by hand makes that library
      make sense.

17. **`components/SystemHealth.tsx`** and **`components/FeedCatalog.tsx`**
    - Every state is handled: loading, error (with retry), empty, success.
    - `useMemo` for the filtered list, and the comment on when you'd filter on the server instead.
    - Accessibility: `aria-pressed` on filter buttons, `role="alert"` on errors, status dots
      paired with text so color isn't the only signal.

18. **`styles.css`**: design tokens (CSS variables) at the top; `minmax(0, 1fr)` on `.content`
    keeps the wide table scrolling inside its card on phones instead of stretching the page.

---

## Step 2: Explain it back

Answer these out loud or in writing, without looking. Then check against the code, or paste your
answers to Claude for feedback.

1. Walk through what happens, file by file, when the browser loads the feed catalog.
2. Why does `createApp` take its dependencies as a parameter instead of importing them?
3. What would go wrong if two copies of the API ran migrations at the same moment without the
   advisory lock?
4. Why does the health endpoint return 503 instead of 200 when Redis is down?
5. `fetch` resolved successfully but the server returned 500. How does our code turn that into an
   error, and where does the user see it?
6. What's the difference between `npm run infra:down` and `npm run infra:reset`?
7. Why is the seed safe to run repeatedly?

---

## Step 3: Change something (write this yourself)

**Exercise: server-side region filter.** Add an optional `region` query parameter:
`GET /api/feeds?region=EMEA` returns only EMEA feeds.

1. In `routes/feeds.ts`, validate `req.query.region` with zod: `z.enum(['NA', 'EMEA', 'APAC'])`,
   optional. Return a 400 with code `invalid_region` for anything else.
2. Add it to the SQL as a **parameter**, not string concatenation. Hint: one clean pattern is
   `WHERE ($1::text IS NULL OR f.region = $1)`, passing `null` when no region is given.
3. Add tests in `test/api.test.ts`: `?region=EMEA` returns only EMEA feeds; `?region=MARS`
   returns 400.
4. Bonus: update `api.getFeeds` to accept a region, and have `FeedCatalog` fetch from the server
   instead of filtering in the browser. (What happens to `useApi`'s stable-function requirement?
   That's a good question to bring back.)

When `npm test` and `npm run typecheck` both pass, you're done.

---

## Known shortcuts (deliberate, fixed in later phases)

- **Tests use the dev database.** Safe because migrations and seed are idempotent; Phase 7 gives
  tests their own database.
- **Types are duplicated** between `apps/api` and `apps/web`. A shared package could fix this later.
- **The health endpoint shows dependency error text publicly.** Fine for local dev; in production
  you'd show details only to internal users (Phase 5/7).
- **The API and web app aren't containerized yet.** Phase 7.
- **Redis is connected but unused** beyond the health check until Phase 4.
