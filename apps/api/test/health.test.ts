import { afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { db } from '../src/db/knex'
import { createApp } from '../src/app'
import type { ActorLoader } from '../src/auth/types'

// Health hits the real database (FR-17 AC2). CI provides a Postgres service and
// DATABASE_URL; locally run `docker compose up -d db` first.
const loadActor: ActorLoader = async () => null

describe('GET /api/health', () => {
  const app = createApp({ db, loadActor })

  afterAll(async () => {
    await db.destroy()
  })

  it('returns 200 with database connectivity status', async () => {
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok', db: { connected: true } })
  })
})
