// T4 API tests: patient payment, ledger posting, audit (FR-5, FR-6 AC4, FR-7 AC1).
//
// Runs against real Postgres (DATABASE_URL). Migrations applied via the tsx CLI in
// beforeAll (the T2/T3-proven pattern - knex raw-requires .ts migrations outside vite's
// transform, so db.migrate.latest() throws under vitest).
//
// ISOLATION: these tests use a DEDICATED practice/provider/patient and dedicated SKUs,
// never the seed rows that orders.test.ts mutates (it deletes all prov-ana/prov-ben
// orders in beforeEach). That keeps the two suites race-free even when vitest runs them
// in parallel forks. Paid orders cannot be torn down (the ledger/payment tables are
// append-only), so every test creates a FRESH order and we reset only our SKUs' stock.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { db } from '../../src/db/knex'
import { createApp } from '../../src/app'
import { createKnexActorLoader } from '../../src/auth/loadActor'
import { seedCore } from '../../src/db/seeds/01_core'
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
// Patient routes use the token, never X-Demo-User.
const anon = {
  post: (url: string) => request(app).post(url),
  get: (url: string) => request(app).get(url)
}

// Dedicated practice/provider/patient/user (NOT the seed prov-ana/prov-ben that
// orders.test.ts deletes). Patient economics aside, these are not products, so they do
// not affect the protected "exactly 5 products" invariant. We reuse the SEED SKUs
// read/write and restore their canonical stock in beforeEach - no new products added.
const PRACTICE = '44444444-4444-4444-4444-444444444444'
const PROVIDER = 'aaaaaaaa-0000-0000-0000-0000000000f4'
const PATIENT = 'cccccccc-0000-0000-0000-0000000000f4'
const PROV_USER = 't4-prov'
const SKU_MAG = 'MAG-GLY-120'
const SKU_VITD = 'VITD3-K2'
const SKU_SOLO = 'OMEGA3-1000'

// Canonical seed stock for the SKUs this suite uses (docs/EVALS.md seed table).
const CANONICAL_STOCK: Record<string, number> = {
  [SKU_MAG]: 50,
  [SKU_VITD]: 40,
  [SKU_SOLO]: 30
}

async function setupFixtures(): Promise<void> {
  await seedCore(db) // ensure the seed SKUs exist (idempotent)
  await db('practices').insert({ id: PRACTICE, name: 'T4 Practice' }).onConflict('id').merge()
  await db('providers')
    .insert({ id: PROVIDER, practice_id: PRACTICE, name: 'Dr. T4', email: 't4@example.com' })
    .onConflict('id')
    .merge()
  await db('patients')
    .insert({ id: PATIENT, practice_id: PRACTICE, name: 'Tess Patient', email: 'tess@example.com', ship_to: '1 T4 St' })
    .onConflict('id')
    .merge()
  await db('users')
    .insert({ id: PROV_USER, role: 'provider', provider_id: PROVIDER, patient_id: null, display_name: 'Dr. T4' })
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

/** Create a draft for the T4 patient, add lines, send it; return order id + pay token. */
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
  // Push the reservation window far out so the global reservation-expiry sweep that
  // other suites (orders.test.ts EVAL-14) run with a +7-day clock never touches these
  // orders. T4's own ORDER_EXPIRED test sets the expired state explicitly instead.
  await db('orders')
    .where({ id: orderId })
    .update({ reservation_expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) })
  return { orderId, token: send.body.order.payToken as string }
}

// The canonical EVAL-01 order shape on the T4 SKUs.
const EVAL01: Line[] = [
  { sku: SKU_MAG, qty: 2, price: 2999 },
  { sku: SKU_VITD, qty: 1, price: 2500 } // markup 1356: with MAG x2 the order rounds once to 8497 (EVAL-01)
]

