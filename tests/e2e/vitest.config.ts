import { defineConfig } from 'vitest/config'

// T13 e2e config. `npm run test:e2e` runs `vitest run --root tests/e2e`, so this file
// is the project root config for the golden suite.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['golden/**/*.spec.ts'],
    globalSetup: ['./golden/global-setup.ts'],
    // Shared real Postgres + one inventory pool: run spec FILES serially. Several
    // scenarios do global stock mutations (pay sells stock, EVAL-14 expiry, the
    // concurrency cases), which would race across parallel files. Correctness over
    // wall-clock - the same tradeoff apps/api/vitest.config.ts makes for its DB suite.
    fileParallelism: false,
    pool: 'forks',
    // Migrations + seed run in global setup; individual DB-bound scenarios are slower
    // than pure unit tests, so give hooks and tests generous headroom for CI runners.
    hookTimeout: 120_000,
    testTimeout: 60_000
  }
})
