// Patient refund requests (ADR-023 compatible: no return). The patient asks; the provider
// approves (the standard refund path runs) or declines with a note. Guards: own paid
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

    const created = await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ reasonCode: 'damaged', note: 'Bottle arrived cracked' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ status: 'pending', reasonCode: 'damaged', note: 'Bottle arrived cracked' })
    expect(await myOrder(orderId)).toMatchObject({ canRequestRefund: false, refundRequest: { status: 'pending' } })

    const dup = await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ reasonCode: 'damaged' })
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

    await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ reasonCode: 'damaged', note: 'Photo sent by email' })
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
    expect((await as(DEV).post(`/api/patient/orders/${orderId}/refund-request`).send({ reasonCode: 'other' })).status).toBe(404)
    expect((await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ reasonCode: 'provider_error' })).status).toBe(400)
    await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ reasonCode: 'other' })
    expect((await as(BEN).get(`/api/orders/${orderId}/refund-request`)).status).toBe(404)
    expect((await as(BEN).post(`/api/orders/${orderId}/refund-request/approve`).send({})).status).toBe(404)
    expect((await as(ANA).get(`/api/orders/${orderId}/refund-request`)).body.request).toMatchObject({ status: 'pending', reasonCode: 'other' })
  })

  it('an unpaid order cannot be requested (409 NOT_REFUNDABLE)', async () => {
    const orderId = await orderForCara(false)
    const res = await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ reasonCode: 'other' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('NOT_REFUNDABLE')
    expect((await myOrder(orderId)).canRequestRefund).toBe(false)
  })

  it('closes the request when Cerbo Admin already refunded the order', async () => {
    const orderId = await orderForCara()
    await as(CARA).post(`/api/patient/orders/${orderId}/refund-request`).send({ reasonCode: 'wrong_item' })
    expect((await as(ADMIN).post(`/api/admin/orders/${orderId}/refund`).send({ reasonCode: 'wrong_item' })).status).toBe(200)
    const res = await as(ANA).post(`/api/orders/${orderId}/refund-request/approve`).send({})
    expect(res.status).toBe(200)
    expect(res.body.request).toMatchObject({ status: 'approved', decisionNote: 'This order had already been refunded.' })
    expect(res.body.refund).toBeNull()
  })

  it('the patient list never leaks economics', async () => {
    const blob = JSON.stringify((await as(CARA).get('/api/patient/orders')).body).toLowerCase()
    for (const leak of ['cogs', 'margin', 'fee']) expect(blob).not.toContain(leak)
  })
})
