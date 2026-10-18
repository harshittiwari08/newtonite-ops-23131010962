import { PrismaClient, Role, WorkItemType, Priority, WorkItemStatus } from '@prisma/client';
import process from 'process';

const prisma = new PrismaClient();

async function main() {
    console.log('🌱 Cleaning existing data...');
    await prisma.activityEvent.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.idempotencyKey.deleteMany();
    await prisma.job.deleteMany();
    await prisma.workItem.deleteMany();
    await prisma.membership.deleteMany();
    await prisma.user.deleteMany();
    await prisma.team.deleteMany();

    console.log('🏢 Creating Teams...');
    const engTeam = await prisma.team.create({ data: { name: 'Engineering' } });
    const payTeam = await prisma.team.create({ data: { name: 'Payments' } });
    const compTeam = await prisma.team.create({ data: { name: 'Compliance' } });

    console.log('👥 Creating Users & Role Memberships...');
    const alice = await prisma.user.create({
        data: {
            email: 'alice.lead@newtonite.com',
            name: 'Alice Sharma (Eng Lead)',
            password: 'password123',
            memberships: {
                create: [
                    { teamId: engTeam.id, role: Role.LEAD },
                    { teamId: payTeam.id, role: Role.VIEWER },
                ],
            },
        },
    });

    const bob = await prisma.user.create({
        data: {
            email: 'bob.member@newtonite.com',
            name: 'Bob Verma (Eng Member)',
            password: 'password123',
            memberships: {
                create: [{ teamId: engTeam.id, role: Role.MEMBER }],
            },
        },
    });

    const charlie = await prisma.user.create({
        data: {
            email: 'charlie.member@newtonite.com',
            name: 'Charlie Nair (Eng Member)',
            password: 'password123',
            memberships: {
                create: [{ teamId: engTeam.id, role: Role.MEMBER }],
            },
        },
    });

    const diana = await prisma.user.create({
        data: {
            email: 'diana.lead@newtonite.com',
            name: 'Diana Patel (Payments Lead)',
            password: 'password123',
            memberships: {
                create: [{ teamId: payTeam.id, role: Role.LEAD }],
            },
        },
    });

    const evan = await prisma.user.create({
        data: {
            email: 'evan.member@newtonite.com',
            name: 'Evan Gupta (Compliance Member)',
            password: 'password123',
            memberships: {
                create: [{ teamId: compTeam.id, role: Role.MEMBER }],
            },
        },
    });

    const admin = await prisma.user.create({
        data: {
            email: 'admin@newtonite.com',
            name: 'Vikram Singh (Global Admin)',
            password: 'password123',
            memberships: {
                create: [
                    { teamId: engTeam.id, role: Role.ADMIN },
                    { teamId: payTeam.id, role: Role.ADMIN },
                    { teamId: compTeam.id, role: Role.ADMIN },
                ],
            },
        },
    });

    console.log('📋 Creating Featured Demo Work Items...');
    // 1. Unassigned Critical Incident (great for testing Simultaneous Claim!)
    const item1 = await prisma.workItem.create({
        data: {
            title: 'Production API Gateway Latency Spike in Mumbai Region',
            description: 'P99 latency crossed 4.2s on checkout endpoints. Needs immediate investigation.',
            type: WorkItemType.INCIDENT,
            priority: Priority.CRITICAL,
            status: WorkItemStatus.OPEN,
            teamId: engTeam.id,
            createdById: alice.id,
            dueDate: new Date(Date.now() + 4 * 3600 * 1000),
        },
    });

    await prisma.activityEvent.create({
        data: {
            workItemId: item1.id,
            actorId: alice.id,
            action: 'CREATED',
            afterJson: JSON.stringify({ status: 'OPEN', priority: 'CRITICAL' }),
        },
    });

    // 2. Item Awaiting Lead Approval (great for testing RBAC & Workflow Rules!)
    const item2 = await prisma.workItem.create({
        data: {
            title: 'Database Connection Pool Increase for Order Service',
            description: 'Root cause identified: pool size exhausted during flash sale. Ready for Lead sign-off.',
            type: WorkItemType.INCIDENT,
            priority: Priority.HIGH,
            status: WorkItemStatus.AWAITING_APPROVAL,
            resolutionNote: 'Verified load test results at 500 RPS after increasing pool max to 80.',
            teamId: engTeam.id,
            assigneeId: bob.id,
            createdById: bob.id,
            version: 2,
        },
    });

    await prisma.activityEvent.createMany({
        data: [
            {
                workItemId: item2.id,
                actorId: bob.id,
                action: 'CREATED',
                afterJson: JSON.stringify({ status: 'OPEN' }),
            },
            {
                workItemId: item2.id,
                actorId: bob.id,
                action: 'STATUS_CHANGED',
                beforeJson: JSON.stringify({ status: 'IN_PROGRESS' }),
                afterJson: JSON.stringify({ status: 'AWAITING_APPROVAL' }),
            },
        ],
    });

    // 3. Payments Investigation Item (great for testing Cross-Team Access Blocking!)
    await prisma.workItem.create({
        data: {
            title: 'UPI Settlement Mismatch Batch #88412',
            description: 'Reconciliation job flagged 14 transactions stuck in pending state with partner bank.',
            type: WorkItemType.PAYMENT_INVESTIGATION,
            priority: Priority.HIGH,
            status: WorkItemStatus.IN_PROGRESS,
            teamId: payTeam.id,
            assigneeId: diana.id,
            createdById: diana.id,
        },
    });

    console.log('⚡ Generating 1,000 bulk items to test scale & pagination...');
    const statuses = [
        WorkItemStatus.OPEN,
        WorkItemStatus.IN_PROGRESS,
        WorkItemStatus.AWAITING_APPROVAL,
        WorkItemStatus.RESOLVED,
        WorkItemStatus.CLOSED,
    ];
    const priorities = [Priority.LOW, Priority.MEDIUM, Priority.HIGH, Priority.CRITICAL];
    const types = [
        WorkItemType.INCIDENT,
        WorkItemType.CUSTOMER_ISSUE,
        WorkItemType.PAYMENT_INVESTIGATION,
        WorkItemType.COMPLIANCE_REQUEST,
        WorkItemType.INTERNAL_TASK,
    ];
    const teams = [engTeam.id, payTeam.id, compTeam.id];
    const users = [alice.id, bob.id, charlie.id, diana.id, evan.id, null];

    const bulkItems = Array.from({ length: 1000 }).map((_, i) => ({
        title: `Operational Work Item #${i + 100} - System Check & Audit`,
        description: `Automated operational record #${i + 100} generated for load and index verification.`,
        type: types[i % types.length],
        priority: priorities[i % priorities.length],
        status: statuses[i % statuses.length],
        teamId: teams[i % teams.length],
        assigneeId: users[i % users.length],
        createdById: alice.id,
    }));

    await prisma.workItem.createMany({ data: bulkItems });

    console.log('✅ Seeding complete! Created 3 teams, 6 users, and 1,003 work items.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });