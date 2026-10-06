// EVAL-06, 06b, 06c, 06d: the patient pay flow and the money record - end to end through
// the patient token route, posting a per-line double-entry PAYMENT journal into real
// Postgres. Expected cents verbatim from docs/EVALS.md.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect } from 'vitest'
import {
  asUser,
  db,
  evalCase,
  payHttp,
  resetState,
  sendOrderHttp,
  EVAL01_LINES,
  PROV_ANA,
  PROVIDER_ANA_ID,
  SKU
} from './_harness'

beforeEach(async () => {
  await resetState()
})
afterAll(async () => {
  await db.destroy()
})

describe('payment + ledger (golden)', () => {
  evalCase('EVAL-06', 'idempotent pay: same key twice, new key -> ALREADY_PAID', async () => {
    const { orderId, token } = await sendOrderHttp(EVAL01_LINES)
    const key = randomUUID()

    const first = await payHttp(token, key)
    expect(first.status).toBe(200)
    const second = await payHttp(token, key)
    expect(second.status).toBe(200)
    expect(second.body.paymentId).toBe(first.body.paymentId)

    const third = await payHttp(token, randomUUID())
    expect(third.status).toBe(409)
    expect(third.body.error.code).toBe('ALREADY_PAID')

    expect(await db('payments').where({ order_id: orderId }).then((r) => r.length)).toBe(1)
    expect(await db('journals').where({ order_id: orderId, type: 'PAYMENT' }).then((r) => r.length)).toBe(1)
  })

  evalCase('EVAL-06b', 'PAYMENT journal + stock: per-line entries, CASH/COGS/PAYABLE/FEE', async () => {
    const { orderId, token } = await sendOrderHttp(EVAL01_LINES)
    const res = await payHttp(token, randomUUID())
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'paid', totalCents: 8497 })

    // One payment at the subtotal.
    const payments = await db('payments').where({ order_id: orderId })
    expect(payments).toHaveLength(1)
    expect(payments[0].amount_cents).toBe(8497)

    // Stock: reserved released and sold - MAG 48, VITD3 39, reserved 0.
    const mag = await db('products').where({ sku: SKU.MAG }).first()
    const vitd = await db('products').where({ sku: SKU.VITD }).first()
    expect(mag.on_hand_qty).toBe(48)
    expect(mag.reserved_qty).toBe(0)
    expect(vitd.on_hand_qty).toBe(39)
    expect(vitd.reserved_qty).toBe(0)

    // One PAYMENT journal, per-line entries (2 lines x 4 accounts), balanced to zero.
    const journals = await db('journals').where({ order_id: orderId, type: 'PAYMENT' })
    expect(journals).toHaveLength(1)
    const entries = await db('ledger_entries').where({ journal_id: journals[0].id })
    expect(entries).toHaveLength(8)
    for (const e of entries) {
      expect(e.line_id).toBeTruthy()
      expect(e.provider_id).toBe(PROVIDER_ANA_ID)
    }
    const sumBy = (account: string) =>
      entries.filter((e) => e.account === account).reduce((a, e) => a + e.amount_cents, 0)
    expect(sumBy('CASH_CLEARING')).toBe(8497)
    expect(sumBy('COGS_RECOVERY')).toBe(-4025)
    expect(sumBy('PROVIDER_PAYABLE')).toBe(-4408)
    expect(sumBy('PLATFORM_FEE_REVENUE')).toBe(-64)
    expect(entries.reduce((a, e) => a + e.amount_cents, 0)).toBe(0)
  })

  evalCase('EVAL-06c', 'audit: all invariants pass; history draft -> sent -> paid', async () => {
    const { orderId, token } = await sendOrderHttp(EVAL01_LINES)
    expect((await payHttp(token, randomUUID())).status).toBe(200)

    const res = await asUser(PROV_ANA).get(`/api/orders/${orderId}/audit`)
    expect(res.status).toBe(200)
    expect(res.body.invariants.ok).toBe(true)
    for (const check of res.body.invariants.checks) expect(check.pass).toBe(true)
    expect(res.body.statusHistory.map((e: { toStatus: string }) => e.toStatus)).toEqual(['draft', 'sent', 'paid'])
    expect(res.body.order).toMatchObject({ subtotalCents: 8497, cogsCents: 4025, feeCents: 64, marginCents: 4408 })
  })

  evalCase('EVAL-06d', 'decline at 1313 -> 402; order stays sent; no payment/journal', async () => {
    // A single VITD3 line totalling 1313 triggers the stub gateway decline.
    const { orderId, token } = await sendOrderHttp([{ sku: SKU.VITD, qty: 1, price: 1313 }])
    const res = await payHttp(token, randomUUID())
    expect(res.status).toBe(402)
    expect(res.body.error.code).toBe('PAYMENT_DECLINED')

    const order = await db('orders').where({ id: orderId }).first()
    expect(order.status).toBe('sent')
    expect(await db('payments').where({ order_id: orderId }).then((r) => r.length)).toBe(0)
    expect(await db('journals').where({ order_id: orderId }).then((r) => r.length)).toBe(0)
    // Stock untouched: still reserved, nothing sold.
    const vitd = await db('products').where({ sku: SKU.VITD }).first()
    expect(vitd.on_hand_qty).toBe(40)
    expect(vitd.reserved_qty).toBe(1)
  })
})
