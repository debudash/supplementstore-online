// GET /api/patients tests (docs/ARCHITECTURE.md section 8, AGENTS.md section 7).
//
// Real Postgres (DATABASE_URL). Migrations applied via the tsx CLI in beforeAll (the
// T2 pattern): knex raw-requires .ts migrations outside vite's transform, so
// db.migrate.latest() throws under vitest.
//
// The seed has 2 practices, each with one patient (Cara @ Riverside, Dev @ Summit).
// The critical assertion is practice scoping: prov-ana (Riverside) must NOT see
// prov-ben's (Summit) patient, and vice versa.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { db } from '../../src/db/knex'
import { createApp } from '../../src/app'
import { createKnexActorLoader } from '../../src/auth/loadActor'
import { seedCore } from '../../src/db/seeds/01_core'

const apiRoot = path.resolve(__dirname, '../..')
function migrateViaCli(): void {
  execFileSync('npm', ['run', 'db:migrate'], {
    cwd: apiRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
}

const app = createApp({ db, loadActor: createKnexActorLoader(db) })
const asUser = (userId: string) => request(app).get('/api/patients').set('X-Demo-User', userId)

const PATIENT_CARA = 'cccccccc-0000-0000-0000-000000000001'
const PATIENT_DEV = 'cccccccc-0000-0000-0000-000000000002'

beforeAll(async () => {
  migrateViaCli()
  await seedCore(db)
})

afterAll(async () => {
  await db.destroy()
})

describe('GET /api/patients', () => {
  it('returns { patients: [...] } with id and name', async () => {
    const res = await asUser('prov-ana')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.patients)).toBe(true)
    expect(res.body.patients.length).toBeGreaterThan(0)
    expect(res.body.patients[0]).toHaveProperty('id')
    expect(res.body.patients[0]).toHaveProperty('name')
  })

  it('scopes to the provider own practice: prov-ana sees only Cara (Riverside)', async () => {
    const res = await asUser('prov-ana')
    expect(res.status).toBe(200)
    const ids = res.body.patients.map((p: { id: string }) => p.id)
    expect(ids).toContain(PATIENT_CARA)
    expect(ids).not.toContain(PATIENT_DEV)
  })

  it('prov-ben sees only Dev (Summit), never the other practice patient', async () => {
    const res = await asUser('prov-ben')
    expect(res.status).toBe(200)
    const ids = res.body.patients.map((p: { id: string }) => p.id)
    expect(ids).toContain(PATIENT_DEV)
    expect(ids).not.toContain(PATIENT_CARA)
  })

  it('never leaks the full table: each provider sees exactly their practice roster', async () => {
    const ana = await asUser('prov-ana')
    const ben = await asUser('prov-ben')
    const anaIds = new Set(ana.body.patients.map((p: { id: string }) => p.id))
    const benIds = new Set(ben.body.patients.map((p: { id: string }) => p.id))
    // Disjoint rosters - no patient appears in both practices (ADR-010, section 7).
    for (const id of anaIds) expect(benIds.has(id)).toBe(false)
  })

  it('requires the provider role (patient is rejected by the guard)', async () => {
    const res = await asUser('pat-cara')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })
})
