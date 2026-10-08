// EVAL-07, 07b, 08, 08b: refunds and the REFUND journal (ADR-007, 012, 013, 014, 023),
// driven end to end over the WIRED HTTP routes (T5 merged):
//   provider refund  POST /api/orders/:id/refund
//   admin refund     POST /api/admin/orders/:id/refund
//   admin fulfill    POST /api/admin/orders/:id/fulfill
// Expected cents are verbatim from docs/EVALS.md. Nothing here fabricates refund data or
// hand-writes journals - every number comes from the real posting path.
//
// ADR-023 note: the patient refund notice goes through the Notifier SEAM, which no HTTP
// route surfaces (the routes use their own default container). Its "exactly one notice /
// no economics / keep-or-dispose" guarantee is covered at the service layer by T5
// (apps/api/test/refunds/refunds.test.ts, StubNotifier). What IS HTTP-observable - and
// what drives the patient's keep-or-dispose instruction (keepOrDispose = !restocked) - is
// the `restocked` flag in the refund response; both branches are asserted below.
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
  ADMIN,
  PROV_ANA,
  PROVIDER_ANA_ID,
  SKU,
  type Line
} from './_harness'

beforeEach(async () => {
  await resetState()
})
afterAll(async () => {
  await db.destroy()
})

interface EntrySnapshot {
  id: number
  account: string
  amount_cents: number
  memo: string | null
  line_id: string | null
}

/** Stable snapshot of a journal's entries for the "PAYMENT journal unchanged" check. */
async function journalEntries(journalId: string): Promise<EntrySnapshot[]> {
  const rows = await db('ledger_entries').where({ journal_id: journalId }).orderBy('id')
  return rows.map((e) => ({
    id: Number(e.id),
    account: e.account,
    amount_cents: e.amount_cents,
    memo: e.memo ?? null,
    line_id: e.line_id ?? null
  }))
}

const sumBy = (entries: { account: string; amount_cents: number }[], account: string) =>
  entries.filter((e) => e.account === account).reduce((a, e) => a + e.amount_cents, 0)

/** Refund an order. Provider route by default (prov-ana owns these orders). */
async function refund(orderId: string, reasonCode: string, as: string = PROV_ANA) {
  return asUser(as).post(`/api/orders/${orderId}/refund`).send({ reasonCode })
}
async function adminRefund(orderId: string, reasonCode: string) {
  return asUser(ADMIN).post(`/api/admin/orders/${orderId}/refund`).send({ reasonCode })
}
async function fulfill(orderId: string) {
  return asUser(ADMIN).post(`/api/admin/orders/${orderId}/fulfill`).send({})
}
async function payNewOrder(lines: Line[]): Promise<string> {
  const { orderId, token } = await sendOrderHttp(lines)
  expect((await payHttp(token, randomUUID())).status).toBe(200)
  return orderId
}

