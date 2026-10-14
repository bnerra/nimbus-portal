# Nimbus Client Portal

A practice project: the customer-facing portal for **Nimbus Market Data**, a fictional company
that sells real-time market data feeds to trading firms. Clients log in to see the live health of
the feeds they subscribe to, get alerts when something goes wrong, review incident history and SLA
numbers, and manage their team's access.

Built to practice the skills behind modern B2B fintech portals: real-time UIs, REST API design,
multi-tenant security, PostgreSQL, Redis pub/sub, testing, CI/CD, and a responsible AI feature.

## Tech stack

| Layer           | Choice                                                             |
| --------------- | ------------------------------------------------------------------ |
| Front end       | React 19, TypeScript, Vite                                         |
| Back end        | Node.js, Express 5, TypeScript                                     |
| Database        | PostgreSQL 16 (plain SQL, hand-rolled migrations)                  |
| Cache / pub/sub | Redis 7                                                            |
| Testing         | Vitest + Supertest (integration tests against real Postgres/Redis) |
| Local infra     | Docker Compose                                                     |

## Getting started (Windows, macOS or Linux)

### Prerequisites

- **Node.js 22 or newer**: <https://nodejs.org> (LTS installer). Check with `node -v`.
- **Docker Desktop**: <https://www.docker.com/products/docker-desktop/>. On Windows it uses WSL 2;
  the installer walks you through it. Make sure Docker Desktop is _running_ before step 3.
- **Git**: <https://git-scm.com>.

### First-time setup

Run these from the project folder (PowerShell, Command Prompt, or the VS Code terminal all work):

```bash
# 1. Install dependencies for both apps (npm workspaces handle both at once)
npm install

# 2. Create your local environment file from the template
#    PowerShell:  Copy-Item apps/api/.env.example apps/api/.env
#    Git Bash:    cp apps/api/.env.example apps/api/.env

# 3. Start Postgres and Redis in Docker
npm run infra:up

# 4. Create the database tables, then load demo data
npm run db:migrate
npm run db:seed

# 5. Start the API and the web app together
npm run dev
```

Open <http://localhost:5173>. You should see three green "Operational" tiles and the feed catalog.

### Everyday commands

| Command               | What it does                                                   |
| --------------------- | -------------------------------------------------------------- |
| `npm run dev`         | Start API (port 4000) and web app (port 5173) with live reload |
| `npm run infra:up`    | Start Postgres + Redis containers                              |
| `npm run infra:down`  | Stop them (data is kept)                                       |
| `npm run infra:reset` | Stop them **and delete all data** (then re-run migrate + seed) |
| `npm run db:migrate`  | Apply any new migrations in `apps/api/migrations/`             |
| `npm run db:seed`     | Load or refresh demo data (safe to re-run)                     |
| `npm test`            | Run the API integration tests (needs `infra:up` first)         |
| `npm run typecheck`   | Type-check both apps                                           |
| `npm run build`       | Production build of both apps                                  |
| `npm run format`      | Format all files with Prettier                                 |

### Try breaking it

The UI is built to report failures honestly. With `npm run dev` running:

- `docker compose stop redis`, then click **Refresh**: the Redis tile turns red.
  `docker compose start redis` and refresh again: it recovers on its own.
- Stop the API (Ctrl+C) and reload the page: both cards show a clear "API is not responding" message.

## Project structure

```
nimbus-portal/
├── docker-compose.yml        Postgres + Redis for local development
├── package.json              Root scripts; npm workspaces for the two apps
├── tsconfig.base.json        TypeScript settings shared by both apps
├── docs/
│   └── phase-1-walkthrough.md  How to review this phase's code
└── apps/
    ├── api/                  Express + TypeScript REST API
    │   ├── migrations/       Numbered SQL files (the database schema)
    │   ├── src/
    │   │   ├── index.ts      Starts the server, graceful shutdown
    │   │   ├── app.ts        Builds the Express app (routes, error handling)
    │   │   ├── config.ts     Validated environment variables
    │   │   ├── errors.ts     Consistent JSON error responses
    │   │   ├── redis.ts      Redis client
    │   │   ├── db/           Connection pool, migration runner, seed data
    │   │   ├── routes/       /api/health and /api/feeds
    │   │   └── scripts/      CLI entry points for migrate and seed
    │   └── test/             Integration tests
    └── web/                  React + TypeScript (Vite)
        └── src/
            ├── api.ts        Typed API client (the only place that calls fetch)
            ├── useApi.ts     Small data-fetching hook (replaced in Phase 3)
            ├── App.tsx       Page layout
            ├── components/   SystemHealth, FeedCatalog
            └── styles.css    Design tokens + styles
```

## Roadmap

- [x] **Phase 1: Foundation.** Monorepo, Docker Compose, migrations, seed data, health + feed
      catalog endpoints, integration tests, first React page.
- [ ] **Phase 2: Simulator.** A service that generates fake feed metrics (latency, message
      rates, sequence numbers) and injects incidents.
- [ ] **Phase 3: Dashboard.** Live-ish status page with polling, TanStack Query, latency charts.
- [ ] **Phase 4: Real-time.** Server-Sent Events, reconnect with backoff + jitter, heartbeats,
      snapshot + deltas resync, stale-data indicators, Redis pub/sub across API instances.
- [ ] **Phase 5: Auth & multi-tenancy.** Organizations, users, memberships, roles (RBAC),
      session cookies, tenant-scoped queries, Postgres Row-Level Security, cross-tenant tests.
- [ ] **Phase 6: Alerts & incidents.** Threshold and gap detection, incident timeline, SLA/uptime.
- [ ] **Phase 7: Quality & delivery.** End-to-end tests (Playwright), GitHub Actions CI,
      containerized API/web, structured logging, optional deployment.
- [ ] **Phase 8: AI assistant.** "Explain this alert": retrieval over runbooks, cited answers,
      tenant-scoped and read-only.

## Troubleshooting

- **`Invalid environment configuration` on startup:** you skipped step 2; create `apps/api/.env`.
- **`ECONNREFUSED ...:5433` or the Database tile is red:** Docker Desktop isn't running, or the
  containers aren't up. Run `npm run infra:up` and check `docker compose ps`.
- **Port already in use:** something else is on 4000, 5173, 5433 or 6380. Change the port in
  `docker-compose.yml` / `apps/api/.env` / `apps/web/vite.config.ts` (keep them in sync).
