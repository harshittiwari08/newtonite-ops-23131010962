# Engineering Decisions

Five decisions that shaped the system, with the alternatives I weighed and what each one costs.

## 1. Atomic conditional update for "claim"

**Context.** Two people can press *Claim* on the same unassigned item in the same instant. The loser must not silently overwrite the winner.

**Options considered**
1. Read the item, check `assigneeId`, then write (check-then-act). Simple, but both requests can pass the check.
2. Pessimistic row lock (`SELECT ... FOR UPDATE`) inside a transaction.
3. A single `UPDATE ... WHERE id = ? AND assigneeId IS NULL` and look at the affected row count.

**Decision.** Option 3 (`updateMany` with `assigneeId: null` in the filter). The database serialises the two updates; exactly one affects a row. The loser gets `409` plus the current item so the UI can say who won. If the caller is already the owner (a retry after a lost response), the route returns `200` without writing again.

**Trade-offs.** No lock handling or deadlock risk, and one round trip. The cost is that the rule lives in the query shape, so any future claim-like path must reuse the same pattern; the pre-check for existence and role is a separate read that can be slightly stale but never affects correctness.

## 2. Optimistic concurrency with an integer `version`

**Context.** Several hundred employees edit shared items; edits are made after reading, often minutes later. Last-write-wins would lose data.

**Options considered**
1. Last write wins.
2. Compare `updatedAt` timestamps.
3. Integer `version` column, `WHERE id = ? AND version = ?`, increment on every write.
4. Pessimistic "edit locks" held by the UI.

**Decision.** Option 3 for field edits and status transitions. The client sends the version it saw; zero affected rows means someone else changed the item, and the API returns `409` with `currentItem`. The UI shows a banner and offers *Reload latest* rather than discarding the user's work silently.

**Trade-offs.** Works over stateless HTTP and needs no lock cleanup, but the user must resolve conflicts manually (no automatic field-level merge). A plain integer is exact where timestamps can collide at millisecond resolution. Claim intentionally uses the assignee check instead of the version, so an unrelated edit does not make a claim fail.

## 3. Idempotency keys stored in the database

**Context.** Double clicks, retries after timeouts, and flaky networks can create duplicate tickets.

**Options considered**
1. Disable the button in the UI only.
2. Deduplicate by content (same title/team recently).
3. Client-generated `Idempotency-Key` header, response persisted server-side.

**Decision.** Option 3. The key is the primary key of an `IdempotencyKey` table and is inserted in the same transaction as the work item, so the item and its key either both exist or neither does. A replay returns the stored response with `X-Idempotent-Replay: true`. Two simultaneous requests are handled by the unique-key violation: the loser catches it and replays the winner's response. A key reused by a different user is rejected.

**Trade-offs.** Needs client cooperation and a table that grows (no expiry job yet). The stored body is a snapshot of the original creation. Content-based dedup was rejected because legitimately similar tickets would be blocked.

## 4. Workflow rules enforced only on the server, as an explicit state machine

**Context.** High-risk items need sign-off, and some transitions need evidence (a resolution note). Client-side checks can always be bypassed.

**Options considered**
1. Free status field, rules in the UI.
2. State machine in the API, checked in the route handler.
3. A generic workflow engine or database triggers.

**Decision.** Option 2: a table of allowed transitions plus three explicit rules (HIGH/CRITICAL items and incidents must pass through `AWAITING_APPROVAL` unless a LEAD/ADMIN acts; leaving `AWAITING_APPROVAL` for `RESOLVED` needs LEAD/ADMIN in that team; `AWAITING_APPROVAL` and `RESOLVED` need a note of at least 5 characters). Each failure returns a distinct status (`400` invalid/missing data, `403` role) and message. The UI deliberately lists every status so evaluators can see the rejection.

**Trade-offs.** Rules are readable and unit-testable in one place, but they are code, not configuration; changing a workflow means a deploy. A workflow engine would be overkill for five states. Role checks use the caller's role in the item's own team, which is what makes cross-team access safe.

## 5. Transactional audit trail and outbox-style jobs, with a polling worker

**Context.** Operations need to know who changed what and when, and follow-up work (notifications) must not be lost or fired for changes that rolled back.

**Options considered**
1. Log from application code after the write.
2. Database triggers for auditing, publish to a message broker for jobs.
3. Write the `ActivityEvent` and a `Job` row in the same `prisma.$transaction` as the change; a worker polls the table.

**Decision.** Option 3. The audit row stores before/after JSON, and the job row is the outbox. The worker polls every 3 seconds. Before running a job it takes a lease with a compare-and-swap on `runAt`, so overlapping pollers cannot run the same job at once; failures retry up to `maxAttempts` with exponential backoff (5s, 10s, 20s) and exhausted jobs are marked `FAILED`. A crash mid-job lets the lease expire and the job runs again. The handler writes a `Notification` row keyed by a unique `jobId`, so a duplicate run produces one notification, not two. A *Jobs* drawer exposes the queue for demos.

**Trade-offs.** No new infrastructure (no broker), atomicity for free, and the data is queryable. Polling adds up to 3 seconds of latency, and delivery is at-least-once, so handlers must be idempotent, and the lease approach is a stopgap before a real queue or `FOR UPDATE SKIP LOCKED`. Audit JSON is stored as text rather than `jsonb` for simplicity, which limits querying inside it.

## Also worth noting

- **Optimistic UI** is used only for claim and transitions, where the outcome is easy to predict. The UI shows the expected result immediately and drops it, with the server's reason, if the server rejects the request. Edits stay pessimistic because a rejected multi-field edit is harder to undo cleanly.

- **Pagination and search** are server-side with composite indexes matching the main filters. Offset pagination and `ILIKE` search are acceptable for about a thousand items per user and are called out as limits in the README.
- **Authentication** is a header-based demo so evaluators can switch roles instantly; authorization is the part built to production standard.
