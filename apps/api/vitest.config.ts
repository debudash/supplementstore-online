import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // API tests that need Postgres use DATABASE_URL; keep them serial-friendly.
    pool: 'forks',
    // Run test FILES serially. These are DB-bound integration tests that share ONE
    // Postgres, and several do global mutations (stock resets in beforeEach, the
    // reservation-expiry sweep in EVAL-14, payment stock changes). Parallel files
    // corrupt each other's state; serialising removes that. It also stops parallel
    // forks from contending on knex_migrations_lock when each runs db:migrate.
    // Tradeoff: slower wall-clock than parallel, but correctness wins for a shared-DB
    // suite. (If this grows painfully slow as more files land, revisit per-file DBs.)
    fileParallelism: false
  }
})
