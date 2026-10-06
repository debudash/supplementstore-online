// T8 API tests: provider sales dashboard (FR-10) and provider payable report + Cerbo
// Admin month close (FR-11). Covers EVAL-09b (payables credits) and EVAL-10 (month
// close + immutable statement), with the refund-dependent assertions explicitly marked
// pending T5 (refund rows do not exist until T5 merges; see the MR description).
//
// Runs against real Postgres (DATABASE_URL). Migrations applied via the tsx CLI in
// beforeAll (the T2/T3/T4-proven pattern - db.migrate.latest() throws on .ts migrations
// under vitest).
//
// ISOLATION: every test builds a FRESH provider world (random practice/provider/patient
// ids) so exact money totals are deterministic regardless of what other suites - or
// prior runs of this suite against a persistent DB - left behind. Reports are
// provider-scoped, so only the fresh provider's rows count. Paid orders and ledger rows
// are append-only and are never torn down; freshness, not cleanup, keeps totals exact.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { db } from '../../src/db/knex'
import { createApp } from '../../src/app'
import { createKnexActorLoader } from '../../src/auth/loadActor'
import { seedCore } from '../../src/db/seeds/01_core'

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
const anon = {
  post: (url: string) => request(app).post(url)
}

// Seed SKUs this suite uses (canonical cogs from docs/EVALS.md). Stock reset each test.
const SKU_MAG = 'MAG-GLY-120' // cogs 1450
const SKU_VITD = 'VITD3-K2' // cogs 1125
const SKU_OMEGA = 'OMEGA3-1000' // cogs 2280
const CANONICAL_STOCK: Record<string, number> = {
  [SKU_MAG]: 50,
  [SKU_VITD]: 40,
  [SKU_OMEGA]: 30
}

async function resetStock(): Promise<void> {
  for (const [sku, onHand] of Object.entries(CANONICAL_STOCK)) {
    await db('products').where({ sku }).update({ on_hand_qty: onHand, reserved_qty: 0 })
  }
}

interface ProviderWorld {
  practiceId: string
  providerId: string
  patientId: string
  userId: string
}

/** Build a fresh provider/practice/patient/user so totals are deterministic per test. */
async function makeProviderWorld(): Promise<ProviderWorld> {
  const practiceId = randomUUID()
  const providerId = randomUUID()
  const patientId = randomUUID()
  const userId = `t8-${randomUUID().slice(0, 12)}`
  await db('practices').insert({ id: practiceId, name: 'T8 Practice' })
  await db('providers').insert({
    id: providerId,
    practice_id: practiceId,
    name: 'Dr. T8',
    email: `${userId}@t8.example`
  })
  await db('patients').insert({
    id: patientId,
    practice_id: practiceId,
    name: 'Pat T8',
    email: `${patientId}@t8.example`,
    ship_to: '1 T8 St'
  })
  await db('users').insert({
    id: userId,
    role: 'provider',
    provider_id: providerId,
    patient_id: null,
    display_name: 'Dr. T8'
  })
  return { practiceId, providerId, patientId, userId }
}

interface Line {
  sku: string
  qty: number
  price: number
}

/** Create a draft, add lines, send, and pay through the REAL API/posting path. */
async function payNewOrder(world: ProviderWorld, lines: Line[]): Promise<string> {
  const draft = await asUser(world.userId).post('/api/orders').send({ patientId: world.patientId })
  expect(draft.status).toBe(201)
  const orderId = draft.body.id as string
  for (const l of lines) {
    const r = await asUser(world.userId)
      .post(`/api/orders/${orderId}/lines`)
      .send({ sku: l.sku, qty: l.qty, unitPriceCents: l.price })
    expect(r.status).toBe(200)
  }
  const send = await asUser(world.userId).post(`/api/orders/${orderId}/send`).send({})
  expect(send.status).toBe(200)
  const token = send.body.order.payToken as string
  const pay = await anon.post(`/api/pay/${token}`).send({ idempotencyKey: randomUUID() })
  expect(pay.status).toBe(200)
  return orderId
}

// The canonical EVAL-01 and EVAL-02 order shapes on the seed SKUs.
const EVAL01: Line[] = [
  { sku: SKU_MAG, qty: 2, price: 2999 }, // margin 3053, fee 45
  { sku: SKU_VITD, qty: 1, price: 2499 } // margin 1355, fee 19
] // subtotal 8497, cogs 4025, fee 64, margin 4408
const EVAL02: Line[] = [{ sku: SKU_OMEGA, qty: 1, price: 4999 }] // fee 37, margin 2682

/** Refund an order through the REAL T5 refund path (Cerbo Admin route). */
async function refundViaAdmin(orderId: string, reasonCode = 'patient_request'): Promise<void> {
  const res = await asUser('admin-cerbo').post(`/api/admin/orders/${orderId}/refund`).send({ reasonCode })
  expect(res.status).toBe(200)
}

/** Mark an order fulfilled through the REAL T5 fulfillment path (Cerbo Admin route). */
async function fulfillViaAdmin(orderId: string): Promise<void> {
  const res = await asUser('admin-cerbo').post(`/api/admin/orders/${orderId}/fulfill`).send({})
  expect(res.status).toBe(200)
}

beforeAll(async () => {
  migrateViaCli()
  await seedCore(db)
})

beforeEach(async () => {
  await resetStock()
})

afterAll(async () => {
  await db.destroy()
})

describe('FR-10 provider sales dashboard (figures from the ledger)', () => {
  it('reports GMV, platform fees and provider net margin from PAYMENT journals (EVAL-09 inputs)', async () => {
    const world = await makeProviderWorld()
    await payNewOrder(world, EVAL01) // GMV 8497, fee 64, margin 4408
    await payNewOrder(world, EVAL02) // GMV 4999, fee 37, margin 2682

    const res = await asUser(world.userId).get('/api/reports/sales')
    expect(res.status).toBe(200)

    // GMV = sum of PAYMENT CASH_CLEARING debits (EVAL-09: Total GMV 13496).
    expect(res.body.gmvCents).toBe(13496)
    // Platform fee revenue = -(sum PLATFORM_FEE_REVENUE) (EVAL-09: Fee revenue 101).
    expect(res.body.platformFeeCents).toBe(101)
    // No refunds until T5: refunded 0, settled == GMV, net margin = both orders' margin.
    expect(res.body.refundedGmvCents).toBe(0)
    expect(res.body.settledGmvCents).toBe(13496)
    expect(res.body.providerNetMarginCents).toBe(4408 + 2682)

    // Units sold by SKU (qty, from paid orders).
    const units = Object.fromEntries(
      res.body.unitsBySku.map((u: { sku: string; units: number }) => [u.sku, u.units])
    )
    expect(units[SKU_MAG]).toBe(2)
    expect(units[SKU_VITD]).toBe(1)
    expect(units[SKU_OMEGA]).toBe(1)

    // Orders by status: 2 paid orders for this fresh provider.
    const paid = res.body.ordersByStatus.find((o: { status: string }) => o.status === 'paid')
    expect(paid.count).toBe(2)
  })

  it('EVAL-09 (sales side): a real refund moves GMV from settled to refunded', async () => {
    const world = await makeProviderWorld()
    const refunded = await payNewOrder(world, EVAL01) // GMV 8497, margin 4408
    await payNewOrder(world, EVAL02) // GMV 4999, margin 2682 (kept)
    await refundViaAdmin(refunded) // EVAL-01 refunded through the REAL T5 path

    const res = await asUser(world.userId).get('/api/reports/sales')
    expect(res.status).toBe(200)
    // EVAL-09 headline figures (provider ana is the only provider in that scenario).
    expect(res.body.gmvCents).toBe(13496) // Total GMV unchanged by the refund
    expect(res.body.refundedGmvCents).toBe(8497) // Refunded GMV
    expect(res.body.settledGmvCents).toBe(4999) // Settled GMV
    expect(res.body.platformFeeCents).toBe(101) // fee revenue incl. retained fee (64 + 37)
    expect(res.body.providerNetMarginCents).toBe(2682) // only the kept (EVAL-02) order
  })

  it('ownership: a provider never sees another provider\'s figures (RT-01 style)', async () => {
    const a = await makeProviderWorld()
    const b = await makeProviderWorld()
    await payNewOrder(a, EVAL01) // only provider A has GMV
    await payNewOrder(b, EVAL02) // only provider B has GMV

    const aRes = await asUser(a.userId).get('/api/reports/sales')
    const bRes = await asUser(b.userId).get('/api/reports/sales')
    expect(aRes.body.gmvCents).toBe(8497)
    expect(aRes.body.providerId).toBe(a.providerId)
    expect(bRes.body.gmvCents).toBe(4999)
    expect(bRes.body.providerId).toBe(b.providerId)
    // A's GMV must not leak B's order and vice versa.
    expect(aRes.body.gmvCents).not.toBe(bRes.body.gmvCents)
  })

  it('a custom from/to range narrows the window; out-of-range paid orders are excluded', async () => {
    const world = await makeProviderWorld()
    await payNewOrder(world, EVAL01) // paid now (current month)

    // A fully-past window has none of this provider's orders.
    const past = await asUser(world.userId).get('/api/reports/sales?from=2000-01-01&to=2000-01-31')
    expect(past.status).toBe(200)
    expect(past.body.gmvCents).toBe(0)
    expect(past.body.period).toEqual({ from: '2000-01-01', to: '2000-01-31' })
  })
})

describe('FR-11 provider payable report (EVAL-09b, verified via the REAL refund path)', () => {
  it('EVAL-09b: credits 7090, debits 4472, closing 2618 after refunding EVAL-01', async () => {
    const world = await makeProviderWorld()
    const refunded = await payNewOrder(world, EVAL01) // PROVIDER_PAYABLE -4408
    await payNewOrder(world, EVAL02) // PROVIDER_PAYABLE -2682
    // Refund EVAL-01 through the REAL T5 refund service (not a hand-written journal):
    // PROVIDER_PAYABLE +4408 (margin_reversal) +64 (fee_retention) posted this period.
    await refundViaAdmin(refunded)

    const res = await asUser(world.userId).get('/api/reports/payables')
    expect(res.status).toBe(200)
    // EVAL-09b exact expected values from docs/EVALS.md.
    expect(res.body.creditsCents).toBe(7090) // 4408 + 2682 margins earned
    expect(res.body.debitsCents).toBe(4472) // 4408 margin reversal + 64 fee retention
    expect(res.body.openingCents).toBe(0)
    expect(res.body.closingCents).toBe(2618) // 7090 - 4472

    // ADR-012: the refunded order nets to -(fee) = -64 for the provider (provider eats
    // the retained platform fee), proving the fee retention IS reflected in payables.
    const refundedOrder = res.body.contributingOrders.find(
      (o: { orderId: string }) => o.orderId === refunded
    )
    expect(refundedOrder.creditsCents).toBe(4408)
    expect(refundedOrder.debitsCents).toBe(4472) // margin 4408 + fee 64
    expect(refundedOrder.netCents).toBe(-64)
  })

  it('both refund branches debit margin + retained fee (ADR-012): before AND after fulfillment', async () => {
    // Before fulfillment (restocked): EVAL-01 refund debits 4408 + 64 = 4472.
    const a = await makeProviderWorld()
    const beforeFulfil = await payNewOrder(a, EVAL01)
    await refundViaAdmin(beforeFulfil)
    const aRes = await asUser(a.userId).get('/api/reports/payables')
    expect(aRes.body.debitsCents).toBe(4472)
    expect(aRes.body.closingCents).toBe(-64) // credits 4408 - debits 4472

    // After fulfillment (written off, Cerbo bears COGS): the payable debit is UNCHANGED
    // (fulfillment only affects inventory/write-off, not PROVIDER_PAYABLE). EVAL-02
    // refund debits 2682 + 37 = 2719.
    const b = await makeProviderWorld()
    const afterFulfil = await payNewOrder(b, EVAL02)
    await fulfillViaAdmin(afterFulfil)
    await refundViaAdmin(afterFulfil, 'damaged')
    const bRes = await asUser(b.userId).get('/api/reports/payables')
    expect(bRes.body.debitsCents).toBe(2719) // margin 2682 + fee 37
    expect(bRes.body.closingCents).toBe(-37) // credits 2682 - debits 2719 (provider eats the fee)
  })

  it('opening balance carries the prior-period payable forward', async () => {
    const world = await makeProviderWorld()
    await payNewOrder(world, EVAL01) // payable -4408 now (current month)

    // Next month's report opens with this month's closing balance (4408) carried in.
    const now = new Date()
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    const y = nextMonth.getUTCFullYear()
    const m = String(nextMonth.getUTCMonth() + 1).padStart(2, '0')
    const from = `${y}-${m}-01`
    const to = `${y}-${m}-28`
    const res = await asUser(world.userId).get(`/api/reports/payables?from=${from}&to=${to}`)
    expect(res.status).toBe(200)
    expect(res.body.openingCents).toBe(4408)
    expect(res.body.creditsCents).toBe(0)
    expect(res.body.closingCents).toBe(4408)
  })
})

