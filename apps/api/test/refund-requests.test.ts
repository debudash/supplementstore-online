// Patient refund requests (ADR-026, ADR-027). The patient asks (unopened, within 30 days
// of payment); the provider approves (the standard refund path runs immediately) or
// declines with a note, in-app or through the request's review link. Guards: own paid
// orders only, one open request at a time, ownership 404s, and closing a request on an
// order Cerbo Admin already refunded.
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
// An isolated world (own practices, providers, patients and users) so the refunded orders
// this suite leaves behind never touch the seeded providers other suites clean up.
const tag = randomUUID().slice(0, 8)
const ANA = `rr-prov-a-${tag}`
const BEN = `rr-prov-b-${tag}`
const CARA = `rr-pat-a-${tag}`
const DEV = `rr-pat-b-${tag}`
const ADMIN = 'admin-cerbo'

async function makeWorld(): Promise<void> {
  const [pracA, pracB, provA, provB, patA, patB] = Array.from({ length: 6 }, () => randomUUID())
  await db('practices').insert([{ id: pracA, name: `RR Practice A ${tag}` }, { id: pracB, name: `RR Practice B ${tag}` }])
  await db('providers').insert([
    { id: provA, practice_id: pracA, name: 'Dr RR A', email: `${ANA}@rr.example` },
    { id: provB, practice_id: pracB, name: 'Dr RR B', email: `${BEN}@rr.example` }
  ])
  await db('patients').insert([
    { id: patA, practice_id: pracA, name: 'Pat RR A', email: `${CARA}@rr.example`, ship_to: '1 RR St' },
    { id: patB, practice_id: pracB, name: 'Pat RR B', email: `${DEV}@rr.example`, ship_to: '2 RR St' }
  ])
  await db('users').insert([
    { id: ANA, role: 'provider', provider_id: provA, patient_id: null, display_name: 'Dr RR A' },
    { id: BEN, role: 'provider', provider_id: provB, patient_id: null, display_name: 'Dr RR B' },
    { id: CARA, role: 'patient', provider_id: null, patient_id: patA, display_name: 'Pat RR A' },
    { id: DEV, role: 'patient', provider_id: null, patient_id: patB, display_name: 'Pat RR B' }
  ])
}
const as = (u: string) => ({
  get: (url: string) => request(app).get(url).set('X-Demo-User', u),
  post: (url: string) => request(app).post(url).set('X-Demo-User', u)
})

/** A real order for Cara from Dr. Ana; paid unless `pay` is false. */
async function orderForCara(pay = true): Promise<string> {
  const caraPatientId = (await db('users').where({ id: CARA }).first()).patient_id
  const draft = await as(ANA).post('/api/orders').send({ patientId: caraPatientId })
  await as(ANA).post(`/api/orders/${draft.body.id}/lines`).send({ sku: 'MAG-GLY-120', qty: 1, unitPriceCents: 2999 })
  const sent = await as(ANA).post(`/api/orders/${draft.body.id}/send`)
  if (pay) {
    const token = String(sent.body.payUrl).split('/').pop()
    const paid = await request(app).post(`/api/pay/${token}`).send({ idempotencyKey: `rr-${draft.body.id}` })
    expect(paid.status).toBe(200)
  }
  return draft.body.id
}
const myOrder = async (orderId: string) =>
  (await as(CARA).get('/api/patient/orders')).body.orders.find((o: { orderId: string }) => o.orderId === orderId)

beforeAll(async () => {
  execFileSync('npm', ['run', 'db:migrate'], { cwd: apiRoot, stdio: 'inherit', shell: process.platform === 'win32' })
  await seedCore(db)
  await db('products').where({ sku: 'MAG-GLY-120' }).update({ on_hand_qty: 50, reserved_qty: 0 })
  await makeWorld()
})
afterAll(async () => {
  await db.destroy()
})

