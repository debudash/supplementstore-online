// T13 e2e global setup/teardown (vitest `globalSetup`).
//
// Setup (runs once, before any spec):
//   1. Apply migrations via the tsx CLI - `npm run db:migrate`. We DO NOT call
//      db.migrate.latest() here: knex raw-requires the .ts migration files outside
//      vite's transform, so it throws SyntaxError under vitest. The CLI runs under tsx
//      and loads .ts fine. (This mirrors the proven apps/api test pattern and the
//      explicit warning in the T13 brief.)
//   2. Seed the canonical fixtures via `npm run db:seed` (idempotent).
//   3. Clear the previous run's results log.
//
// Teardown (runs once, after all specs): build and print the id-by-id pass report and
// write tests/e2e/RESULTS.md - the acceptance artifact the owner presents.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { buildSummary, clearResults } from './reporter'

const apiRoot = path.resolve(__dirname, '..', '..', '..', 'apps', 'api')

function run(script: string): void {
  // Run from apps/api so the workspace script resolves; inherit stdio for CI logs.
  execFileSync('npm', ['run', script], {
    cwd: apiRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
}

export async function setup(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set for the e2e suite (real Postgres, no mocks).')
  }
  clearResults()
  run('db:migrate')
  run('db:seed')
}

export async function teardown(): Promise<void> {
  const report = buildSummary()
  console.log('\n' + report + '\n')
}
