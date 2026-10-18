import { PrismaClient } from '@prisma/client';

// Used by the Docker entrypoint: seed only on the first start so restarts keep your data.
async function main() {
    const prisma = new PrismaClient();
    const users = await prisma.user.count();
    await prisma.$disconnect();
    if (users === 0) {
        console.log('Empty database: seeding...');
        await import('./seed');
    } else {
        console.log('Database already seeded, skipping.');
    }
}

main();
