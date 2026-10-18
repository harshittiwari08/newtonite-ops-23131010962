# Newtonite Ops Tracker

An internal operations work tracker (incidents, customer issues, payment investigations, compliance requests, internal tasks) for multiple teams. The focus is correctness: concurrency safety, server-side authorization, an audit trail, and a workflow that cannot be bypassed from the client.

- **Backend:** Node.js, TypeScript, Express 4, Prisma 6, PostgreSQL
- **Frontend:** React 19 + TypeScript (Vite)
- **Tests:** Vitest + Supertest integration tests against a real Postgres

## Setup

Prerequisites: Node 20+ and a PostgreSQL database (Docker or a hosted one such as Neon).

```bash
# 1. Database (local option)
docker compose up -d

# 2. Backend
cd backend
cp .env.example .env          # edit DATABASE_URL if you are not using docker-compose
npm install
npx prisma migrate deploy     # create tables
npm run seed                  # 3 teams, 6 users, 1,003 work items
npm run dev                   # API on http://localhost:4000

# 3. Frontend (new terminal)
cd frontend
npm install
npm run dev                   # UI on http://localhost:5173
```

The frontend talks to `http://localhost:4000/api` by default; override with `VITE_API_URL`.

### Tests

```bash
cd backend
npm test
```

The tests use the database from `DATABASE_URL` and the seeded users, and create their own work items (they do not delete them). Re-run `npm run seed` for a clean slate. Against a remote database the run can take about a minute, so the timeout is raised in `vitest.config.mts`.

## Demo users

All passwords are `password123`. The UI has an "Acting as" switcher, so no login screen is needed.

| User | Email | Roles |
|---|---|---|
| Alice Sharma | alice.lead@newtonite.com | Engineering LEAD, Payments VIEWER |
| Bob Verma | bob.member@newtonite.com | Engineering MEMBER |
| Charlie Nair | charlie.member@newtonite.com | Engineering MEMBER |
| Diana Patel | diana.lead@newtonite.com | Payments LEAD |
| Evan Gupta | evan.member@newtonite.com | Compliance MEMBER |
| Admin | admin@newtonite.com | ADMIN on all teams |

## What to try (2-minute evaluator tour)

1. **Simultaneous claim.** Open an unassigned item, press *Simulate simultaneous claim*. Two requests from two users fire at once; one gets `200`, the other `409`.
2. **Stale edit.** Press *Simulate stale edit*. A write using an old `version` is rejected with `409` and a banner shows the server's current state with a *Reload latest* button. For a real two-user test, open two tabs as different users, load the same item, save in both.
3. **Idempotent create.** *New item* then *Test: submit twice at once*. Both requests carry the same `Idempotency-Key`; only one item is created and the second response is flagged `X-Idempotent-Replay: true`.
4. **Workflow and approval.** As Bob, take a HIGH/CRITICAL item to `IN_PROGRESS`, try `RESOLVED` (rejected, 403), move it to `AWAITING_APPROVAL` with a note, then switch to Alice and *Approve & resolve*. Missing notes (400) and invalid jumps such as `OPEN -> CLOSED` (400) are rejected.
5. **Team isolation.** As Evan (Compliance), open an Engineering item URL via the API or try the team filter: `403`.
6. **Audit and async jobs.** Every change appears in the item's *Activity history* with before/after values. The *Jobs* drawer shows the queue the worker drains every 3 seconds.

## Architecture

```
React SPA  --x-user-id header-->  Express API  -->  Prisma  -->  PostgreSQL
                                      |
                                background worker (setInterval, polls Job table every 3s)
```

- `backend/src/app.ts` routes and business rules; `auth.ts` identity and role helpers; `worker.ts` job processor.
- **Authorization** is resource-level and server-side. Each item belongs to a team; every read/write resolves the caller's role *in that item's team*. Roles rank VIEWER < MEMBER < LEAD < ADMIN. Lists are always filtered to the caller's teams.
- **Concurrency:** claim is one conditional `UPDATE ... WHERE assigneeId IS NULL`; edits and transitions use `WHERE id = ? AND version = ?` and bump `version`.
- **Audit and jobs:** each mutation writes an `ActivityEvent` (before/after JSON) and, where relevant, a `Job` in the same `prisma.$transaction`, so there is no state change without its audit row.
- **Scale:** list queries are server-side filtered, searched and paginated (max 50 per page) with indexes on `(teamId, status)`, `(assigneeId, status)`, `priority`, and `createdAt`.

### API summary

| Method | Path | Notes |
|---|---|---|
| GET | `/api/users` | demo user switcher |
| POST | `/api/login` | email + password |
| GET | `/api/stats` | dashboard counts for caller's teams |
| GET | `/api/items` | `teamId, status, priority, assigneeId, q, view, page, limit` |
| GET | `/api/items/:id` | item + activities + comments + `currentUserRole` |
| POST | `/api/items` | honours `Idempotency-Key` |
| POST | `/api/items/:id/claim` | `200` or `409` |
| PATCH | `/api/items/:id` | requires `version`; `409` with `currentItem` when stale |
| POST | `/api/items/:id/transition` | `targetStatus, resolutionNote, version` |
| POST | `/api/items/:id/comments` | |
| GET / POST | `/api/jobs`, `/api/jobs/process` | queue view / run worker now |

All routes except `/api/users` and `/api/login` need the `x-user-id` header.

## Known limitations

- **Authentication is a demo.** Identity is the `x-user-id` header and passwords are stored in plain text. This is intentional for evaluator convenience and must be replaced by sessions/JWT and password hashing in production. Authorization checks themselves are real and server-side.
- **`/api/jobs` is not team-scoped**; any signed-in user can see job payloads (which include emails).
- **Job worker runs in the API process** and polls with `setInterval`. With several API instances, two workers could pick up the same job; a real deployment should claim jobs with `SELECT ... FOR UPDATE SKIP LOCKED` or use a dedicated queue. Jobs here only log; there is no real notification delivery. Backoff is linear (`attempt * 5s`), not exponential.
- **Idempotency keys never expire** and the stored response is the one from first creation (it is not refreshed if the item later changes).
- **Search uses `ILIKE '%q%'`**, which does not use the indexes; at much larger scale it should move to `pg_trgm` or full-text search.
- **Pagination is offset-based**, so deep pages get slower and can shift if items change while browsing.
- Async Express 4 handlers have no global error middleware; an unexpected database error can leave a request hanging instead of returning `500`.
- The frontend has no automated tests, and the claim route checks the item before its transaction (the atomic `WHERE assigneeId IS NULL` is what guarantees correctness).
- A user who holds ADMIN in any team is treated as an admin everywhere (the seeded admin is a member of all three teams).