describe('patient asks, provider decides', () => {
  it('request -> decline (note shown) -> request again -> approve runs the refund', async () => {
    const orderId = await orderForCara()
    expect((await myOrder(orderId)).canRequestRefund).toBe(true)

    const created = await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ unopened: true, reasonCode: 'damaged', note: 'Bottle arrived cracked' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ status: 'pending', reasonCode: 'damaged', note: 'Bottle arrived cracked' })
    expect(await myOrder(orderId)).toMatchObject({ canRequestRefund: false, refundRequest: { status: 'pending' } })

    const dup = await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ unopened: true, reasonCode: 'damaged' })
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('REFUND_REQUEST_EXISTS')

    const list = await as(ANA).get('/api/orders')
    expect(list.body.orders.find((o: { id: string }) => o.id === orderId).refundRequestStatus).toBe('pending')

    expect((await as(ANA).post(`/api/orders/${orderId}/refund-request/decline`).send({})).status).toBe(400)
    const declined = await as(ANA).post(`/api/orders/${orderId}/refund-request/decline`).send({ note: 'Please send a photo first' })
    expect(declined.status).toBe(200)
    expect(await myOrder(orderId)).toMatchObject({
      canRequestRefund: true,
      refundRequest: { status: 'declined', decisionNote: 'Please send a photo first' }
    })

    await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ unopened: true, reasonCode: 'damaged', note: 'Photo sent by email' })
    const approved = await as(ANA).post(`/api/orders/${orderId}/refund-request/approve`).send({})
    expect(approved.status).toBe(200)
    expect(approved.body.request.status).toBe('approved')
    expect(approved.body.refund).toMatchObject({ amountCents: 2999, reasonCode: 'damaged' })
    expect((await db('orders').where({ id: orderId }).first()).status).toBe('refunded')
    expect(await myOrder(orderId)).toMatchObject({ status: 'refunded', canRequestRefund: false, refundRequest: { status: 'approved' } })

    const again = await as(ANA).post(`/api/orders/${orderId}/refund-request/approve`).send({})
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('NO_PENDING_REQUEST')
  })
})

describe('guards', () => {
  it('only the patient own paid order; other patients and providers get 404', async () => {
    const orderId = await orderForCara()
    expect((await as(DEV).post(`/api/patient/orders/${orderId}/refund-request`).send({ unopened: true, reasonCode: 'other' })).status).toBe(404)
    expect((await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ reasonCode: 'provider_error' })).status).toBe(400)
    await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ unopened: true, reasonCode: 'other' })
    expect((await as(BEN).get(`/api/orders/${orderId}/refund-request`)).status).toBe(404)
    expect((await as(BEN).post(`/api/orders/${orderId}/refund-request/approve`).send({})).status).toBe(404)
    expect((await as(ANA).get(`/api/orders/${orderId}/refund-request`)).body.request).toMatchObject({ status: 'pending', reasonCode: 'other' })
  })

  it('an unpaid order cannot be requested (409 NOT_REFUNDABLE)', async () => {
    const orderId = await orderForCara(false)
    const res = await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ unopened: true, reasonCode: 'other' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('NOT_REFUNDABLE')
    expect((await myOrder(orderId)).canRequestRefund).toBe(false)
  })

  it('closes the request when Cerbo Admin already refunded the order', async () => {
    const orderId = await orderForCara()
    await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ unopened: true, reasonCode: 'wrong_item' })
    expect((await as(ADMIN).post(`/api/admin/orders/${orderId}/refund`).send({ reasonCode: 'wrong_item' })).status).toBe(200)
    const res = await as(ANA).post(`/api/orders/${orderId}/refund-request/approve`).send({})
    expect(res.status).toBe(200)
    expect(res.body.request).toMatchObject({ status: 'approved', decisionNote: 'This order had already been refunded.' })
    expect(res.body.refund).toBeNull()
  })

  it('the patient list never leaks economics or the review link', async () => {
    const blob = JSON.stringify((await as(CARA).get('/api/patient/orders')).body).toLowerCase()
    for (const leak of ['cogs', 'margin', 'fee', 'review']) expect(blob).not.toContain(leak)
  })
})