/**
 * Insert a backdated, balanced PAYMENT journal directly (not via the pay flow) so the
 * test can place payable activity in a chosen period and/or at amounts large enough to
 * exceed int4. All four per-line entries are inserted in ONE statement so the deferred
 * zero-sum trigger sees a balanced journal at commit. This is PAYMENT-side only - it
 * does NOT fabricate REFUND journals (those must come from T5's real posting path).
 */
async function insertPaymentLedger(
  world: ProviderWorld,
  opts: { postedAt: Date; perLine: { total: number; cogs: number; fee: number; margin: number }; lines: number }
): Promise<string> {
  const orderId = randomUUID()
  await db('orders').insert({
    id: orderId,
    provider_id: world.providerId,
    practice_id: world.practiceId,
    patient_id: world.patientId,
    kind: 'one_off',
    status: 'paid',
    paid_at: opts.postedAt,
    created_at: opts.postedAt
  })
  const journalId = randomUUID()
  await db('journals').insert({
    id: journalId,
    order_id: orderId,
    type: 'PAYMENT',
    ref_id: null,
    posted_at: opts.postedAt,
    is_synthetic: false
  })
  const { total, cogs, fee, margin } = opts.perLine
  const base = {
    journal_id: journalId,
    order_id: orderId,
    line_id: null,
    provider_id: world.providerId,
    practice_id: world.practiceId,
    memo: null,
    is_synthetic: false
  }
  const entries = []
  for (let i = 0; i < opts.lines; i++) {
    entries.push(
      { ...base, account: 'CASH_CLEARING', amount_cents: total },
      { ...base, account: 'COGS_RECOVERY', amount_cents: -cogs },
      { ...base, account: 'PROVIDER_PAYABLE', amount_cents: -margin },
      { ...base, account: 'PLATFORM_FEE_REVENUE', amount_cents: -fee }
    )
  }
  await db('ledger_entries').insert(entries)
  return orderId
}

/**
 * Insert a backdated but FULLY REAL-SHAPED paid EVAL-01 order (order + lines + payments
 * row + balanced PAYMENT journal), so the T5 refund service can later refund it through
 * the REAL path. Backdating the PAYMENT is a test fixture (journals.posted_at is DB now()
 * and cannot be moved after insert, and append-only rules forbid UPDATE); the REFUND
 * itself is NOT fabricated - it is driven through POST /api/admin/orders/:id/refund and
 * posts a real REFUND journal at the real current time. This is the only way to place a
 * payment in a prior calendar month while exercising the genuine refund posting.
 */
