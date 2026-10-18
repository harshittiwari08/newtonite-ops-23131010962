import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Priority, Role, WorkItemStatus, WorkItemType } from '@prisma/client';
import { prisma, requireAuth, getRoleInTeam, hasMinRole } from './auth';
import { startBackgroundWorker, processPendingJobs } from './worker';

dotenv.config();

export const app = express();
app.use(cors());
app.use(express.json());

// Valid state machine transitions
// Detail view only returns the newest N history rows; the rest is paged via /activities and /comments.
const HISTORY_PREVIEW = 20;

const ALLOWED_TRANSITIONS: Record<WorkItemStatus, WorkItemStatus[]> = {
    OPEN: [WorkItemStatus.IN_PROGRESS],
    IN_PROGRESS: [WorkItemStatus.OPEN, WorkItemStatus.AWAITING_APPROVAL, WorkItemStatus.RESOLVED],
    AWAITING_APPROVAL: [WorkItemStatus.IN_PROGRESS, WorkItemStatus.RESOLVED],
    RESOLVED: [WorkItemStatus.IN_PROGRESS, WorkItemStatus.CLOSED],
    CLOSED: [WorkItemStatus.IN_PROGRESS], // Reopen if needed
};

// 1. Get all seeded demo users (for quick login/role switcher)
app.get('/api/users', async (_req, res) => {
    const users = await prisma.user.findMany({
        include: { memberships: { include: { team: true } } },
        orderBy: { name: 'asc' },
    });
    res.json(
        users.map((u) => ({
            id: u.id,
            email: u.email,
            name: u.name,
            memberships: u.memberships.map((m) => ({
                teamId: m.teamId,
                teamName: m.team.name,
                role: m.role,
            })),
        }))
    );
});

// 2. Login endpoint
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({
        where: { email },
        include: { memberships: { include: { team: true } } },
    });

    if (!user || user.password !== password) {
        return res.status(401).json({ error: 'Invalid email or password' });
    }

    res.json({
        id: user.id,
        email: user.email,
        name: user.name,
        memberships: user.memberships.map((m) => ({
            teamId: m.teamId,
            teamName: m.team.name,
            role: m.role,
        })),
    });
});

// 3. Dashboard summary stats for the logged-in user's teams
app.get('/api/stats', requireAuth, async (req, res) => {
    const user = req.user!;
    const teamIds = user.memberships.map((m) => m.teamId);

    const [assignedToMe, unassignedUrgent, awaitingApproval, byStatus] = await Promise.all([
        prisma.workItem.count({
            where: {
                teamId: { in: teamIds },
                assigneeId: user.id,
                status: { notIn: [WorkItemStatus.RESOLVED, WorkItemStatus.CLOSED] },
            },
        }),
        prisma.workItem.count({
            where: {
                teamId: { in: teamIds },
                assigneeId: null,
                priority: { in: [Priority.HIGH, Priority.CRITICAL] },
                status: WorkItemStatus.OPEN,
            },
        }),
        prisma.workItem.count({
            where: {
                teamId: { in: teamIds },
                status: WorkItemStatus.AWAITING_APPROVAL,
            },
        }),
        prisma.workItem.groupBy({
            by: ['status'],
            where: { teamId: { in: teamIds } },
            _count: { _all: true },
        }),
    ]);

    res.json({ assignedToMe, unassignedUrgent, awaitingApproval, byStatus });
});

// 4. List & Filter Work Items (Server-side pagination + indexing)
app.get('/api/items', requireAuth, async (req, res) => {
    const user = req.user!;
    const allowedTeamIds = user.memberships.map((m) => m.teamId);

    const {
        teamId,
        status,
        priority,
        assigneeId,
        q,
        view,
        page = '1',
        limit = '15',
    } = req.query as Record<string, string | undefined>;

    const pageNum = Math.max(1, parseInt(page || '1', 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(limit || '15', 10)));

    // Enforce team-level visibility
    if (teamId && !allowedTeamIds.includes(teamId)) {
        return res.status(403).json({ error: 'You do not have access to this team.' });
    }

    const where: any = {
        teamId: teamId ? teamId : { in: allowedTeamIds },
    };

    if (status) where.status = status as WorkItemStatus;
    if (priority) where.priority = priority as Priority;
    if (assigneeId === 'unassigned') where.assigneeId = null;
    else if (assigneeId) where.assigneeId = assigneeId;

    // Quick operational views
    if (view === 'my_active') {
        where.assigneeId = user.id;
        where.status = { notIn: [WorkItemStatus.RESOLVED, WorkItemStatus.CLOSED] };
    } else if (view === 'unassigned_urgent') {
        where.assigneeId = null;
        where.priority = { in: [Priority.HIGH, Priority.CRITICAL] };
        where.status = WorkItemStatus.OPEN;
    } else if (view === 'awaiting_approval') {
        where.status = WorkItemStatus.AWAITING_APPROVAL;
    }

    if (q && q.trim() !== '') {
        where.OR = [
            { title: { contains: q.trim(), mode: 'insensitive' } },
            { description: { contains: q.trim(), mode: 'insensitive' } },
        ];
    }

    const [total, items] = await Promise.all([
        prisma.workItem.count({ where }),
        prisma.workItem.findMany({
            where,
            include: {
                team: true,
                assignee: { select: { id: true, name: true, email: true } },
                createdBy: { select: { id: true, name: true, email: true } },
            },
            orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
            skip: (pageNum - 1) * pageSize,
            take: pageSize,
        }),
    ]);

    res.json({
        items,
        pagination: {
            total,
            page: pageNum,
            limit: pageSize,
            totalPages: Math.ceil(total / pageSize),
        },
    });
});