describe('ADR-027 eligibility: unopened, within 30 days of payment', () => {
  it('the patient must confirm the product is unopened (400)', async () => {
    const orderId = await orderForCara()
    for (const unopened of [undefined, false, 'yes']) {
      const res = await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ reasonCode: 'other', unopened })
      expect(res.status).toBe(400)
      expect(res.body.error.details.field).toBe('unopened')
    }
    const ok = await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ reasonCode: 'other', unopened: true })
    expect(ok.status).toBe(201)
    expect(ok.body.unopenedConfirmed).toBe(true)
    expect(ok.body.reviewPath).toBeUndefined()
  })

  it('the window closes 30 days after payment (409 REFUND_WINDOW_CLOSED)', async () => {
    const orderId = await orderForCara()
    const mine = await myOrder(orderId)
    const paidAt = new Date(mine.paidAt).getTime()
    expect(new Date(mine.refundWindowEndsAt).getTime() - paidAt).toBe(30 * 24 * 60 * 60 * 1000)

    await db('orders').where({ id: orderId }).update({ paid_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
    expect((await myOrder(orderId)).canRequestRefund).toBe(false)
    const res = await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ reasonCode: 'other', unopened: true })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('REFUND_WINDOW_CLOSED')
    expect(res.body.error.details.windowEndsAt).toBeTruthy()
  })
})

describe('provider review link (/api/refund-review/:token)', () => {
  async function requested(): Promise<{ orderId: string; token: string }> {
    const orderId = await orderForCara()
    await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ reasonCode: 'damaged', unopened: true, note: 'Seal intact' })
    const req = (await as(ANA).get(`/api/orders/${orderId}/refund-request`)).body.request
    expect(req.reviewPath).toMatch(/^\/refund-review\/[A-Za-z0-9_-]{32}$/)
    return { orderId, token: req.reviewPath.split('/').pop() }
  }

  it('shows the request and order, and Accept refunds immediately', async () => {
    const { orderId, token } = await requested()
    const view = await as(ANA).get(`/api/refund-review/${token}`)
    expect(view.status).toBe(200)
    expect(view.body.request).toMatchObject({ status: 'pending', unopenedConfirmed: true, note: 'Seal intact' })
    expect(view.body.order).toMatchObject({ id: orderId, status: 'paid', patientName: 'Pat RR A', subtotalCents: 2999, shipped: false })
    expect(view.body.order.items).toEqual([{ sku: 'MAG-GLY-120', name: expect.any(String), qty: 1, lineTotalCents: 2999 }])

    const accepted = await as(ANA).post(`/api/refund-review/${token}/accept`).send({})
    expect(accepted.status).toBe(200)
    expect(accepted.body.request.status).toBe('approved')
    expect(accepted.body.refund).toMatchObject({ amountCents: 2999 })
    expect((await db('orders').where({ id: orderId }).first()).status).toBe('refunded')
    expect((await as(ANA).post(`/api/refund-review/${token}/accept`).send({})).body.error.code).toBe('NO_PENDING_REQUEST')
  })

  it('Decline needs a note the patient then sees', async () => {
    const { orderId, token } = await requested()
    expect((await as(ANA).post(`/api/refund-review/${token}/decline`).send({ note: '' })).status).toBe(400)
    const declined = await as(ANA).post(`/api/refund-review/${token}/decline`).send({ note: 'Seal was broken on arrival photo' })
    expect(declined.status).toBe(200)
    expect(await myOrder(orderId)).toMatchObject({ refundRequest: { status: 'declined', decisionNote: 'Seal was broken on arrival photo' } })
  })

  it('only the owning provider: others get 404, patients 403, unknown tokens 404', async () => {
    const { orderId, token } = await requested()
    expect((await as(BEN).get(`/api/refund-review/${token}`)).status).toBe(404)
    expect((await as(BEN).post(`/api/refund-review/${token}/accept`).send({})).status).toBe(404)
    expect((await as(CARA).get(`/api/refund-review/${token}`)).status).toBe(403)
    expect((await as(ANA).get('/api/refund-review/not-a-real-token')).status).toBe(404)
    expect((await db('orders').where({ id: orderId }).first()).status).toBe('paid')
  })
})
