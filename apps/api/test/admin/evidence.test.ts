// Admin Evidence page API, the one-click demo story reset, and the profit-simulator price
// preview. Uses one real paid order so every section has data.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { db } from '../../src/db/knex'
import { createApp } from '../../src/app'
import { createKnexActorLoader } from '../../src/auth/loadActor'
import { seedCore } from '../../src/db/seeds/01_core'

const apiRoot = path.resolve(__dirname, '../..')
const app = createApp({ db, loadActor: createKnexActorLoader(db) })
const ADMIN = 'admin-cerbo'
const PROVIDER = 'prov-ana'
const as = (u: string) => ({
  get: (url: string) => request(app).get(url).set('X-Demo-User', u),
  post: (url: string) => request(app).post(url).set('X-Demo-User', u)
})

let ourOrderId = ''

beforeAll(async () => {
  process.env.DEMO_MODE = 'true'
  execFileSync('npm', ['run', 'db:migrate'], { cwd: apiRoot, stdio: 'inherit', shell: process.platform === 'win32' })
  await seedCore(db)
  await db('products').where({ sku: 'MAG-GLY-120' }).update({ on_hand_qty: 50, reserved_qty: 0 })
  const patient = (await as(PROVIDER).get('/api/patients')).body.patients[0]
  const draft = await as(PROVIDER).post('/api/orders').send({ patientId: patient.id })
  await as(PROVIDER).post(`/api/orders/${draft.body.id}/lines`).send({ sku: 'MAG-GLY-120', qty: 1, unitPriceCents: 2999 })
  const sent = await as(PROVIDER).post(`/api/orders/${draft.body.id}/send`)
  await request(app).post(`/api/pay/${String(sent.body.payUrl).split('/').pop()}`).send({ idempotencyKey: `ev-${draft.body.id}` })
  ourOrderId = draft.body.id
})
afterAll(async () => {
  await db.destroy()
})

describe('GET /api/admin/evidence', () => {
  it('reports a balanced ledger, our order passing, and every guard present', async () => {
    const res = await as(ADMIN).get('/api/admin/evidence')
    expect(res.status).toBe(200)
    const i = res.body.integrity
    expect(i.journals.unbalanced).toBe(0)
    expect(i.orders.checked).toBeGreaterThan(0)
    // Other suites share this database and plant deliberately odd fixtures (e.g. a
    // backdated order with totals but no lines), which Evidence rightly flags. Assert on
    // the order this suite created through the real flow.
    expect(i.orders.failures.map((f: { orderId: string }) => f.orderId)).not.toContain(ourOrderId)
    expect(i.orders.passing + i.orders.failing).toBe(i.orders.checked)
    expect(i.guards.missing).toEqual([])
    expect(i.guards.present).toBe(13)
  })

  it('flags an order whose line fees do not add up to the order fee', async () => {
    const [bad] = await db('orders')
      .insert({
        provider_id: (await db('orders').where({ id: ourOrderId }).first()).provider_id,
        practice_id: (await db('orders').where({ id: ourOrderId }).first()).practice_id,
        patient_id: (await db('orders').where({ id: ourOrderId }).first()).patient_id,
        kind: 'one_off', status: 'paid', fee_bps: 75, subtotal_cents: 1000, cogs_cents: 500, fee_cents: 8, margin_cents: 492
      })
      .returning('id')
    const res = await as(ADMIN).get('/api/admin/evidence')
    const failure = res.body.integrity.orders.failures.find((f: { orderId: string }) => f.orderId === bad.id)
    expect(failure?.failedChecks).toContain('lines.fee_allocation_sums_to_order_fee')
  })

  it('computes unit economics with the processing assumption (money package)', async () => {
    const res = await as(ADMIN).get('/api/admin/evidence?processingRateBps=0&processingFixedCents=0')
    const u = res.body.unitEconomics
    expect(u.assumptions).toEqual({ processingRateBps: 0, processingFixedCents: 0, platformFeeBps: 75 })
    expect(u.processingCostCents).toBe(0)
    expect(u.cerboNetCents).toBe(u.platformFeeCents)

    const dflt = (await as(ADMIN).get('/api/admin/evidence')).body.unitEconomics
    expect(dflt.assumptions.processingRateBps).toBe(290)
    expect(dflt.processingCostCents).toBeGreaterThan(dflt.platformFeeCents) // 2.9% + 30c beats 0.75%
    expect(dflt.breakevenFeeBps).toBeGreaterThan(75)
    expect(res.body.refundExposure).toHaveProperty('cogsWrittenOffCents')
  })

  it('validates assumptions and is admin only', async () => {
    expect((await as(ADMIN).get('/api/admin/evidence?processingRateBps=abc')).status).toBe(400)
    expect((await as(ADMIN).get('/api/admin/evidence?processingRateBps=5000')).status).toBe(400)
    expect((await as(PROVIDER).get('/api/admin/evidence')).status).toBe(403)
  })
})

describe('POST /api/admin/demo/reset-story', () => {
  it('purges and regenerates the same story each time, without touching real orders', async () => {
    const realBefore = Number((await db('orders').where({ is_synthetic: false }).count<{ count: string }[]>('* as count'))[0].count)
    // A shared test database can hold a protected-test fixture: a REAL journal on a
    // synthetic order, which by design can never be purged. Then the reset must refuse
    // clearly (409) and change nothing; otherwise it must succeed deterministically.
    const blocked = await db('journals as j')
      .join('orders as o', 'o.id', 'j.order_id')
      .where('o.is_synthetic', true)
      .where('j.is_synthetic', false)
      .first('j.id')
    const first = await as(ADMIN).post('/api/admin/demo/reset-story')
    if (blocked) {
      expect(first.status).toBe(409)
      expect(first.body.error.code).toBe('DEMO_RESET_BLOCKED')
      expect(first.body.error.details.journals).toBeGreaterThan(0)
      const realAfterBlocked = Number((await db('orders').where({ is_synthetic: false }).count<{ count: string }[]>('* as count'))[0].count)
      expect(realAfterBlocked).toBe(realBefore)
      return
    }
    expect(first.status).toBe(201)
    expect(first.body.migration.orderCount).toBeGreaterThan(0)
    const second = await as(ADMIN).post('/api/admin/demo/reset-story')
    expect(second.body.migration.orderCount).toBe(first.body.migration.orderCount)
    expect(second.body.migration.gmvCents).toBe(first.body.migration.gmvCents)
    expect(second.body.reset.purged.orders).toBe(first.body.migration.orderCount)
    const realAfter = Number((await db('orders').where({ is_synthetic: false }).count<{ count: string }[]>('* as count'))[0].count)
    expect(realAfter).toBe(realBefore)
    expect((await as(PROVIDER).post('/api/admin/demo/reset-story')).status).toBe(403)
  })
})

describe('profit simulator preview', () => {
  it('returns the split for a quantity, at list price or a margin', async () => {
    const list = (await as(PROVIDER).get('/api/products/MAG-GLY-120/price-preview?qty=10')).body
    expect(list).toMatchObject({ marginBps: null, unitPriceCents: 2999, qty: 10, lineTotalCents: 29990, lineCogsCents: 14500, lineFeeCents: 225, lineMarginCents: 15265, coversFee: true })
    const thin = (await as(PROVIDER).get('/api/products/MAG-GLY-120/price-preview?marginBps=0&qty=3')).body
    expect(thin).toMatchObject({ coversFee: false, lineFeeCents: null, lineMarginCents: null, lineTotalCents: 4350 })
    expect((await as(PROVIDER).get('/api/products/MAG-GLY-120/price-preview?qty=1001')).status).toBe(400)
  })
})