// 5. Get Single Work Item + Full Activity History + Comments
app.get('/api/items/:id', requireAuth, async (req, res) => {
    const user = req.user!;
    const item = await prisma.workItem.findUnique({
        where: { id: req.params.id },
        include: {
            team: true,
            assignee: { select: { id: true, name: true, email: true } },
            createdBy: { select: { id: true, name: true, email: true } },
            activities: {
                include: { actor: { select: { id: true, name: true, email: true } } },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: HISTORY_PREVIEW,
            },
            comments: {
                include: { author: { select: { id: true, name: true, email: true } } },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: HISTORY_PREVIEW,
            },
            _count: { select: { activities: true, comments: true } },
        },
    });

    if (!item) {
        return res.status(404).json({ error: 'Work item not found.' });
    }

    const role = getRoleInTeam(user, item.teamId);
    if (!role) {
        return res.status(403).json({ error: 'Forbidden: You do not belong to the owning team.' });
    }

    res.json({ ...item, currentUserRole: role });
});

// 5b. Cursor-paginated history (activities / comments), newest first.
for (const kind of ['activities', 'comments'] as const) {
    app.get(`/api/items/:id/${kind}`, requireAuth, async (req, res) => {
        const user = req.user!;
        const item = await prisma.workItem.findUnique({ where: { id: req.params.id }, select: { teamId: true } });
        if (!item) return res.status(404).json({ error: 'Work item not found.' });
        if (!getRoleInTeam(user, item.teamId)) {
            return res.status(403).json({ error: 'Forbidden: You do not belong to the owning team.' });
        }
        const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '20', 10)));
        const cursor = req.query.cursor as string | undefined;
        const args = {
            where: { workItemId: req.params.id },
            orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
            take: limit + 1,
            ...(cursor ? { cursor: { id: cursor }, skip: 0 } : {}),
        };
        const rows: any[] =
            kind === 'activities'
                ? await prisma.activityEvent.findMany({ ...args, include: { actor: { select: { id: true, name: true, email: true } } } })
                : await prisma.comment.findMany({ ...args, include: { author: { select: { id: true, name: true, email: true } } } });
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        res.json({ items: page, nextCursor: hasMore ? rows[limit].id : null });
    });
}

