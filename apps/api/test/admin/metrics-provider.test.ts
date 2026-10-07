// Admin metrics provider filter: GET /api/admin/providers lists every provider with its
// practice, and GET /api/admin/metrics?providerId= scopes the WHOLE report to that
// provider - its headline equals that provider's row in the unscoped provider breakdown.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { db } from '../../src/db/knex'
import { createApp } from '../../src/app'
import { createKnexActorLoader } from '../../src/auth/loadActor'
import { seedCore } from '../../src/db/seeds/01_core'
import { markupFor } from '../pricing'

const apiRoot = path.resolve(__dirname, '../..')
const app = createApp({ db, loadActor: createKnexActorLoader(db) })
const ADMIN = 'admin-cerbo'
const PROVIDER = 'prov-ana'
const get = (url: string, user = ADMIN) => request(app).get(url).set('X-Demo-User', user)

let anaId = ''

beforeAll(async () => {
  execFileSync('npm', ['run', 'db:migrate'], { cwd: apiRoot, stdio: 'inherit', shell: process.platform === 'win32' })
  await seedCore(db)
  await db('products').where({ sku: 'MAG-GLY-120' }).update({ on_hand_qty: 50, reserved_qty: 0 })
  anaId = (await db('users').where({ id: PROVIDER }).first()).provider_id

  // One paid order for Dr. Ana so her scoped figures are non-zero.
  const asAna = (url: string) => request(app).post(url).set('X-Demo-User', PROVIDER)
  const patient = (await get('/api/patients', PROVIDER)).body.patients[0]
  const draft = await asAna('/api/orders').send({ patientId: patient.id })
  await asAna(`/api/orders/${draft.body.id}/lines`).send({ sku: 'MAG-GLY-120', qty: 2, markupCents: markupFor('MAG-GLY-120', 2999) })
  const sent = await asAna(`/api/orders/${draft.body.id}/send`)
  const token = String(sent.body.payUrl).split('/').pop()
  await request(app).post(`/api/pay/${token}`).send({ idempotencyKey: `mp-${draft.body.id}` })
})
afterAll(async () => {
  await db.destroy()
})

describe('GET /api/admin/providers', () => {
  it('lists providers with their practice, admin only', async () => {
    const res = await get('/api/admin/providers')
    expect(res.status).toBe(200)
    const ana = res.body.providers.find((p: { id: string }) => p.id === anaId)
    expect(ana).toMatchObject({ name: 'Dr. Ana Reyes', practiceName: 'Riverside Integrative' })
    expect((await get('/api/admin/providers', PROVIDER)).status).toBe(403)
  })
})

describe('GET /api/admin/metrics?providerId=', () => {
  it('scopes the whole report to one provider and matches their breakdown row', async () => {
    const all = await get('/api/admin/metrics?groupBy=provider')
    const anaRow = all.body.groups.find((g: { key: string }) => g.key === anaId)
    expect(anaRow).toBeTruthy()
    expect(all.body.providerId).toBeNull()

    const scoped = await get(`/api/admin/metrics?groupBy=provider&providerId=${anaId}`)
    expect(scoped.status).toBe(200)
    expect(scoped.body.providerId).toBe(anaId)
    expect(scoped.body.headline).toEqual(anaRow.block)
    expect(scoped.body.groups.map((g: { key: string }) => g.key)).toEqual([anaId])
    expect(scoped.body.reconciliation.pass).toBe(true)
    expect(scoped.body.providerNames[anaId]).toMatchObject({ providerName: 'Dr. Ana Reyes' })
    for (const p of scoped.body.migration.providers) expect(p.providerId).toBe(anaId)
  })

  it('rejects a malformed id (400) and an unknown provider (404)', async () => {
    expect((await get('/api/admin/metrics?providerId=not-a-uuid')).status).toBe(400)
    expect((await get('/api/admin/metrics?providerId=00000000-0000-0000-0000-000000000000')).status).toBe(404)
  })
})
