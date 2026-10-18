import { prisma } from './auth';

const LEASE_MS = 30_000;
const BASE_BACKOFF_MS = 5_000;

/** Exponential backoff: 5s, 10s, 20s, ... after the 1st, 2nd, 3rd failed attempt. */
export function backoffMs(attempts: number) {
    return BASE_BACKOFF_MS * 2 ** (attempts - 1);
}

/**
 * Compare-and-swap lease: push runAt into the future only if the row still has the runAt we read.
 * Exactly one worker wins, so two workers (or two overlapping polls) never process the same job
 * at once. If the winner crashes, the lease expires and the job becomes eligible again, so
 * delivery is at-least-once and handlers must be idempotent.
 */
async function leaseJob(job: { id: string; runAt: Date }) {
    const res = await prisma.job.updateMany({
        where: { id: job.id, status: 'PENDING', runAt: job.runAt },
        data: { runAt: new Date(Date.now() + LEASE_MS) },
    });
    return res.count === 1;
}

export async function processPendingJobs() {
    const pendingJobs = await prisma.job.findMany({
        where: { status: 'PENDING', runAt: { lte: new Date() } },
        take: 10,
        orderBy: { createdAt: 'asc' },
    });

    for (const job of pendingJobs) {
        if (!(await leaseJob(job))) continue; // another worker took it

        try {
            const payload = JSON.parse(job.payload);

            // Simulate failure if payload explicitly requests it (useful for testing retries)
            if (payload.simulateFailure && job.attempts < 2) {
                throw new Error('Simulated transient webhook/notification timeout');
            }

            console.log(`[ASYNC WORKER] Processed job ${job.id} (${job.type}):`, payload);

            await prisma.job.update({
                where: { id: job.id },
                data: { status: 'COMPLETED', attempts: job.attempts + 1, lastError: null },
            });
        } catch (err: any) {
            const nextAttempts = job.attempts + 1;
            const isDead = nextAttempts >= job.maxAttempts;

            await prisma.job.update({
                where: { id: job.id },
                data: {
                    attempts: nextAttempts,
                    status: isDead ? 'FAILED' : 'PENDING',
                    lastError: err.message || 'Unknown error',
                    runAt: new Date(Date.now() + backoffMs(nextAttempts)),
                },
            });
        }
    }
}

export function startBackgroundWorker() {
    setInterval(() => {
        processPendingJobs().catch((err) => console.error('Worker error:', err));
    }, 3000);
}