describe('refunds (golden)', () => {
  evalCase('EVAL-07', 'refund paid EVAL-01: amounts, REFUND journal, restock, PAYMENT untouched', async () => {
    const orderId = await payNewOrder(EVAL01_LINES)

    // Capture the PAYMENT journal + entries BEFORE the refund (ADR-007 baseline).
    const payJournalBefore = await db('journals').where({ order_id: orderId, type: 'PAYMENT' }).first()
    expect(payJournalBefore).toBeTruthy()
    const payEntriesBefore = await journalEntries(payJournalBefore.id)
    expect(payEntriesBefore).toHaveLength(8)

    const res = await refund(orderId, 'patient_request')
    expect(res.status).toBe(200)
    // ADR-012: 100% back to patient, fee retained, provider debited; restocked (ADR-013).
    // restocked=true -> the patient notice says keepOrDispose=false (nothing shipped, ADR-023).
    expect(res.body).toMatchObject({
      orderId,
      status: 'refunded',
      reasonCode: 'patient_request',
      amountCents: 8497,
      feeRetainedCents: 64,
      restocked: true,
      writeoffCogsCents: 0
    })

    // Exactly one REFUND journal, 8 per-line entries, each attributed to prov-ana.
    const refundJournals = await db('journals').where({ order_id: orderId, type: 'REFUND' })
    expect(refundJournals).toHaveLength(1)
    const entries = await db('ledger_entries').where({ journal_id: refundJournals[0].id })
    expect(entries).toHaveLength(8)
    for (const e of entries) {
      expect(e.line_id).toBeTruthy()
      expect(e.provider_id).toBe(PROVIDER_ANA_ID)
    }
    // EVAL-07 exact cents: CASH -8497, COGS +4025, PAYABLE +4472, FEE untouched; sum 0.
    expect(sumBy(entries, 'CASH_CLEARING')).toBe(-8497)
    expect(sumBy(entries, 'COGS_RECOVERY')).toBe(4025)
    expect(sumBy(entries, 'PROVIDER_PAYABLE')).toBe(4472)
    expect(entries.filter((e) => e.account === 'PLATFORM_FEE_REVENUE')).toHaveLength(0)
    expect(entries.reduce((a, e) => a + e.amount_cents, 0)).toBe(0)
    // The PAYABLE debit splits into margin reversal + fee retention (ADR-012).
    const payable = entries.filter((e) => e.account === 'PROVIDER_PAYABLE')
    expect(sumBy(payable.filter((e) => e.memo === 'margin_reversal'), 'PROVIDER_PAYABLE')).toBe(4408)
    expect(sumBy(payable.filter((e) => e.memo === 'fee_retention'), 'PROVIDER_PAYABLE')).toBe(64)

    // *** ADR-007, the crown-jewel assertion: the REFUND is a NEW journal and the original
    // PAYMENT journal + every one of its entries is byte-for-byte UNCHANGED. ***
    const payJournalAfter = await db('journals').where({ order_id: orderId, type: 'PAYMENT' }).first()
    expect(payJournalAfter.id).toBe(payJournalBefore.id)
    expect(new Date(payJournalAfter.posted_at).getTime()).toBe(new Date(payJournalBefore.posted_at).getTime())
    expect(await journalEntries(payJournalAfter.id)).toEqual(payEntriesBefore)
    expect(await db('journals').where({ order_id: orderId, type: 'PAYMENT' }).then((r) => r.length)).toBe(1)

    // Restock to canonical (not fulfilled): MAG 50, VITD3 40; one movement per line.
    expect((await db('products').where({ sku: SKU.MAG }).first()).on_hand_qty).toBe(50)
    expect((await db('products').where({ sku: SKU.VITD }).first()).on_hand_qty).toBe(40)
    expect(await db('inventory_movements').where({ order_id: orderId, reason: 'refund_restock' }).then((r) => r.length)).toBe(2)

    // Refund row + status.
    const refundRow = await db('refunds').where({ order_id: orderId }).first()
    expect(refundRow).toMatchObject({ reason_code: 'patient_request', amount_cents: 8497, fee_retained_cents: 64, restocked: true, writeoff_cogs_cents: 0 })
    expect((await db('orders').where({ id: orderId }).first()).status).toBe('refunded')
  })

  evalCase('EVAL-07b', 'refund again -> 409 ALREADY_REFUNDED (ADR-014 whole-order only)', async () => {
    const orderId = await payNewOrder(EVAL01_LINES)
    expect((await refund(orderId, 'patient_request')).status).toBe(200)

    const second = await refund(orderId, 'patient_request')
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('ALREADY_REFUNDED')
    // Exactly one refund and one REFUND journal survived.
    expect(await db('refunds').where({ order_id: orderId }).then((r) => r.length)).toBe(1)
    expect(await db('journals').where({ order_id: orderId, type: 'REFUND' }).then((r) => r.length)).toBe(1)
  })

  evalCase('EVAL-08', 'pay EVAL-02, fulfill, refund damaged: no restock, writeoff_cogs 2280', async () => {
    const orderId = await payNewOrder([{ sku: SKU.OMEGA, qty: 1, price: 4999 }])
    expect((await db('products').where({ sku: SKU.OMEGA }).first()).on_hand_qty).toBe(29) // sold 1

    const ff = await fulfill(orderId)
    expect(ff.status).toBe(200)
    expect(ff.body).toMatchObject({ orderId, status: 'paid' })
    expect(ff.body.fulfilledAt).toBeTruthy()

    const res = await adminRefund(orderId, 'damaged')
    expect(res.status).toBe(200)
    // restocked=false -> patient notice keepOrDispose=true (written off, do not return).
    expect(res.body).toMatchObject({ amountCents: 4999, feeRetainedCents: 38, restocked: false, writeoffCogsCents: 2280 })

    // ADR-013 write-off branch: NO restock, no refund_restock movement; OMEGA stays 29.
    expect((await db('products').where({ sku: SKU.OMEGA }).first()).on_hand_qty).toBe(29)
    expect(await db('inventory_movements').where({ order_id: orderId, reason: 'refund_restock' }).then((r) => r.length)).toBe(0)

    const refundRow = await db('refunds').where({ order_id: orderId }).first()
    expect(refundRow).toMatchObject({ restocked: false, writeoff_cogs_cents: 2280, reason_code: 'damaged' })

    // Balanced REFUND journal: CASH -4999, COGS +2280, PAYABLE +2719 (margin 2682 + fee 37).
    const refundJournal = await db('journals').where({ order_id: orderId, type: 'REFUND' }).first()
    const entries = await db('ledger_entries').where({ journal_id: refundJournal.id })
    expect(entries.reduce((a, e) => a + e.amount_cents, 0)).toBe(0)
    expect(sumBy(entries, 'CASH_CLEARING')).toBe(-4999)
    expect(sumBy(entries, 'COGS_RECOVERY')).toBe(2280)
    expect(sumBy(entries, 'PROVIDER_PAYABLE')).toBe(2719)
    expect((await db('orders').where({ id: orderId }).first()).status).toBe('refunded')
  })

  evalCase('EVAL-08b', 'refund a sent (unpaid) order -> 409 NOT_REFUNDABLE', async () => {
    const { orderId } = await sendOrderHttp([{ sku: SKU.MAG, qty: 1, price: 2999 }])
    const res = await refund(orderId, 'patient_request')
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('NOT_REFUNDABLE')
    expect(await db('refunds').where({ order_id: orderId }).then((r) => r.length)).toBe(0)
  })
})