describe('FR-5 AC1 / EVAL-12 patient-safe view (whitelist)', () => {
  it('GET /api/pay/:token returns exactly the whitelisted keys, no economics (RT-10)', async () => {
    const { token } = await sendNewOrder(EVAL01)
    const res = await anon.get(`/api/pay/${token}`)
    expect(res.status).toBe(200)

    // Strict key set on the view.
    expect(Object.keys(res.body).sort()).toEqual(['items', 'patientFirstName', 'status', 'totalCents'])
    expect(res.body.totalCents).toBe(8497)
    expect(res.body.status).toBe('sent')
    expect(res.body.patientFirstName).toBe('Tess')

    // Strict key set on each item - no cogs/fee/margin.
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(['lineTotalCents', 'name', 'qty', 'unitPriceCents'])
    }
    // Nothing in the serialized payload mentions provider economics.
    const blob = JSON.stringify(res.body).toLowerCase()
    for (const leak of ['cogs', 'margin', 'fee', 'provider', 'practice']) {
      expect(blob).not.toContain(leak)
    }
  })

  it('unknown token returns 404 and leaks nothing (RT-02)', async () => {
    const res = await anon.get(`/api/pay/${'z'.repeat(32)}`)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })
})

describe('FR-5 AC4 / EVAL-06b pay happy path: payment, stock, per-line journal', () => {
  it('charges the snapshot subtotal, sells stock, and posts a balanced per-line PAYMENT journal', async () => {
    const { orderId, token } = await sendNewOrder(EVAL01)

    const res = await anon.post(`/api/pay/${token}`).send({ idempotencyKey: randomUUID() })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'paid', totalCents: 8497 })
    expect(res.body.paymentId).toBeTruthy()

    // Exactly one payment at the subtotal.
    const payments = await db('payments').where({ order_id: orderId })
    expect(payments).toHaveLength(1)
    expect(payments[0].amount_cents).toBe(8497)

    // Stock: reserved released and sold (EVAL-06b: MAG 48, VITD 39, reserved 0).
    const mag = await db('products').where({ sku: SKU_MAG }).first()
    const vitd = await db('products').where({ sku: SKU_VITD }).first()
    expect(mag.on_hand_qty).toBe(48)
    expect(mag.reserved_qty).toBe(0)
    expect(vitd.on_hand_qty).toBe(39)
    expect(vitd.reserved_qty).toBe(0)
    const sales = await db('inventory_movements').where({ order_id: orderId, reason: 'sale' })
    expect(sales).toHaveLength(2)

    // Exactly one PAYMENT journal; entries per line; totals per account (EVAL-06b).
    const journals = await db('journals').where({ order_id: orderId, type: 'PAYMENT' })
    expect(journals).toHaveLength(1)
    const entries = await db('ledger_entries').where({ journal_id: journals[0].id })
    // 2 lines x 4 accounts.
    expect(entries).toHaveLength(8)
    // Every entry maps to a SKU (line_id set) and carries provider/practice attribution.
    for (const e of entries) {
      expect(e.line_id).toBeTruthy()
      expect(e.provider_id).toBe(PROVIDER)
      expect(e.practice_id).toBe(PRACTICE)
    }
    const sumBy = (account: string) =>
      entries.filter((e) => e.account === account).reduce((a, e) => a + e.amount_cents, 0)
    expect(sumBy('CASH_CLEARING')).toBe(8497)
    expect(sumBy('COGS_RECOVERY')).toBe(-4025)
    expect(sumBy('PROVIDER_PAYABLE')).toBe(-4408)
    expect(sumBy('PLATFORM_FEE_REVENUE')).toBe(-64)
    // The whole journal sums to zero (money rule 7).
    expect(entries.reduce((a, e) => a + e.amount_cents, 0)).toBe(0)
  })
})

describe('FR-5 AC2 / EVAL-06 idempotency', () => {
  it('same key twice returns the same payment id; a new key returns ALREADY_PAID; exactly 1 payment + 1 journal', async () => {
    const { orderId, token } = await sendNewOrder(EVAL01)
    const key = randomUUID()

    const first = await anon.post(`/api/pay/${token}`).send({ idempotencyKey: key })
    expect(first.status).toBe(200)
    const second = await anon.post(`/api/pay/${token}`).send({ idempotencyKey: key })
    expect(second.status).toBe(200)
    expect(second.body.paymentId).toBe(first.body.paymentId)

    const third = await anon.post(`/api/pay/${token}`).send({ idempotencyKey: randomUUID() })
    expect(third.status).toBe(409)
    expect(third.body.error.code).toBe('ALREADY_PAID')

    expect(await db('payments').where({ order_id: orderId }).then((r) => r.length)).toBe(1)
    expect(
      await db('journals').where({ order_id: orderId, type: 'PAYMENT' }).then((r) => r.length)
    ).toBe(1)
  })

  it('requires an idempotency key (FR-5 AC2)', async () => {
    const { token } = await sendNewOrder(EVAL01)
    const res = await anon.post(`/api/pay/${token}`).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_INPUT')
  })
})

