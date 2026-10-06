import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // API tests that need Postgres use DATABASE_URL; keep them serial-friendly.
    pool: 'forks'
  }
})