// 6. Create Work Item (with Idempotency-Key protection!)
app.post('/api/items', requireAuth, async (req, res) => {
    const user = req.user!;
    const idempotencyKey = req.header('Idempotency-Key');

    if (idempotencyKey) {
        const existing = await prisma.idempotencyKey.findUnique({
            where: { key: idempotencyKey },
        });
        if (existing && existing.userId === user.id) {
            return res
                .status(existing.responseCode)
                .set('X-Idempotent-Replay', 'true')
                .json(JSON.parse(existing.responseBody));
        }
    }

    const { title, description, type, priority, teamId, dueDate } = req.body;
    if (!title || !description || !teamId) {
        return res.status(400).json({ error: 'title, description, and teamId are required.' });
    }

    if (!hasMinRole(user, teamId, Role.MEMBER)) {
        return res.status(403).json({ error: 'Forbidden: Requires at least MEMBER role in target team.' });
    }

    try {
        const result = await prisma.$transaction(async (tx) => {
            const created = await tx.workItem.create({
                data: {
                    title,
                    description,
                    type: (type as WorkItemType) || WorkItemType.INTERNAL_TASK,
                    priority: (priority as Priority) || Priority.MEDIUM,
                    teamId,
                    createdById: user.id,
                    dueDate: dueDate ? new Date(dueDate) : null,
                },
                include: {
                    team: true,
                    assignee: { select: { id: true, name: true, email: true } },
                    createdBy: { select: { id: true, name: true, email: true } },
                },
            });

            await tx.activityEvent.create({
                data: {
                    workItemId: created.id,
                    actorId: user.id,
                    action: 'CREATED',
                    afterJson: JSON.stringify({
                        title: created.title,
                        status: created.status,
                        priority: created.priority,
                    }),
                },
            });

            await tx.job.create({
                data: {
                    type: 'INDEX_NEW_WORK_ITEM',
                    payload: JSON.stringify({ workItemId: created.id, title: created.title }),
                },
            });

            if (idempotencyKey) {
                await tx.idempotencyKey.create({
                    data: {
                        key: idempotencyKey,
                        userId: user.id,
                        responseCode: 201,
                        responseBody: JSON.stringify(created),
                    },
                });
            }

            return created;
        });

        res.status(201).json(result);
    } catch (err: any) {
        // Handle race condition where two identical Idempotency-Keys hit at the exact same millisecond
        if (idempotencyKey && err.code === 'P2002') {
            const existing = await prisma.idempotencyKey.findUnique({ where: { key: idempotencyKey } });
            if (existing && existing.userId !== user.id) {
                return res.status(409).json({ error: 'Idempotency-Key already used by another user.' });
            }
            if (existing) {
                return res
                    .status(existing.responseCode)
                    .set('X-Idempotent-Replay', 'true')
                    .json(JSON.parse(existing.responseBody));
            }
        }
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// 7. Claim Work Item Atomically (Prevents simultaneous double-claim!)
app.post('/api/items/:id/claim', requireAuth, async (req, res) => {
    const user = req.user!;
    const itemId = req.params.id;

    const item = await prisma.workItem.findUnique({ where: { id: itemId } });
    if (!item) return res.status(404).json({ error: 'Work item not found.' });

    if (!hasMinRole(user, item.teamId, Role.MEMBER)) {
        return res.status(403).json({ error: 'Forbidden: Only team members (MEMBER+) can claim items.' });
    }

    // Retry-safe: the current owner repeating their claim gets the same success, not a conflict.
    if (item.assigneeId === user.id) {
        const mine = await prisma.workItem.findUnique({
            where: { id: itemId },
            include: {
                team: true,
                assignee: { select: { id: true, name: true, email: true } },
                createdBy: { select: { id: true, name: true, email: true } },
            },
        });
        return res.set('X-Idempotent-Replay', 'true').json(mine);
    }

    const updated = await prisma.$transaction(async (tx) => {
        // Atomic conditional update: only succeeds if assigneeId is STILL null
        const claimResult = await tx.workItem.updateMany({
            where: {
                id: itemId,
                assigneeId: null,
            },
            data: {
                assigneeId: user.id,
                status: item.status === WorkItemStatus.OPEN ? WorkItemStatus.IN_PROGRESS : item.status,
                version: { increment: 1 },
                updatedAt: new Date(),
            },
        });

        if (claimResult.count === 0) {
            return null; // Someone else claimed it first!
        }

        const freshItem = await tx.workItem.findUnique({
            where: { id: itemId },
            include: {
                team: true,
                assignee: { select: { id: true, name: true, email: true } },
                createdBy: { select: { id: true, name: true, email: true } },
            },
        });

        await tx.activityEvent.create({
            data: {
                workItemId: itemId,
                actorId: user.id,
                action: 'CLAIMED',
                beforeJson: JSON.stringify({ assigneeId: null, status: item.status }),
                afterJson: JSON.stringify({ assigneeId: user.id, status: freshItem?.status }),
            },
        });

        await tx.job.create({
            data: {
                type: 'NOTIFY_CLAIM',
                payload: JSON.stringify({ workItemId: itemId, claimedBy: user.email }),
            },
        });

        return freshItem;
    });

    if (!updated) {
        const latest = await prisma.workItem.findUnique({
            where: { id: itemId },
            include: { assignee: { select: { id: true, name: true, email: true } } },
        });
        return res.status(409).json({
            error: `Conflict: This item has already been claimed by ${latest?.assignee?.name || 'another user'}.`,
            currentItem: latest,
        });
    }

    res.json(updated);
});

// 8. Update Work Item Fields with Optimistic Concurrency Control (version check!)
app.patch('/api/items/:id', requireAuth, async (req, res) => {
    const user = req.user!;
    const itemId = req.params.id;
    const { title, description, priority, assigneeId, resolutionNote, version } = req.body;

    if (typeof version !== 'number') {
        return res.status(400).json({ error: 'version (number) is required for optimistic locking.' });
    }

    const item = await prisma.workItem.findUnique({ where: { id: itemId } });
    if (!item) return res.status(404).json({ error: 'Work item not found.' });

    if (!hasMinRole(user, item.teamId, Role.MEMBER)) {
        return res.status(403).json({ error: 'Forbidden: Requires MEMBER role or higher to edit.' });
    }

    // Only LEAD or ADMIN can reassign an item that belongs to someone else to a third person
    if (
        assigneeId !== undefined &&
        assigneeId !== item.assigneeId &&
        assigneeId !== user.id &&
        !hasMinRole(user, item.teamId, Role.LEAD)
    ) {
        return res.status(403).json({ error: 'Forbidden: Only team LEADs can assign items to other users.' });
    }

    const updated = await prisma.$transaction(async (tx) => {
        const updateData: any = {
            version: { increment: 1 },
            updatedAt: new Date(),
        };
        if (title !== undefined) updateData.title = title;
        if (description !== undefined) updateData.description = description;
        if (priority !== undefined) updateData.priority = priority;
        if (assigneeId !== undefined) updateData.assigneeId = assigneeId;
        if (resolutionNote !== undefined) updateData.resolutionNote = resolutionNote;

        // Optimistic Lock check: WHERE id = itemId AND version = client's version
        const result = await tx.workItem.updateMany({
            where: { id: itemId, version },
            data: updateData,
        });

        if (result.count === 0) {
            return null; // Stale version detected!
        }

        const fresh = await tx.workItem.findUnique({
            where: { id: itemId },
            include: {
                team: true,
                assignee: { select: { id: true, name: true, email: true } },
                createdBy: { select: { id: true, name: true, email: true } },
            },
        });

        await tx.activityEvent.create({
            data: {
                workItemId: itemId,
                actorId: user.id,
                action: 'UPDATED',
                beforeJson: JSON.stringify({
                    title: item.title,
                    priority: item.priority,
                    assigneeId: item.assigneeId,
                    resolutionNote: item.resolutionNote,
                    version: item.version,
                }),
                afterJson: JSON.stringify({
                    title: fresh?.title,
                    priority: fresh?.priority,
                    assigneeId: fresh?.assigneeId,
                    resolutionNote: fresh?.resolutionNote,
                    version: fresh?.version,
                }),
            },
        });

        return fresh;
    });

    if (!updated) {
        const latest = await prisma.workItem.findUnique({
            where: { id: itemId },
            include: {
                team: true,
                assignee: { select: { id: true, name: true, email: true } },
            },
        });
        return res.status(409).json({
            error: 'Stale Edit Conflict: Another user modified this item since you loaded it. Please review the latest version.',
            currentItem: latest,
        });
    }

    res.json(updated);
});

// 9. Workflow State Transition (Enforces allowed transitions, required fields, & Lead approval!)
app.post('/api/items/:id/transition', requireAuth, async (req, res) => {
    const user = req.user!;
    const itemId = req.params.id;
    const { targetStatus, resolutionNote, version } = req.body as {
        targetStatus: WorkItemStatus;
        resolutionNote?: string;
        version: number;
    };

    if (!targetStatus || typeof version !== 'number') {
        return res.status(400).json({ error: 'targetStatus and version are required.' });
    }

    const item = await prisma.workItem.findUnique({ where: { id: itemId } });
    if (!item) return res.status(404).json({ error: 'Work item not found.' });

    if (!hasMinRole(user, item.teamId, Role.MEMBER)) {
        return res.status(403).json({ error: 'Forbidden: Requires MEMBER role or higher.' });
    }

    // Rule A: Check state machine validity
    const allowedNext = ALLOWED_TRANSITIONS[item.status] || [];
    if (!allowedNext.includes(targetStatus)) {
        return res.status(400).json({
            error: `Invalid workflow transition: Cannot move directly from ${item.status} to ${targetStatus}.`,
        });
    }

    // Rule B: High/Critical items or Incidents in IN_PROGRESS must go through AWAITING_APPROVAL before RESOLVED (unless user is already a LEAD)
    const isLeadOrAdmin = hasMinRole(user, item.teamId, Role.LEAD);
    if (
        item.status === WorkItemStatus.IN_PROGRESS &&
        targetStatus === WorkItemStatus.RESOLVED &&
        (item.priority === Priority.CRITICAL || item.priority === Priority.HIGH || item.type === WorkItemType.INCIDENT) &&
        !isLeadOrAdmin
    ) {
        return res.status(403).json({
            error: 'Workflow Policy: High/Critical items and Incidents must be moved to AWAITING_APPROVAL for Lead sign-off.',
        });
    }

    // Rule C: Approving an item out of AWAITING_APPROVAL -> RESOLVED requires LEAD or ADMIN role
    if (
        item.status === WorkItemStatus.AWAITING_APPROVAL &&
        targetStatus === WorkItemStatus.RESOLVED &&
        !isLeadOrAdmin
    ) {
        return res.status(403).json({
            error: 'Forbidden: Only a Team LEAD or ADMIN can approve and resolve items in AWAITING_APPROVAL.',
        });
    }

    // Rule D: Closing an item or requesting approval requires a resolutionNote
    const effectiveNote = resolutionNote !== undefined ? resolutionNote : item.resolutionNote;
    if (
        (targetStatus === WorkItemStatus.AWAITING_APPROVAL || targetStatus === WorkItemStatus.RESOLVED) &&
        (!effectiveNote || effectiveNote.trim().length < 5)
    ) {
        return res.status(400).json({
            error: 'Workflow Requirement: A resolution/investigation note (min 5 chars) is required before moving to AWAITING_APPROVAL or RESOLVED.',
        });
    }

    const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.workItem.updateMany({
            where: { id: itemId, version },
            data: {
                status: targetStatus,
                resolutionNote: effectiveNote,
                version: { increment: 1 },
                updatedAt: new Date(),
            },
        });

        if (result.count === 0) return null;

        const fresh = await tx.workItem.findUnique({
            where: { id: itemId },
            include: {
                team: true,
                assignee: { select: { id: true, name: true, email: true } },
                createdBy: { select: { id: true, name: true, email: true } },
            },
        });

        await tx.activityEvent.create({
            data: {
                workItemId: itemId,
                actorId: user.id,
                action:
                    item.status === WorkItemStatus.AWAITING_APPROVAL && targetStatus === WorkItemStatus.RESOLVED
                        ? 'APPROVED_AND_RESOLVED'
                        : 'STATUS_CHANGED',
                beforeJson: JSON.stringify({ status: item.status, version: item.version }),
                afterJson: JSON.stringify({ status: targetStatus, version: fresh?.version }),
            },
        });

        await tx.job.create({
            data: {
                type: 'NOTIFY_STATUS_TRANSITION',
                payload: JSON.stringify({
                    workItemId: itemId,
                    from: item.status,
                    to: targetStatus,
                    actor: user.email,
                }),
            },
        });

        return fresh;
    });

    if (!updated) {
        const latest = await prisma.workItem.findUnique({ where: { id: itemId } });
        return res.status(409).json({
            error: 'Conflict: Work item was modified by another user. Please refresh.',
            currentItem: latest,
        });
    }

    res.json(updated);
});

// 10. Add Comment
app.post('/api/items/:id/comments', requireAuth, async (req, res) => {
    const user = req.user!;
    const itemId = req.params.id;
    const { body } = req.body;

    if (!body || !body.trim()) {
        return res.status(400).json({ error: 'Comment body is required.' });
    }

    const item = await prisma.workItem.findUnique({ where: { id: itemId } });
    if (!item) return res.status(404).json({ error: 'Work item not found.' });

    if (!hasMinRole(user, item.teamId, Role.MEMBER)) {
        return res.status(403).json({ error: 'Forbidden: Viewers or non-team members cannot post comments.' });
    }

    const comment = await prisma.$transaction(async (tx) => {
        const created = await tx.comment.create({
            data: {
                workItemId: itemId,
                authorId: user.id,
                body: body.trim(),
            },
            include: { author: { select: { id: true, name: true, email: true } } },
        });

        await tx.activityEvent.create({
            data: {
                workItemId: itemId,
                actorId: user.id,
                action: 'COMMENTED',
                afterJson: JSON.stringify({ commentId: created.id, preview: body.trim().slice(0, 60) }),
            },
        });

        return created;
    });

    res.status(201).json(comment);
});

// 11. View Background Jobs Queue (Great for live demoing async job processing!)
app.get('/api/jobs', requireAuth, async (_req, res) => {
    const jobs = await prisma.job.findMany({
        orderBy: { createdAt: 'desc' },
        take: 25,
    });
    res.json(jobs);
});

// Trigger job processor manually (helpful for tests & demo)
app.post('/api/jobs/process', requireAuth, async (_req, res) => {
    await processPendingJobs();
    const jobs = await prisma.job.findMany({ orderBy: { createdAt: 'desc' }, take: 25 });
    res.json(jobs);
});

const PORT = process.env.PORT || 4000;

if (require.main === module) {
    startBackgroundWorker();
    app.listen(PORT, () => {
        console.log(`Newtonite Operations API running on http://localhost:${PORT}`);
    });
}