describe('RT-03 client-supplied amounts are ignored (money rule 9)', () => {
  it('a tampered amount/total/price in the pay body does not change the charge', async () => {
    const { orderId, token } = await sendNewOrder(EVAL01)
    const res = await anon
      .post(`/api/pay/${token}`)
      .send({ idempotencyKey: randomUUID(), amountCents: 1, totalCents: 1, subtotalCents: 1, unitPriceCents: 1 })
    expect(res.status).toBe(200)
    expect(res.body.totalCents).toBe(8497)
    const payment = await db('payments').where({ order_id: orderId }).first()
    expect(payment.amount_cents).toBe(8497)
  })
})

describe('FR-5 AC4 / EVAL-06d decline path (transaction boundary)', () => {
  it('a declined charge (1313) leaves the order sent with no payment and no journal', async () => {
    // Single line totalling 1313 cents triggers the stub gateway decline.
    const { orderId, token } = await sendNewOrder([{ sku: SKU_VITD, qty: 1, price: 1313 }])
    const before = await db('products').where({ sku: SKU_VITD }).first()
    expect(before.reserved_qty).toBe(1)

    const res = await anon.post(`/api/pay/${token}`).send({ idempotencyKey: randomUUID() })
    expect(res.status).toBe(402)
    expect(res.body.error.code).toBe('PAYMENT_DECLINED')
    // Error body leaks no economics (RT-10).
    const blob = JSON.stringify(res.body).toLowerCase()
    for (const leak of ['cogs', 'margin', 'fee']) expect(blob).not.toContain(leak)

    // Nothing persisted: order still sent, no payment, no journal, stock untouched.
    const order = await db('orders').where({ id: orderId }).first()
    expect(order.status).toBe('sent')
    expect(await db('payments').where({ order_id: orderId }).then((r) => r.length)).toBe(0)
    expect(await db('journals').where({ order_id: orderId }).then((r) => r.length)).toBe(0)
    const after = await db('products').where({ sku: SKU_VITD }).first()
    expect(after.on_hand_qty).toBe(40)
    expect(after.reserved_qty).toBe(1)
  })
})

describe('FR-5 AC3 order state guards', () => {
  it('RT-15: paying an expired order returns ORDER_EXPIRED and does not oversell', async () => {
    const { orderId, token } = await sendNewOrder([{ sku: SKU_MAG, qty: 1, price: 2999 }])
    // Simulate the expiry job having run: release the reservation and mark expired.
    await db('products').where({ sku: SKU_MAG }).update({ reserved_qty: 0 })
    await db('orders').where({ id: orderId }).update({ status: 'expired', expired_at: new Date() })

    const res = await anon.post(`/api/pay/${token}`).send({ idempotencyKey: randomUUID() })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('ORDER_EXPIRED')
    // No oversell: nothing sold.
    const mag = await db('products').where({ sku: SKU_MAG }).first()
    expect(mag.on_hand_qty).toBe(50)
    expect(await db('payments').where({ order_id: orderId }).then((r) => r.length)).toBe(0)
  })

  it('a cancelled order is ORDER_NOT_PAYABLE', async () => {
    const { orderId, token } = await sendNewOrder([{ sku: SKU_MAG, qty: 1, price: 2999 }])
    await asUser(PROV_USER).post(`/api/orders/${orderId}/cancel`).send({})
    const res = await anon.post(`/api/pay/${token}`).send({ idempotencyKey: randomUUID() })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('ORDER_NOT_PAYABLE')
  })
})

