// T5 API tests: refunds and fulfillment (FR-8, FR-9). GATE G4 reviews EVAL-07 and the
// REFUND posting - the expectations below are the exact cents a human signs off on.
//
// Runs against real Postgres (DATABASE_URL), migrations applied via the tsx CLI in
// beforeAll (the T2/T3/T4-proven pattern - knex raw-requires .ts migrations outside
// vite's transform, so db.migrate.latest() throws under vitest).
//
// Drives the WIRED routes end to end: pay via /api/pay/:token (T4), refund via the
// provider route POST /api/orders/:id/refund and the admin route
// POST /api/admin/orders/:id/refund, fulfill via POST /api/admin/orders/:id/fulfill.
//
// ISOLATION: a DEDICATED practice/provider/patient and the SEED SKUs (stock reset in
// beforeEach), never the prov-ana/prov-ben orders that orders.test.ts deletes. Paid and
// refunded orders cannot be torn down (append-only tables), so every test creates a
// FRESH order and asserts stock deltas relative to the canonical reset.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { db } from '../../src/db/knex'
import { createApp } from '../../src/app'
import { createKnexActorLoader } from '../../src/auth/loadActor'
import { seedCore } from '../../src/db/seeds/01_core'
import { createSeams, StubNotifier } from '../../src/seams'
import type { Notifier } from '../../src/seams'
import type { Actor } from '../../src/auth/types'
import { refundOrder } from '../../src/refunds'
import { fulfillOrder } from '../../src/fulfillment'
import { markupFor } from '../pricing'

