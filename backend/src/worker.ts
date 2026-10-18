import { prisma } from './auth';

export async function processPendingJobs() {
    const now = new Date();
    const pendingJobs = await prisma.job.findMany({
        where: {
            status: 'PENDING',
            runAt: { lte: now },
        },
        take: 10,
        orderBy: { createdAt: 'asc' },
    });

    for (const job of pendingJobs) {
        try {
            const payload = JSON.parse(job.payload);

            // Simulate failure if payload explicitly requests it (useful for testing retries)
            if (payload.simulateFailure && job.attempts < 1) {
                throw new Error('Simulated transient webhook/notification timeout');
            }

            // Idempotent processing log
            console.log(`[ASYNC WORKER] Processed job ${job.id} (${job.type}):`, payload);

            await prisma.job.update({
                where: { id: job.id },
                data: { status: 'COMPLETED', attempts: job.attempts + 1 },
            });
        } catch (err: any) {
            const nextAttempts = job.attempts + 1;
            const isDead = nextAttempts >= job.maxAttempts;
            // Exponential backoff: retry 5 seconds later
            const nextRunAt = new Date(Date.now() + nextAttempts * 5000);

            await prisma.job.update({
                where: { id: job.id },
                data: {
                    attempts: nextAttempts,
                    status: isDead ? 'FAILED' : 'PENDING',
                    lastError: err.message || 'Unknown error',
                    runAt: nextRunAt,
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