describe('RT-04 concurrency: parallel pays cannot double-charge or oversell', () => {
  it('10 parallel pays (mixed keys) produce exactly 1 payment, 1 journal, stock sold once', async () => {
    const { orderId, token } = await sendNewOrder([{ sku: SKU_SOLO, qty: 1, price: 2999 }])
    const sharedKey = randomUUID()
    const bodies = [
      ...Array.from({ length: 5 }, () => ({ idempotencyKey: sharedKey })),
      ...Array.from({ length: 5 }, () => ({ idempotencyKey: randomUUID() }))
    ]
    const results = await Promise.all(
      bodies.map((b) => anon.post(`/api/pay/${token}`).send(b))
    )

    // Every response is either a successful pay or ALREADY_PAID; nothing else.
    const paidIds = new Set<string>()
    for (const r of results) {
      if (r.status === 200) paidIds.add(r.body.paymentId)
      else {
        expect(r.status).toBe(409)
        expect(r.body.error.code).toBe('ALREADY_PAID')
      }
    }
    // Exactly one distinct payment id across all successful responses.
    expect(paidIds.size).toBe(1)

    // DB: exactly one payment, one PAYMENT journal, stock sold exactly once.
    expect(await db('payments').where({ order_id: orderId }).then((r) => r.length)).toBe(1)
    expect(
      await db('journals').where({ order_id: orderId, type: 'PAYMENT' }).then((r) => r.length)
    ).toBe(1)
    const solo = await db('products').where({ sku: SKU_SOLO }).first()
    expect(solo.on_hand_qty).toBe(29)
    expect(solo.reserved_qty).toBe(0)
  })
})

describe('FR-7 AC1 / EVAL-06c audit endpoint', () => {
  it('provider audit: all invariant checks pass; status history draft -> sent -> paid', async () => {
    const { orderId, token } = await sendNewOrder(EVAL01)
    await anon.post(`/api/pay/${token}`).send({ idempotencyKey: randomUUID() })

    const res = await asUser(PROV_USER).get(`/api/orders/${orderId}/audit`)
    expect(res.status).toBe(200)

    // Invariants: every check passes, explicitly.
    expect(res.body.invariants.ok).toBe(true)
    for (const check of res.body.invariants.checks) {
      expect(check.pass).toBe(true)
    }

    // ADR-028: every cent is named and nothing is left over as rounding:
    // $84.97 = cost 40.25 + fee 0.64 + provider markup 44.08 (2 x 15.26 + 13.56).
    const names = res.body.invariants.checks.map((c: { name: string }) => c.name)
    for (const n of ['order.price_matches_markup', 'order.every_cent_accounted']) {
      expect(names).toContain(n)
    }
    expect(res.body.order).toMatchObject({ subtotalCents: 8497, cogsCents: 4025, feeCents: 64, marginCents: 4408, markupCents: 4408 })
    expect(res.body.lines.map((l: { lineMarkupCents: number; lineMarginCents: number }) => [l.lineMarkupCents, l.lineMarginCents])).toEqual([
      [3052, 3052],
      [1356, 1356]
    ])

    // Status history.
    expect(res.body.statusHistory.map((e: { toStatus: string }) => e.toStatus)).toEqual([
      'draft',
      'sent',
      'paid'
    ])

    // One balanced PAYMENT journal is present in the audit.
    const payJournal = res.body.journals.find((j: { type: string }) => j.type === 'PAYMENT')
    expect(payJournal).toBeTruthy()
    expect(payJournal.sumsToZero).toBe(true)
    expect(payJournal.entrySumCents).toBe(0)
    expect(payJournal.entries).toHaveLength(8)

    // Order snapshot carries the full economics (provider surface, not patient).
    expect(res.body.order).toMatchObject({ subtotalCents: 8497, cogsCents: 4025, feeCents: 64, marginCents: 4408 })
  })

  it('RT-01: another provider cannot read the audit (404, no leak)', async () => {
    const { orderId, token } = await sendNewOrder(EVAL01)
    await anon.post(`/api/pay/${token}`).send({ idempotencyKey: randomUUID() })
    // prov-ben is a seeded provider in a different practice.
    const res = await asUser('prov-ben').get(`/api/orders/${orderId}/audit`)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('Cerbo Admin can audit any order (FR-7 AC2)', async () => {
    const { orderId, token } = await sendNewOrder(EVAL01)
    await anon.post(`/api/pay/${token}`).send({ idempotencyKey: randomUUID() })
    const res = await asUser('admin-cerbo').get(`/api/admin/orders/${orderId}/audit`)
    expect(res.status).toBe(200)
    expect(res.body.invariants.ok).toBe(true)
    expect(res.body.order.id).toBe(orderId)
  })
})
