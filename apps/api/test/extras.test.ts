// Low-risk extras: display names instead of ids, paidAt on the pay result, a whole-day
// `to` filter on orders, and refusing to close a month that has not ended. One real order
// flow (draft -> line -> send -> pay) through the HTTP API feeds every assertion.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { db } from '../src/db/knex'
import { createApp } from '../src/app'
import { createKnexActorLoader } from '../src/auth/loadActor'
import { seedCore } from '../src/db/seeds/01_core'

const apiRoot = path.resolve(__dirname, '..')
const app = createApp({ db, loadActor: createKnexActorLoader(db) })
const PROVIDER = 'prov-ana'
const ADMIN = 'admin-cerbo'
const as = (u: string) => ({
  get: (url: string) => request(app).get(url).set('X-Demo-User', u),
  post: (url: string) => request(app).post(url).set('X-Demo-User', u)
})

let orderId = ''
let payToken = ''
let patientName = ''
let firstPay: request.Response

beforeAll(async () => {
  execFileSync('npm', ['run', 'db:migrate'], { cwd: apiRoot, stdio: 'inherit', shell: process.platform === 'win32' })
  await seedCore(db)
  await db('products').where({ sku: 'MAG-GLY-120' }).update({ on_hand_qty: 50, reserved_qty: 0 })

  const patients = (await as(PROVIDER).get('/api/patients')).body.patients
  patientName = patients[0].name
  const draft = await as(PROVIDER).post('/api/orders').send({ patientId: patients[0].id })
  orderId = draft.body.id
  await as(PROVIDER).post(`/api/orders/${orderId}/lines`).send({ sku: 'MAG-GLY-120', qty: 1, unitPriceCents: 2999 })
  const sent = await as(PROVIDER).post(`/api/orders/${orderId}/send`)
  payToken = String(sent.body.payUrl).split('/').pop() as string
  firstPay = await request(app).post(`/api/pay/${payToken}`).send({ idempotencyKey: `k-${randomUUID()}` })
})
afterAll(async () => {
  await db.destroy()
})

describe('patient pay link', () => {
  it('returns the practice and provider names from a separate endpoint', async () => {
    const res = await request(app).get(`/api/pay/${payToken}/practice`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ practiceName: 'Riverside Integrative', providerName: expect.any(String) })
    expect((await request(app).get('/api/pay/not-a-token/practice')).status).toBe(404)
  })

  it('keeps the pay view whitelist exactly as before (no names, no economics)', async () => {
    const res = await request(app).get(`/api/pay/${payToken}`)
    expect(Object.keys(res.body).sort()).toEqual(['items', 'patientFirstName', 'status', 'totalCents'])
  })

  it('returns paidAt, and the same paidAt on an idempotent replay', async () => {
    expect(firstPay.status).toBe(200)
    expect(Date.parse(firstPay.body.paidAt)).not.toBeNaN()
    const key = (await db('payments').where({ order_id: orderId }).first()).idempotency_key
    const replay = await request(app).post(`/api/pay/${payToken}`).send({ idempotencyKey: key })
    expect(replay.status).toBe(200)
    expect(replay.body.paymentId).toBe(firstPay.body.paymentId)
    expect(Date.parse(replay.body.paidAt)).toBe(Date.parse(firstPay.body.paidAt))
  })
})

describe('names instead of ids', () => {
  it('audit includes patient, provider and practice names', async () => {
    const res = await as(PROVIDER).get(`/api/orders/${orderId}/audit`)
    expect(res.body.order).toMatchObject({ patientName, practiceName: 'Riverside Integrative' })
    expect(typeof res.body.order.providerName).toBe('string')
  })

  it('provider payables contributing orders carry the patient name', async () => {
    const res = await as(PROVIDER).get('/api/reports/payables')
    const row = res.body.contributingOrders.find((o: { orderId: string }) => o.orderId === orderId)
    expect(row).toMatchObject({ patientName })
  })

  it('admin payables and metrics name the provider', async () => {
    const now = new Date()
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    const pay = await as(ADMIN).get(`/api/admin/payables?month=${month}`)
    const stmt = pay.body.statements.find((s: { practiceName: string | null }) => s.practiceName === 'Riverside Integrative')
    expect(stmt?.providerName).toEqual(expect.any(String))

    const metrics = await as(ADMIN).get('/api/admin/metrics?groupBy=provider')
    expect(metrics.status).toBe(200)
    const names = Object.values(metrics.body.providerNames) as Array<{ practiceName: string | null }>
    expect(names.some((n) => n.practiceName === 'Riverside Integrative')).toBe(true)
  })
})

describe('orders `to` filter', () => {
  it('a date-only `to` includes the whole UTC day', async () => {
    const created = await db('orders').where({ id: orderId }).first('created_at')
    const day = new Date(created.created_at).toISOString().slice(0, 10)
    const res = await as(PROVIDER).get(`/api/orders?from=${day}&to=${day}`)
    expect(res.body.orders.map((o: { id: string }) => o.id)).toContain(orderId)
    expect((await as(PROVIDER).get(`/api/orders?to=2026-02-31`)).status).toBe(400)
  })
})

describe('admin month close', () => {
  it('refuses to close the current or a future month (PERIOD_NOT_ENDED)', async () => {
    const now = new Date()
    const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    for (const month of [current, '2999-01']) {
      const res = await as(ADMIN).post('/api/admin/payables/close').send({ month })
      expect(res.status, month).toBe(409)
      expect(res.body.error.code).toBe('PERIOD_NOT_ENDED')
    }
  })
})
