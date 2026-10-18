import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { prisma } from '../src/auth';
import { backoffMs, processPendingJobs } from '../src/worker';

// These are integration tests: they run against the real database in DATABASE_URL
// and rely on the seeded demo users. Each test creates its own work items.

type U = { id: string; email: string; memberships: { teamId: string; teamName: string; role: string }[] };
let users: Record<string, U>;
let engTeamId: string;

const as = (u: U) => ({ 'x-user-id': u.id });

async function createItem(creator: U, overrides: Record<string, unknown> = {}) {
    const res = await request(app)
        .post('/api/items')
        .set(as(creator))
        .send({
            title: `Test item ${Date.now()}-${Math.random()}`,
            description: 'created by automated test',
            type: 'INTERNAL_TASK',
            priority: 'LOW',
            teamId: engTeamId,
            ...overrides,
        });
    expect(res.status).toBe(201);
    return res.body;
}

beforeAll(async () => {
    const res = await request(app).get('/api/users');
    users = Object.fromEntries((res.body as U[]).map((u) => [u.email.split('@')[0].split('.')[0], u]));
    engTeamId = users.alice.memberships.find((m) => m.teamName === 'Engineering')!.teamId;
});

describe('concurrency & integrity', () => {
    it('lets exactly one of two simultaneous claims win', async () => {
        const item = await createItem(users.alice);
        const [a, b] = await Promise.all([
            request(app).post(`/api/items/${item.id}/claim`).set(as(users.bob)),
            request(app).post(`/api/items/${item.id}/claim`).set(as(users.charlie)),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
        const loser = a.status === 409 ? a : b;
        expect(loser.body.currentItem.assigneeId).toBeTruthy();
    });

    it('rejects a stale edit with 409 and returns the current item', async () => {
        const item = await createItem(users.alice);
        const first = await request(app)
            .patch(`/api/items/${item.id}`)
            .set(as(users.bob))
            .send({ title: 'Bob edit', version: item.version });
        expect(first.status).toBe(200);
        expect(first.body.version).toBe(item.version + 1);

        const stale = await request(app)
            .patch(`/api/items/${item.id}`)
            .set(as(users.alice))
            .send({ title: 'Alice edit', version: item.version });
        expect(stale.status).toBe(409);
        expect(stale.body.currentItem.title).toBe('Bob edit');
    });

    it('replays the original response for a repeated Idempotency-Key', async () => {
        const key = `test-key-${Date.now()}-${Math.random()}`;
        const body = { title: 'Idempotent', description: 'x', teamId: engTeamId };
        const first = await request(app).post('/api/items').set(as(users.bob)).set('Idempotency-Key', key).send(body);
        const second = await request(app).post('/api/items').set(as(users.bob)).set('Idempotency-Key', key).send(body);
        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(second.headers['x-idempotent-replay']).toBe('true');
        expect(second.body.id).toBe(first.body.id);
    });
});

describe('workflow rules', () => {
    it('enforces transitions, resolution notes and lead approval', async () => {
        const item = await createItem(users.bob, { priority: 'HIGH' });
        const transition = (u: U, targetStatus: string, version: number, resolutionNote?: string) =>
            request(app).post(`/api/items/${item.id}/transition`).set(as(u)).send({ targetStatus, version, resolutionNote });

        // OPEN -> CLOSED is not allowed
        expect((await transition(users.bob, 'CLOSED', 1)).status).toBe(400);

        const inProgress = await transition(users.bob, 'IN_PROGRESS', 1);
        expect(inProgress.status).toBe(200);

        // note required for AWAITING_APPROVAL
        expect((await transition(users.bob, 'AWAITING_APPROVAL', 2)).status).toBe(400);
        // HIGH priority cannot skip approval for a plain member
        expect((await transition(users.bob, 'RESOLVED', 2, 'fixed it properly')).status).toBe(403);

        const waiting = await transition(users.bob, 'AWAITING_APPROVAL', 2, 'fixed it properly');
        expect(waiting.status).toBe(200);

        // member cannot approve, lead can
        expect((await transition(users.bob, 'RESOLVED', 3)).status).toBe(403);
        const approved = await transition(users.alice, 'RESOLVED', 3);
        expect(approved.status).toBe(200);
        expect(approved.body.status).toBe('RESOLVED');

        // every mutation left an audit row with before/after
        const detail = await request(app).get(`/api/items/${item.id}`).set(as(users.alice));
        const actions = detail.body.activities.map((a: any) => a.action);
        expect(actions).toContain('APPROVED_AND_RESOLVED');
        expect(detail.body.activities.every((a: any) => a.afterJson)).toBe(true);
    });
});

describe('team authorization', () => {
    it('blocks users from other teams on read, write and list', async () => {
        const item = await createItem(users.alice);
        const evan = users.evan; // Compliance only

        expect((await request(app).get(`/api/items/${item.id}`).set(as(evan))).status).toBe(403);
        expect(
            (await request(app).patch(`/api/items/${item.id}`).set(as(evan)).send({ title: 'x', version: 1 })).status
        ).toBe(403);
        expect((await request(app).post(`/api/items/${item.id}/claim`).set(as(evan))).status).toBe(403);
        expect((await request(app).get(`/api/items?teamId=${engTeamId}`).set(as(evan))).status).toBe(403);
        expect((await request(app).get('/api/items')).status).toBe(401);
    });
});

describe('retry-safe claim', () => {
    it('returns 200 when the current owner repeats their claim, 409 for others', async () => {
        const item = await createItem(users.alice);
        expect((await request(app).post(`/api/items/${item.id}/claim`).set(as(users.bob))).status).toBe(200);
        const again = await request(app).post(`/api/items/${item.id}/claim`).set(as(users.bob));
        expect(again.status).toBe(200);
        expect(again.body.version).toBe(item.version + 1); // no second write happened
        expect((await request(app).post(`/api/items/${item.id}/claim`).set(as(users.charlie))).status).toBe(409);
    });
});

describe('history pagination', () => {
    it('caps the detail payload and pages the rest with a cursor', async () => {
        const item = await createItem(users.alice);
        for (let i = 0; i < 4; i++) {
            await request(app).post(`/api/items/${item.id}/comments`).set(as(users.bob)).send({ body: `c${i}` });
        }
        const first = await request(app).get(`/api/items/${item.id}/comments?limit=3`).set(as(users.bob));
        expect(first.body.items).toHaveLength(3);
        expect(first.body.nextCursor).toBeTruthy();
        const second = await request(app)
            .get(`/api/items/${item.id}/comments?limit=3&cursor=${first.body.nextCursor}`)
            .set(as(users.bob));
        expect(second.body.items).toHaveLength(1);
        expect(second.body.nextCursor).toBeNull();
        const ids = [...first.body.items, ...second.body.items].map((c: any) => c.id);
        expect(new Set(ids).size).toBe(4);
        expect((await request(app).get(`/api/items/${item.id}/activities`).set(as(users.evan))).status).toBe(403);
    });
});

// Each worker pass handles at most 10 jobs, so an old backlog can delay ours: keep passing until it ran once.
async function runUntilAttempted(jobId: string, workers = 1, minAttempts = 1) {
    for (let i = 0; i < 100; i++) {
        await Promise.all(Array.from({ length: workers }, () => processPendingJobs()));
        const j = await prisma.job.findUnique({ where: { id: jobId } });
        if (j!.attempts >= minAttempts) return j!;
    }
    throw new Error('job was never attempted');
}

describe('background jobs', () => {
    it('uses exponential backoff', () => {
        expect([1, 2, 3].map(backoffMs)).toEqual([5000, 10000, 20000]);
    });

    it('processes a job once even when workers overlap', async () => {
        const job = await prisma.job.create({ data: { type: 'TEST_OVERLAP', payload: '{}' } });
        await runUntilAttempted(job.id, 3);
        const done = await prisma.job.findUnique({ where: { id: job.id } });
        expect(done!.status).toBe('COMPLETED');
        expect(done!.attempts).toBe(1);
    });

    it('retries a failing job and eventually completes it', async () => {
        const job = await prisma.job.create({
            data: { type: 'TEST_RETRY', payload: JSON.stringify({ simulateFailure: true }) },
        });
        let current = job;
        for (let i = 0; i < 6 && current.status !== 'COMPLETED'; i++) {
            current = await runUntilAttempted(job.id, 1, i + 1);
            if (current.status === 'PENDING') {
                expect(current.runAt.getTime()).toBeGreaterThan(Date.now()); // backed off / leased
                await prisma.job.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 1000) } });
            }
        }
        expect(current.status).toBe('COMPLETED');
        expect(current.attempts).toBe(3);
    });
});

