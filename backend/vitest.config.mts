import { defineConfig } from 'vitest/config';

// Tests hit a real (possibly remote, e.g. Neon) Postgres, so allow generous timeouts.
export default defineConfig({
    test: { testTimeout: 60000, hookTimeout: 60000 },
});