async function insertBackdatedPaidEval01(world: ProviderWorld, postedAt: Date): Promise<string> {
  const orderId = randomUUID()
  await db('orders').insert({
    id: orderId,
    provider_id: world.providerId,
    practice_id: world.practiceId,
    patient_id: world.patientId,
    kind: 'one_off',
    status: 'paid',
    paid_at: postedAt,
    created_at: postedAt,
    fee_bps: 75,
    subtotal_cents: 8497,
    cogs_cents: 4025,
    fee_cents: 64,
    margin_cents: 4408
  })
  const line1 = randomUUID()
  const line2 = randomUUID()
  await db('order_lines').insert([
    {
      id: line1, order_id: orderId, position: 1, sku: SKU_MAG, qty: 2,
      unit_price_cents: 2999, unit_cogs_cents: 1450,
      line_total_cents: 5998, line_cogs_cents: 2900, line_fee_cents: 45, line_margin_cents: 3053
    },
    {
      id: line2, order_id: orderId, position: 2, sku: SKU_VITD, qty: 1,
      unit_price_cents: 2499, unit_cogs_cents: 1125,
      line_total_cents: 2499, line_cogs_cents: 1125, line_fee_cents: 19, line_margin_cents: 1355
    }
  ])
  await db('payments').insert({
    order_id: orderId,
    idempotency_key: randomUUID(),
    gateway_ref: 'stub_backdated',
    amount_cents: 8497,
    created_at: postedAt
  })
  const journalId = randomUUID()
  await db('journals').insert({
    id: journalId, order_id: orderId, type: 'PAYMENT', ref_id: null, posted_at: postedAt, is_synthetic: false
  })
  const base = {
    journal_id: journalId, order_id: orderId,
    provider_id: world.providerId, practice_id: world.practiceId, memo: null, is_synthetic: false
  }
  await db('ledger_entries').insert([
    { ...base, line_id: line1, account: 'CASH_CLEARING', amount_cents: 5998 },
    { ...base, line_id: line1, account: 'COGS_RECOVERY', amount_cents: -2900 },
    { ...base, line_id: line1, account: 'PROVIDER_PAYABLE', amount_cents: -3053 },
    { ...base, line_id: line1, account: 'PLATFORM_FEE_REVENUE', amount_cents: -45 },
    { ...base, line_id: line2, account: 'CASH_CLEARING', amount_cents: 2499 },
    { ...base, line_id: line2, account: 'COGS_RECOVERY', amount_cents: -1125 },
    { ...base, line_id: line2, account: 'PROVIDER_PAYABLE', amount_cents: -1355 },
    { ...base, line_id: line2, account: 'PLATFORM_FEE_REVENUE', amount_cents: -19 }
  ])
  return orderId
}

describe('AGENTS money rule 10: large aggregates stay exact (no bigint/Number() drift)', () => {
  it('GMV and payable credits summing past int4 are returned as exact safe integers', async () => {
    const world = await makeProviderWorld()
    // 10 lines x per-line CASH 2,000,000,000 (< int4 max 2,147,483,647 per row).
    // SUM crosses int4 into bigint: GMV 20,000,000,000; credits 5,000,000,000.
    await insertPaymentLedger(world, {
      postedAt: new Date(),
      perLine: { total: 2_000_000_000, cogs: 1_000_000_000, fee: 500_000_000, margin: 500_000_000 },
      lines: 10
    })

    const sales = await asUser(world.userId).get('/api/reports/sales')
    expect(sales.status).toBe(200)
    expect(sales.body.gmvCents).toBe(20_000_000_000)
    expect(sales.body.platformFeeCents).toBe(5_000_000_000)

    const payables = await asUser(world.userId).get('/api/reports/payables')
    expect(payables.status).toBe(200)
    expect(payables.body.creditsCents).toBe(5_000_000_000)
    expect(payables.body.closingCents).toBe(5_000_000_000)
    // Beyond int4 but within Number.MAX_SAFE_INTEGER - no silent precision loss.
    expect(Number.isSafeInteger(payables.body.creditsCents)).toBe(true)
  })
})

