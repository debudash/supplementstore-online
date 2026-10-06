// Vitest config for the web workspace (T6). Uses the root-hoisted `vitest` dev
// dependency (no new dependency added). The order-UI tests are pure-logic tests of
// the display/alert helpers, so the default node environment is sufficient - no DOM
// test harness (@vue/test-utils) is pulled in, per the scope guardrails.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
