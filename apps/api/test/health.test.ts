import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Knex } from 'knex'
import { db } from '../src/db/knex'
import { createApp } from '../src/app'
import { seedCore } from '../src/db/seeds/01_core'
import type { ActorLoader } from '../src/auth/types'

// Health hits the real database (FR-17 AC2) and is the deploy readiness gate: it is
// 200 only when the catalog is migrated and seeded. CI provides a Postgres service and
// DATABASE_URL; locally run `docker compose up -d db` first.
const loadActor: ActorLoader = async () => null
const apiRoot = path.resolve(__dirname, '..')

describe('GET /api/health', () => {
  const app = createApp({ db, loadActor })

  beforeAll(async () => {
    execFileSync('npm', ['run', 'db:migrate'], { cwd: apiRoot, stdio: 'inherit', shell: process.platform === 'win32' })
    await seedCore(db)
  })
  afterAll(async () => {
    await db.destroy()
  })

  it('returns 200 with database connectivity and a ready catalog', async () => {
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.db).toEqual({ connected: true })
    expect(res.body.catalog.ready).toBe(true)
    expect(res.body.catalog.products).toBeGreaterThanOrEqual(5)
  })

  it('returns 503 degraded when connected but the catalog is empty or missing', async () => {
    const emptyDb = {
      raw: async (sql: string) => (sql.includes('products') ? { rows: [{ n: 0 }] } : { rows: [{ '?column?': 1 }] })
    } as unknown as Knex
    const empty = await request(createApp({ db: emptyDb, loadActor })).get('/api/health')
    expect(empty.status).toBe(503)
    expect(empty.body).toEqual({ status: 'degraded', db: { connected: true }, catalog: { ready: false, products: 0 } })

    const unmigratedDb = {
      raw: async (sql: string) => {
        if (sql.includes('products')) throw new Error('relation "products" does not exist')
        return { rows: [{ '?column?': 1 }] }
      }
    } as unknown as Knex
    const unmigrated = await request(createApp({ db: unmigratedDb, loadActor })).get('/api/health')
    expect(unmigrated.status).toBe(503)
    expect(unmigrated.body.catalog).toEqual({ ready: false, products: 0 })
  })

  it('returns 503 error when the database is unreachable', async () => {
    const downDb = { raw: async () => { throw new Error('connect ECONNREFUSED') } } as unknown as Knex
    const res = await request(createApp({ db: downDb, loadActor })).get('/api/health')
    expect(res.status).toBe(503)
    expect(res.body.status).toBe('error')
    expect(res.body.db.connected).toBe(false)
  })
})
