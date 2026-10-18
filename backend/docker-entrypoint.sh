#!/bin/sh
set -e
npx prisma migrate deploy
npx ts-node-dev --respawn=false --transpile-only prisma/seed-if-empty.ts
exec npx ts-node-dev --transpile-only src/app.ts