describe('awaiting my approval', () => {
    it('only shows the approval queue to people who can approve', async () => {
        const bob = await request(app).get('/api/items?view=awaiting_approval').set(as(users.bob));
        expect(bob.body.pagination.total).toBe(0);
        const stats = await request(app).get('/api/stats').set(as(users.bob));
        expect(stats.body.awaitingApproval).toBe(0);
        const alice = await request(app).get('/api/items?view=awaiting_approval').set(as(users.alice));
        expect(alice.body.items.every((i: any) => i.teamId === engTeamId)).toBe(true);
    });
});

describe('idempotent job handler', () => {
    it('creates one notification even if the same job runs twice', async () => {
        const job = await prisma.job.create({
            data: { type: 'NOTIFY_CLAIM', payload: JSON.stringify({ workItemId: 'w-1', claimedBy: 'test@x.com' }) },
        });
        await processPendingJobs();
        // Simulate a duplicate delivery (e.g. worker crashed after the side effect, before marking done)
        await prisma.job.update({ where: { id: job.id }, data: { status: 'PENDING', runAt: new Date(Date.now() - 1000) } });
        await processPendingJobs();
        const final = await prisma.job.findUnique({ where: { id: job.id } });
        expect(final!.status).toBe('COMPLETED');
        expect(await prisma.notification.count({ where: { jobId: job.id } })).toBe(1);
    });
});

describe('overdue view', () => {
    it('lists only unfinished items whose due date has passed', async () => {
        const overdue = await createItem(users.alice, { dueDate: new Date(Date.now() - 86400000).toISOString() });
        const future = await createItem(users.alice, { dueDate: new Date(Date.now() + 86400000).toISOString() });
        const res = await request(app).get('/api/items?view=overdue&limit=50').set(as(users.alice));
        const ids = res.body.items.map((i: any) => i.id);
        expect(ids).toContain(overdue.id);
        expect(ids).not.toContain(future.id);
    });
});
