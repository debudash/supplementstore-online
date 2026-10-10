// EVAL-05, 05b, 05c, EVAL-14: inventory availability, cross-order reservation, and
// reservation expiry - end to end against real Postgres (stock lives in the DB with a
// reserved_qty <= on_hand_qty check constraint).
import { afterAll, beforeEach, describe, expect } from 'vitest'
import {
  asUser,
  db,
  evalCase,
  newDraft,
  payHttp,
  resetState,
  sendOrderHttp,
  PROV_ANA,
  PROV_BEN,
  PAT_DEV,
  SKU
} from './_harness'
import { randomUUID } from 'node:crypto'
import { runExpireReservations } from '../../../apps/api/src/jobs/expire'
import { RESERVATION_DAYS } from '../../../apps/api/src/orders/service'
import { markupFor } from './_harness'

beforeEach(async () => {
  await resetState()
})
afterAll(async () => {
  await db.destroy()
})

describe('inventory (golden)', () => {
  evalCase('EVAL-05', 'PROBIO x6 -> 409 available 5; x5 succeeds', async () => {
    const id = await newDraft()
    const over = await asUser(PROV_ANA).post(`/api/orders/${id}/lines`).send({ sku: SKU.PROBIO, qty: 6, markupCents: markupFor(SKU.PROBIO, 4000) })
    expect(over.status).toBe(409)
    expect(over.body.error.code).toBe('INSUFFICIENT_STOCK')
    expect(over.body.error.details.available).toBe(5)

    const ok = await asUser(PROV_ANA).post(`/api/orders/${id}/lines`).send({ sku: SKU.PROBIO, qty: 5, markupCents: markupFor(SKU.PROBIO, 4000) })
    expect(ok.status).toBe(200)
  })

  evalCase('EVAL-05b', 'ZINC x1 -> 409 available 0', async () => {
    const id = await newDraft()
    const res = await asUser(PROV_ANA).post(`/api/orders/${id}/lines`).send({ sku: SKU.ZINC, qty: 1, markupCents: markupFor(SKU.ZINC, 1500) })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK')
    expect(res.body.error.details.available).toBe(0)
  })

  evalCase('EVAL-05c', 'cross-order reservation: ben blocked at 0, freed after ana cancels', async () => {
    // prov-ana reserves all 5 PROBIO by sending.
    const ana = await newDraft()
    expect((await asUser(PROV_ANA).post(`/api/orders/${ana}/lines`).send({ sku: SKU.PROBIO, qty: 5, markupCents: markupFor(SKU.PROBIO, 4000) })).status).toBe(200)
    expect((await asUser(PROV_ANA).post(`/api/orders/${ana}/send`).send({})).status).toBe(200)

    // prov-ben now sees availability 0 (reserved by ana) and is blocked.
    const ben = await newDraft(PAT_DEV, PROV_BEN)
    const benAdd = await asUser(PROV_BEN).post(`/api/orders/${ben}/lines`).send({ sku: SKU.PROBIO, qty: 1, markupCents: markupFor(SKU.PROBIO, 4000) })
    expect(benAdd.status).toBe(409)
    expect(benAdd.body.error.details.available).toBe(0)

    // After ana cancels, the reservation is released and availability returns to 5.
    expect((await asUser(PROV_ANA).post(`/api/orders/${ana}/cancel`).send({})).status).toBe(200)
    const products = await asUser(PROV_BEN).get('/api/products')
    const probio = products.body.products.find((p: { sku: string }) => p.sku === SKU.PROBIO)
    expect(probio.available).toBe(5)
    const benAdd2 = await asUser(PROV_BEN).post(`/api/orders/${ben}/lines`).send({ sku: SKU.PROBIO, qty: 1, markupCents: markupFor(SKU.PROBIO, 4000) })
    expect(benAdd2.status).toBe(200)
  })

  evalCase('EVAL-14', 'reservation expiry: expired, released, pay -> ORDER_EXPIRED', async () => {
    const { orderId, token } = await sendOrderHttp([{ sku: SKU.MAG, qty: 2, price: 2999 }])
    expect((await db('products').where({ sku: SKU.MAG }).first()).reserved_qty).toBe(2)

    // Advance the Clock 7 days + 1 minute and run the expiry sweep. We call the job
    // function directly (the admin route /api/admin/jobs/expire-reservations wraps the same
    // function) because only the in-process call accepts an injected Clock.
    const future = new Date(Date.now() + RESERVATION_DAYS * 24 * 60 * 60 * 1000 + 60 * 1000)
    const result = await runExpireReservations(db, { now: () => future })
    expect(result.expired).toContain(orderId)

    const order = await db('orders').where({ id: orderId }).first()
    expect(order.status).toBe('expired')
    expect(order.expired_at).toBeTruthy()
    // Reservation released.
    expect((await db('products').where({ sku: SKU.MAG }).first()).reserved_qty).toBe(0)

    // Paying an expired order is refused, with no oversell.
    const pay = await payHttp(token, randomUUID())
    expect(pay.status).toBe(409)
    expect(pay.body.error.code).toBe('ORDER_EXPIRED')
    const mag = await db('products').where({ sku: SKU.MAG }).first()
    expect(mag.on_hand_qty).toBe(50)
    expect(await db('payments').where({ order_id: orderId }).then((r) => r.length)).toBe(0)
  })
})
