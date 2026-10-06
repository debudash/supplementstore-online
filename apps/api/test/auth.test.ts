import { describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Knex } from 'knex'
import { createApp } from '../src/app'
import type { Actor, ActorLoader } from '../src/auth/types'

// Auth middleware tests run WITHOUT a database: the actor loader is injected and
// the db is never touched (no route under test hits it).
const fakeDb = {} as unknown as Knex

const USERS: Record<string, Actor> = {
  'prov-ana': { id: 'prov-ana', role: 'provider', providerId: 'p-ana', practiceId: 'pr-river' },
  'pat-cara': { id: 'pat-cara', role: 'patient', patientId: 'pt-cara', practiceId: 'pr-river' },
  'admin-cerbo': { id: 'admin-cerbo', role: 'cerbo_admin' }
}

const loadActor: ActorLoader = async (id) => USERS[id] ?? null

function app() {
  return createApp({ db: fakeDb, loadActor })
}

describe('demo-user auth middleware', () => {
  it('rejects a request with no X-Demo-User header (401)', async () => {
    const res = await request(app()).get('/api/orders')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('rejects an unknown user (401)', async () => {
    const res = await request(app()).get('/api/orders').set('X-Demo-User', 'nobody')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('rejects a known user with the wrong role (403)', async () => {
    // A patient hitting a provider-only route.
    const res = await request(app()).get('/api/orders').set('X-Demo-User', 'pat-cara')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('blocks a provider from Cerbo Admin routes (403) - RT-09', async () => {
    const res = await request(app()).get('/api/admin/metrics').set('X-Demo-User', 'prov-ana')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('lets an authorized role (provider) pass the role guard', async () => {
    // The guard must ADMIT an authorized actor. We assert only that: the response is
    // not a guard rejection (401/403, FORBIDDEN/UNAUTHENTICATED). This stays true for
    // the life of the project regardless of whether the route is still a 501 stub or
    // has since been implemented (200, 404, 500, ...) by a later task - so no other
    // task has to edit this file when it implements the route behind the guard.
    const res = await request(app()).get('/api/orders').set('X-Demo-User', 'prov-ana')
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
    expect(['UNAUTHENTICATED', 'FORBIDDEN']).not.toContain(res.body?.error?.code)
  })
})