describe('FR-11 AC3 / EVAL-10 Cerbo Admin month close -> immutable statement', () => {
  // A unique, far-past month so only this test's backdated provider has activity before
  // its end (every real order from other suites/runs is dated now()). Random year keeps
  // the close idempotent across re-runs against a persistent DB.
  const closeYear = 1200 + Math.floor(Math.random() * 700)
  const month = `${closeYear}-06`
  const periodStart = `${closeYear}-06-01`
  const monthStart = new Date(Date.UTC(closeYear, 5, 15)) // mid-month, inside the window

  it('closing a month creates an immutable statement; closing twice is rejected (EVAL-10 M-side)', async () => {
    const world = await makeProviderWorld()
    // One backdated paid order in month M: payable credit (margin) 4408.
    await insertPaymentLedger(world, {
      postedAt: monthStart,
      perLine: { total: 8497, cogs: 4025, fee: 64, margin: 4408 },
      lines: 1
    })

    const close = await asUser('admin-cerbo').post('/api/admin/payables/close').send({ month })
    expect(close.status).toBe(201)
    expect(close.body.periodStart).toBe(periodStart)
    const mine = close.body.statements.find(
      (s: { providerId: string }) => s.providerId === world.providerId
    )
    expect(mine).toBeTruthy()
    expect(mine.openingCents).toBe(0)
    expect(mine.creditsCents).toBe(4408)
    expect(mine.debitsCents).toBe(0)
    expect(mine.closingCents).toBe(4408)
    expect(mine.periodStart).toBe(periodStart)

    // The statement row is immutable at the DB level (T2 trigger): UPDATE is rejected.
    await expect(
      db('payable_statements').where({ id: mine.id }).update({ closing_cents: 0 })
    ).rejects.toThrow()

    // Closing the same month again is rejected (unique (provider_id, period_start)).
    const second = await asUser('admin-cerbo').post('/api/admin/payables/close').send({ month })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('ALREADY_CLOSED')

    // GET returns the stored, closed statements for the month.
    const view = await asUser('admin-cerbo').get(`/api/admin/payables?month=${month}`)
    expect(view.status).toBe(200)
    expect(view.body.closed).toBe(true)
    const viewMine = view.body.statements.find(
      (s: { providerId: string }) => s.providerId === world.providerId
    )
    expect(viewMine.closingCents).toBe(4408)
  })

  it('ADR-014 / EVAL-10: a late refund of a closed-month order posts to the CURRENT period; the closed statement is never rewritten', async () => {
    // Distinct 4-digit past-year range from the test above so the two closes never
    // collide in a run (that test uses [1200, 1899]); years stay before the real "now".
    const mYear = 1000 + Math.floor(Math.random() * 200)
    const mMonth = `${mYear}-06`
    const mPaidAt = new Date(Date.UTC(mYear, 5, 10)) // inside month M (far past)

    const world = await makeProviderWorld()
    // Order PAID in month M (credit margin 4408), fully real-shaped so it can be refunded.
    const orderId = await insertBackdatedPaidEval01(world, mPaidAt)

    // Close month M: the statement captures the 4408 credit.
    const close = await asUser('admin-cerbo').post('/api/admin/payables/close').send({ month: mMonth })
    expect(close.status).toBe(201)
    const mStmt = close.body.statements.find(
      (s: { providerId: string }) => s.providerId === world.providerId
    )
    expect(mStmt.creditsCents).toBe(4408)
    expect(mStmt.debitsCents).toBe(0)
    expect(mStmt.closingCents).toBe(4408)

    // Refund through the REAL T5 path. The REFUND journal posts at now() = CURRENT month.
    await refundViaAdmin(orderId)

    // ADR-014: the CLOSED month-M statement is NEVER rewritten - still credits-only.
    const view = await asUser('admin-cerbo').get(`/api/admin/payables?month=${mMonth}`)
    expect(view.body.closed).toBe(true)
    const stored = view.body.statements.find(
      (s: { providerId: string }) => s.providerId === world.providerId
    )
    expect(stored.creditsCents).toBe(4408)
    expect(stored.debitsCents).toBe(0)
    expect(stored.closingCents).toBe(4408)

    // EVAL-10: M+1 (the current, open period) shows the refund as a debit = margin + fee.
    const current = await asUser(world.userId).get('/api/reports/payables')
    expect(current.body.openingCents).toBe(4408) // carried forward from the closed month
    expect(current.body.creditsCents).toBe(0)
    expect(current.body.debitsCents).toBe(4472) // 4408 margin reversal + 64 fee retention
    expect(current.body.closingCents).toBe(-64) // provider eats the retained fee (ADR-012)
  })
})

describe('admin payables input validation', () => {
  it('close without a month is 400 INVALID_INPUT', async () => {
    const res = await asUser('admin-cerbo').post('/api/admin/payables/close').send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_INPUT')
  })

  it('a non-admin cannot reach the admin payables routes (403)', async () => {
    const world = await makeProviderWorld()
    const res = await asUser(world.userId).get('/api/admin/payables?month=2026-01')
    expect(res.status).toBe(403)
  })
})