const apiRoot = path.resolve(__dirname, '../..')
function migrateViaCli(): void {
  execFileSync('npm', ['run', 'db:migrate'], {
    cwd: apiRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
}

const app = createApp({ db, loadActor: createKnexActorLoader(db) })
const asUser = (userId: string) => ({
  post: (url: string) => request(app).post(url).set('X-Demo-User', userId),
  get: (url: string) => request(app).get(url).set('X-Demo-User', userId)
})
const anon = { post: (url: string) => request(app).post(url) }

// Dedicated practice/provider/patient/user (NOT the seed prov-ana/prov-ben). A SECOND
// provider in another practice exercises the ownership check (RT-01).
const PRACTICE = '55555555-5555-5555-5555-555555555555'
const PROVIDER = 'aaaaaaaa-0000-0000-0000-0000000000f5'
const PATIENT = 'cccccccc-0000-0000-0000-0000000000f5'
const PROV_USER = 't5-prov'
const PRACTICE2 = '66666666-6666-6666-6666-666666666666'
const PROVIDER2 = 'aaaaaaaa-0000-0000-0000-0000000000e5'
const PROV_USER2 = 't5-prov-other'

const SKU_MAG = 'MAG-GLY-120'
const SKU_VITD = 'VITD3-K2'
const SKU_OMEGA = 'OMEGA3-1000'

// Canonical seed stock for the SKUs this suite uses (docs/EVALS.md seed table).
const CANONICAL_STOCK: Record<string, number> = {
  [SKU_MAG]: 50,
  [SKU_VITD]: 40,
  [SKU_OMEGA]: 30
}

async function setupFixtures(): Promise<void> {
  await seedCore(db) // ensure the seed SKUs + admin-cerbo exist (idempotent)
  await db('practices').insert({ id: PRACTICE, name: 'T5 Practice' }).onConflict('id').merge()
  await db('practices').insert({ id: PRACTICE2, name: 'T5 Practice 2' }).onConflict('id').merge()
  await db('providers')
    .insert({ id: PROVIDER, practice_id: PRACTICE, name: 'Dr. T5', email: 't5@example.com' })
    .onConflict('id')
    .merge()
  await db('providers')
    .insert({ id: PROVIDER2, practice_id: PRACTICE2, name: 'Dr. T5 Other', email: 't5other@example.com' })
    .onConflict('id')
    .merge()
  await db('patients')
    .insert({ id: PATIENT, practice_id: PRACTICE, name: 'Pat T5', email: 'pat.t5@example.com', ship_to: '1 T5 St' })
    .onConflict('id')
    .merge()
  await db('users')
    .insert({ id: PROV_USER, role: 'provider', provider_id: PROVIDER, patient_id: null, display_name: 'Dr. T5' })
    .onConflict('id')
    .merge()
  await db('users')
    .insert({ id: PROV_USER2, role: 'provider', provider_id: PROVIDER2, patient_id: null, display_name: 'Dr. T5 Other' })
    .onConflict('id')
    .merge()
}

async function resetStock(): Promise<void> {
  for (const [sku, onHand] of Object.entries(CANONICAL_STOCK)) {
    await db('products').where({ sku }).update({ on_hand_qty: onHand, reserved_qty: 0 })
  }
}

beforeAll(async () => {
  migrateViaCli()
  await setupFixtures()
})
beforeEach(async () => {
  await resetStock()
})
afterAll(async () => {
  await db.destroy()
})

interface Line {
  sku: string
  qty: number
  price: number
}

/** Create a draft for the T5 patient, add lines, send it; return order id + pay token. */
async function sendNewOrder(lines: Line[]): Promise<{ orderId: string; token: string }> {
  const draft = await asUser(PROV_USER).post('/api/orders').send({ patientId: PATIENT })
  expect(draft.status).toBe(201)
  const orderId = draft.body.id as string
  for (const l of lines) {
    const r = await asUser(PROV_USER)
      .post(`/api/orders/${orderId}/lines`)
      .send({ sku: l.sku, qty: l.qty, markupCents: markupFor(l.sku, l.price) })
    expect(r.status).toBe(200)
  }
  const send = await asUser(PROV_USER).post(`/api/orders/${orderId}/send`).send({})
  expect(send.status).toBe(200)
  // Keep the global reservation-expiry sweep (other suites run it with a +7-day clock)
  // away from these orders.
  await db('orders')
    .where({ id: orderId })
    .update({ reservation_expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) })
  return { orderId, token: send.body.order.payToken as string }
}

/** Pay an order through the T4 patient route. */
async function payOrder(token: string): Promise<void> {
  const res = await anon.post(`/api/pay/${token}`).send({ idempotencyKey: randomUUID() })
  expect(res.status).toBe(200)
}

/** Create + send + pay a fresh order; return its id and token. */
async function paidOrder(lines: Line[]): Promise<{ orderId: string; token: string }> {
  const o = await sendNewOrder(lines)
  await payOrder(o.token)
  return o
}

const EVAL01: Line[] = [
  { sku: SKU_MAG, qty: 2, price: 2999 },
  { sku: SKU_VITD, qty: 1, price: 2500 } // markup 1356: with MAG x2 the order rounds once to 8497 (EVAL-01)
]
const EVAL02: Line[] = [{ sku: SKU_OMEGA, qty: 1, price: 4999 }]

const sumBy = (entries: { account: string; amount_cents: number }[], account: string) =>
  entries.filter((e) => e.account === account).reduce((a, e) => a + e.amount_cents, 0)

describe('FR-8 / EVAL-07 refund of a paid, not-yet-fulfilled order (GATE G4)', () => {
  it('posts a balanced REFUND journal, retains the fee, restocks, and leaves the PAYMENT journal untouched', async () => {
    const { orderId } = await paidOrder(EVAL01)

    const res = await asUser(PROV_USER)
      .post(`/api/orders/${orderId}/refund`)
      .send({ reasonCode: 'patient_request' })
    expect(res.status).toBe(200)

    // Result (provider-facing): 100% back to the patient, fee retained, restocked.
    expect(res.body).toMatchObject({
      orderId,
      status: 'refunded',
      reasonCode: 'patient_request',
      amountCents: 8497,
      feeRetainedCents: 64,
      restocked: true,
      writeoffCogsCents: 0
    })

    // Exactly one REFUND journal; one PAYMENT journal still present and untouched.
    const payJournals = await db('journals').where({ order_id: orderId, type: 'PAYMENT' })
    const refundJournals = await db('journals').where({ order_id: orderId, type: 'REFUND' })
    expect(payJournals).toHaveLength(1)
    expect(refundJournals).toHaveLength(1)

    // REFUND entries: 2 lines x 4 = 8, each tied to a SKU with provider/practice attribution.
    const entries = await db('ledger_entries').where({ journal_id: refundJournals[0].id })
    expect(entries).toHaveLength(8)
    for (const e of entries) {
      expect(e.line_id).toBeTruthy()
      expect(e.provider_id).toBe(PROVIDER)
      expect(e.practice_id).toBe(PRACTICE)
    }

    // EVAL-07 exact cents: CASH -8497, COGS +4025, PAYABLE +4408 (margin_reversal)
    // +64 (fee_retention); PLATFORM_FEE_REVENUE untouched; journal sums to zero.
    expect(sumBy(entries, 'CASH_CLEARING')).toBe(-8497)
    expect(sumBy(entries, 'COGS_RECOVERY')).toBe(4025)
    expect(sumBy(entries, 'PROVIDER_PAYABLE')).toBe(4472)
    expect(sumBy(entries, 'PLATFORM_FEE_REVENUE')).toBe(0)
    expect(entries.filter((e) => e.account === 'PLATFORM_FEE_REVENUE')).toHaveLength(0)
    expect(entries.reduce((a, e) => a + e.amount_cents, 0)).toBe(0)

    // The PAYABLE debit splits into a margin reversal and a fee retention (ADR-012).
    const payable = entries.filter((e) => e.account === 'PROVIDER_PAYABLE')
    expect(sumBy(payable.filter((e) => e.memo === 'margin_reversal'), 'PROVIDER_PAYABLE')).toBe(4408)
    expect(sumBy(payable.filter((e) => e.memo === 'fee_retention'), 'PROVIDER_PAYABLE')).toBe(64)

    // Restock: MAG back to 50, VITD back to 40 (reserved 0), with refund_restock movements.
    const mag = await db('products').where({ sku: SKU_MAG }).first()
    const vitd = await db('products').where({ sku: SKU_VITD }).first()
    expect(mag.on_hand_qty).toBe(50)
    expect(mag.reserved_qty).toBe(0)
    expect(vitd.on_hand_qty).toBe(40)
    expect(vitd.reserved_qty).toBe(0)
    const restockMoves = await db('inventory_movements').where({ order_id: orderId, reason: 'refund_restock' })
    expect(restockMoves).toHaveLength(2)

    // Refund row + order status.
    const refund = await db('refunds').where({ order_id: orderId }).first()
    expect(refund).toMatchObject({
      reason_code: 'patient_request',
      amount_cents: 8497,
      fee_retained_cents: 64,
      restocked: true,
      writeoff_cogs_cents: 0
    })
    expect(refund.actor_user_id).toBe(PROV_USER)
    const order = await db('orders').where({ id: orderId }).first()
    expect(order.status).toBe('refunded')
    expect(order.refunded_at).toBeTruthy()
  })
})

describe('FR-8 AC5 / EVAL-07b double refund', () => {
  it('a second refund returns 409 ALREADY_REFUNDED; exactly one refund + one REFUND journal', async () => {
    const { orderId } = await paidOrder(EVAL01)
    const first = await asUser(PROV_USER).post(`/api/orders/${orderId}/refund`).send({ reasonCode: 'other' })
    expect(first.status).toBe(200)

    const second = await asUser(PROV_USER).post(`/api/orders/${orderId}/refund`).send({ reasonCode: 'other' })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('ALREADY_REFUNDED')

    expect(await db('refunds').where({ order_id: orderId }).then((r) => r.length)).toBe(1)
    expect(await db('journals').where({ order_id: orderId, type: 'REFUND' }).then((r) => r.length)).toBe(1)
  })
})

describe('FR-8 AC4 / EVAL-08 refund of a FULFILLED order writes off COGS, no restock', () => {
  it('fulfilled OMEGA refund leaves stock at 29 and records writeoff_cogs 2280', async () => {
    const { orderId } = await paidOrder(EVAL02)
    // Pay sold 1 unit: OMEGA on_hand 29.
    const afterPay = await db('products').where({ sku: SKU_OMEGA }).first()
    expect(afterPay.on_hand_qty).toBe(29)

    // Fulfill via the admin route (FR-9).
    const fulfill = await asUser('admin-cerbo').post(`/api/admin/orders/${orderId}/fulfill`).send({})
    expect(fulfill.status).toBe(200)
    expect(fulfill.body).toMatchObject({ orderId, status: 'paid' })
    expect(fulfill.body.fulfilledAt).toBeTruthy()

    const res = await asUser('admin-cerbo').post(`/api/admin/orders/${orderId}/refund`).send({ reasonCode: 'damaged' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      amountCents: 4999,
      feeRetainedCents: 38,
      restocked: false,
      writeoffCogsCents: 2280
    })

    // No restock: OMEGA stays at 29, no refund_restock movement.
    const omega = await db('products').where({ sku: SKU_OMEGA }).first()
    expect(omega.on_hand_qty).toBe(29)
    expect(await db('inventory_movements').where({ order_id: orderId, reason: 'refund_restock' }).then((r) => r.length)).toBe(0)

    const refund = await db('refunds').where({ order_id: orderId }).first()
    expect(refund).toMatchObject({ restocked: false, writeoff_cogs_cents: 2280, fee_retained_cents: 38 })

    // REFUND journal still balances (money rule 7).
    const refundJournal = await db('journals').where({ order_id: orderId, type: 'REFUND' }).first()
    const entries = await db('ledger_entries').where({ journal_id: refundJournal.id })
    expect(entries.reduce((a, e) => a + e.amount_cents, 0)).toBe(0)
    expect(sumBy(entries, 'CASH_CLEARING')).toBe(-4999)
    expect(sumBy(entries, 'COGS_RECOVERY')).toBe(2280)
    expect(sumBy(entries, 'PROVIDER_PAYABLE')).toBe(2719) // margin 2681 + fee 38 (ADR-028)
  })
})

describe('FR-8 AC5 / EVAL-08b refund of a non-paid order', () => {
  it('a sent (unpaid) order returns 409 NOT_REFUNDABLE; no refund or journal', async () => {
    const { orderId } = await sendNewOrder(EVAL02)
    const res = await asUser(PROV_USER).post(`/api/orders/${orderId}/refund`).send({ reasonCode: 'other' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('NOT_REFUNDABLE')
    expect(await db('refunds').where({ order_id: orderId }).then((r) => r.length)).toBe(0)
    expect(await db('journals').where({ order_id: orderId, type: 'REFUND' }).then((r) => r.length)).toBe(0)
  })
})

describe('RT-08 concurrent double refund', () => {
  it('10 parallel refunds produce exactly one refund and one REFUND journal', async () => {
    const { orderId } = await paidOrder(EVAL01)
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        asUser(PROV_USER).post(`/api/orders/${orderId}/refund`).send({ reasonCode: 'patient_request' })
      )
    )
    const ok = results.filter((r) => r.status === 200)
    const conflict = results.filter((r) => r.status === 409)
    expect(ok).toHaveLength(1)
    expect(conflict).toHaveLength(9)
    for (const r of conflict) expect(r.body.error.code).toBe('ALREADY_REFUNDED')

    expect(await db('refunds').where({ order_id: orderId }).then((r) => r.length)).toBe(1)
    expect(await db('journals').where({ order_id: orderId, type: 'REFUND' }).then((r) => r.length)).toBe(1)
    // Restock happened exactly once (MAG back to 50, not above).
    const mag = await db('products').where({ sku: SKU_MAG }).first()
    expect(mag.on_hand_qty).toBe(50)
  })
})

describe('FR-8 AC1 reason codes', () => {
  it('rejects a missing or invalid reason code with 400 INVALID_INPUT', async () => {
    const { orderId } = await paidOrder(EVAL02)
    const missing = await asUser(PROV_USER).post(`/api/orders/${orderId}/refund`).send({})
    expect(missing.status).toBe(400)
    expect(missing.body.error.code).toBe('INVALID_INPUT')
    const bad = await asUser(PROV_USER).post(`/api/orders/${orderId}/refund`).send({ reasonCode: 'because' })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('INVALID_INPUT')
    // Still refundable afterwards (nothing was posted).
    expect(await db('refunds').where({ order_id: orderId }).then((r) => r.length)).toBe(0)
  })

  it('accepts every schema reason code', async () => {
    for (const code of ['damaged', 'wrong_item', 'patient_request', 'provider_error', 'other']) {
      const { orderId } = await paidOrder(EVAL02)
      const res = await asUser(PROV_USER).post(`/api/orders/${orderId}/refund`).send({ reasonCode: code })
      expect(res.status).toBe(200)
      expect(res.body.reasonCode).toBe(code)
    }
  })
})

describe('RT-01 ownership on refund', () => {
  it('a provider from another practice gets 404 and cannot refund', async () => {
    const { orderId } = await paidOrder(EVAL02)
    const res = await asUser(PROV_USER2).post(`/api/orders/${orderId}/refund`).send({ reasonCode: 'other' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    expect(await db('refunds').where({ order_id: orderId }).then((r) => r.length)).toBe(0)
  })

  it('Cerbo Admin can refund any order (FR-8 AC1)', async () => {
    const { orderId } = await paidOrder(EVAL02)
    const res = await asUser('admin-cerbo').post(`/api/admin/orders/${orderId}/refund`).send({ reasonCode: 'provider_error' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('refunded')
  })
})

describe('FR-9 fulfillment stub', () => {
  it('marks a paid order fulfilled and is idempotent', async () => {
    const { orderId } = await paidOrder(EVAL02)
    const first = await asUser('admin-cerbo').post(`/api/admin/orders/${orderId}/fulfill`).send({})
    expect(first.status).toBe(200)
    expect(first.body.fulfilledAt).toBeTruthy()
    const order1 = await db('orders').where({ id: orderId }).first()
    expect(order1.status).toBe('paid')
    expect(order1.fulfilled_at).toBeTruthy()

    const second = await asUser('admin-cerbo').post(`/api/admin/orders/${orderId}/fulfill`).send({})
    expect(second.status).toBe(200)
    // Idempotent: same fulfilled-at, still exactly one timestamp.
    expect(second.body.fulfilledAt).toBe(first.body.fulfilledAt)
  })

  it('FR-9 AC2: a refunded order cannot be fulfilled', async () => {
    const { orderId } = await paidOrder(EVAL02)
    const refund = await asUser(PROV_USER).post(`/api/orders/${orderId}/refund`).send({ reasonCode: 'other' })
    expect(refund.status).toBe(200)
    const res = await asUser('admin-cerbo').post(`/api/admin/orders/${orderId}/fulfill`).send({})
    expect(res.status).toBe(409)
    const order = await db('orders').where({ id: orderId }).first()
    expect(order.fulfilled_at).toBeNull()
  })

  it('a sent (unpaid) order cannot be fulfilled', async () => {
    const { orderId } = await sendNewOrder(EVAL02)
    const res = await asUser('admin-cerbo').post(`/api/admin/orders/${orderId}/fulfill`).send({})
    expect(res.status).toBe(409)
  })
})

// The refund notice (ADR-023) goes through the Notifier seam, driven at the service
// layer so we can inject an observable StubNotifier (the wired routes use the default
// container). The seam payload is patient-safe BY CONSTRUCTION (RefundNotice only holds
// refundedAmountCents + keepOrDispose), so there is nothing to leak.
const providerActor: Actor = { id: PROV_USER, role: 'provider', providerId: PROVIDER, practiceId: PRACTICE }
const adminActor: Actor = { id: 'admin-cerbo', role: 'cerbo_admin' }

describe('ADR-023 patient refund notice (Notifier seam)', () => {
  it('a refund BEFORE fulfillment sends exactly one notice, keepOrDispose=false (nothing shipped)', async () => {
    const { orderId } = await paidOrder(EVAL02)
    const notifier = new StubNotifier()
    const result = await refundOrder(db, providerActor, orderId, { reasonCode: 'patient_request' }, createSeams({ notifier }))

    expect(result.restocked).toBe(true)
    expect(notifier.refundNotices).toHaveLength(1)
    const { recipient, notice } = notifier.refundNotices[0]
    expect(recipient.id).toBe(PATIENT)
    expect(notice.refundedAmountCents).toBe(4999)
    expect(notice.keepOrDispose).toBe(false) // restocked, nothing to return
    // Payload is a strict whitelist - no economics can ride along.
    expect(Object.keys(notice).sort()).toEqual(['keepOrDispose', 'refundedAmountCents'])
  })

  it('a refund AFTER fulfillment sends keepOrDispose=true (written off, do not return)', async () => {
    const { orderId } = await paidOrder(EVAL02)
    await fulfillOrder(db, adminActor, orderId, createSeams())
    const notifier = new StubNotifier()
    const result = await refundOrder(db, adminActor, orderId, { reasonCode: 'damaged' }, createSeams({ notifier }))

    expect(result.restocked).toBe(false)
    expect(notifier.refundNotices).toHaveLength(1)
    expect(notifier.refundNotices[0].notice).toEqual({ refundedAmountCents: 4999, keepOrDispose: true })
  })

  it('a notifier failure does NOT roll back or fail the refund (post-commit boundary)', async () => {
    const { orderId } = await paidOrder(EVAL02)
    const throwing: Notifier = {
      async sendPayLink() {},
      async sendRefundNotice() {
        throw new Error('notifier is down')
      }
    }
    // The refund still succeeds and is durable despite the notifier throwing.
    const result = await refundOrder(db, providerActor, orderId, { reasonCode: 'other' }, createSeams({ notifier: throwing }))
    expect(result.status).toBe('refunded')

    const order = await db('orders').where({ id: orderId }).first()
    expect(order.status).toBe('refunded')
    expect(await db('refunds').where({ order_id: orderId }).then((r) => r.length)).toBe(1)
    expect(await db('journals').where({ order_id: orderId, type: 'REFUND' }).then((r) => r.length)).toBe(1)
  })
})
