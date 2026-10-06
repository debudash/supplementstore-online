// EVAL-09b and EVAL-10: provider payables and late-refund period handling (ADR-012/014/
// 016), verified INDEPENDENTLY of T8's own tests through the HTTP report routes (T8 + T5
// merged). This suite is the cross-check on T8: the expected cents below come from
// docs/EVALS.md and the orchestrator's stated figures, asserted here against a freshly
// reconstructed scenario. If a number here disagreed with T8 it would be a real finding.
//
// Isolation: payables are an AGGREGATE over a provider's ledger, so the shared prov-ana
// (mutated by every other spec) cannot give deterministic totals. Each case builds its
// OWN fresh provider world (random ids), exactly as aggregate tests must; the figures
// depend only on the orders in the scenario, not on the provider's identity.
//
// EVAL-10 precondition: a payment must sit in a PRIOR calendar month. journals.posted_at
// is DB now() and append-only forbids moving it, and the pay route uses the system clock,
// so the only way to place a historical payment is a backdated, real-SHAPED paid order
// inserted directly (PAYMENT side only - the real EVAL-01 split). The REFUND under test
// is NOT fabricated: it is driven through POST /api/admin/orders/:id/refund and posts a
// real REFUND journal at the real current time. This mirrors the only feasible approach.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect } from 'vitest'
import { anon, asUser, db, evalCase, resetState, ADMIN, SKU } from './_harness'

beforeEach(async () => {
  await resetState()
})
afterAll(async () => {
  await db.destroy()
})

interface World {
  practiceId: string
  providerId: string
  patientId: string
  userId: string
}

/** A fresh provider/practice/patient/user so payable aggregates are deterministic. */
async function makeWorld(): Promise<World> {
  const practiceId = randomUUID()
  const providerId = randomUUID()
  const patientId = randomUUID()
  const userId = `t13r-${randomUUID().slice(0, 12)}`
  await db('practices').insert({ id: practiceId, name: 'T13 Reports Practice' })
  await db('providers').insert({ id: providerId, practice_id: practiceId, name: 'Dr. T13R', email: `${userId}@t13.example` })
  await db('patients').insert({ id: patientId, practice_id: practiceId, name: 'Pat T13R', email: `${patientId}@t13.example`, ship_to: '1 T13 St' })
  await db('users').insert({ id: userId, role: 'provider', provider_id: providerId, patient_id: null, display_name: 'Dr. T13R' })
  return { practiceId, providerId, patientId, userId }
}

interface Line {
  sku: string
  qty: number
  price: number
}
const EVAL01: Line[] = [
  { sku: SKU.MAG, qty: 2, price: 2999 },
  { sku: SKU.VITD, qty: 1, price: 2499 }
] // subtotal 8497, fee 64, margin 4408
const EVAL02: Line[] = [{ sku: SKU.OMEGA, qty: 1, price: 4999 }] // fee 37, margin 2682

/** Draft -> lines -> send -> pay as this world's provider, over HTTP. Returns order id. */
async function payNewOrder(world: World, lines: Line[]): Promise<string> {
  const draft = await asUser(world.userId).post('/api/orders').send({ patientId: world.patientId })
  expect(draft.status).toBe(201)
  const orderId = draft.body.id as string
  for (const l of lines) {
    const r = await asUser(world.userId).post(`/api/orders/${orderId}/lines`).send({ sku: l.sku, qty: l.qty, unitPriceCents: l.price })
    expect(r.status).toBe(200)
  }
  const send = await asUser(world.userId).post(`/api/orders/${orderId}/send`).send({})
  expect(send.status).toBe(200)
  const pay = await anon.post(`/api/pay/${send.body.order.payToken}`).send({ idempotencyKey: randomUUID() })
  expect(pay.status).toBe(200)
  return orderId
}

async function refundViaAdmin(orderId: string, reasonCode = 'patient_request') {
  return asUser(ADMIN).post(`/api/admin/orders/${orderId}/refund`).send({ reasonCode })
}

/** Insert a backdated, real-shaped paid EVAL-01 order (order+lines+payment+PAYMENT
 *  journal) so it can be refunded through the real path from a prior calendar month. */
async function insertBackdatedPaidEval01(world: World, postedAt: Date): Promise<string> {
  const orderId = randomUUID()
  await db('orders').insert({
    id: orderId, provider_id: world.providerId, practice_id: world.practiceId, patient_id: world.patientId,
    kind: 'one_off', status: 'paid', paid_at: postedAt, created_at: postedAt,
    fee_bps: 75, subtotal_cents: 8497, cogs_cents: 4025, fee_cents: 64, margin_cents: 4408
  })
  const line1 = randomUUID()
  const line2 = randomUUID()
  await db('order_lines').insert([
    { id: line1, order_id: orderId, position: 1, sku: SKU.MAG, qty: 2, unit_price_cents: 2999, unit_cogs_cents: 1450, line_total_cents: 5998, line_cogs_cents: 2900, line_fee_cents: 45, line_margin_cents: 3053 },
    { id: line2, order_id: orderId, position: 2, sku: SKU.VITD, qty: 1, unit_price_cents: 2499, unit_cogs_cents: 1125, line_total_cents: 2499, line_cogs_cents: 1125, line_fee_cents: 19, line_margin_cents: 1355 }
  ])
  await db('payments').insert({ order_id: orderId, idempotency_key: randomUUID(), gateway_ref: 'stub_backdated', amount_cents: 8497, created_at: postedAt })
  const journalId = randomUUID()
  await db('journals').insert({ id: journalId, order_id: orderId, type: 'PAYMENT', ref_id: null, posted_at: postedAt, is_synthetic: false })
  const base = { journal_id: journalId, order_id: orderId, provider_id: world.providerId, practice_id: world.practiceId, memo: null, is_synthetic: false }
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

describe('reports / payables (golden)', () => {
  evalCase('EVAL-09b', 'provider payables: credits 7090, debits 4472, closing 2618', async () => {
    const world = await makeWorld()
    const refunded = await payNewOrder(world, EVAL01) // PROVIDER_PAYABLE -4408 (credit)
    await payNewOrder(world, EVAL02) // PROVIDER_PAYABLE -2682 (credit)
    // Refund EVAL-01 through the REAL T5 route: +4408 margin_reversal +64 fee_retention.
    expect((await refundViaAdmin(refunded)).status).toBe(200)

    const res = await asUser(world.userId).get('/api/reports/payables')
    expect(res.status).toBe(200)
    // EVAL-09b exact expected values (docs/EVALS.md).
    expect(res.body.openingCents).toBe(0)
    expect(res.body.creditsCents).toBe(7090) // 4408 + 2682 margins earned
    expect(res.body.debitsCents).toBe(4472) // 4408 margin reversal + 64 fee retention
    expect(res.body.closingCents).toBe(2618) // 7090 - 4472

    // ADR-012 cross-check: the refunded order nets to -(fee) = -64 for the provider.
    const row = res.body.contributingOrders.find((o: { orderId: string }) => o.orderId === refunded)
    expect(row).toMatchObject({ creditsCents: 4408, debitsCents: 4472, netCents: -64 })
  })

  evalCase('EVAL-10', 'late refund of a closed-month order: M statement frozen; current period debits 4472, closing -64', async () => {
    const world = await makeWorld()

    // Find a far-past month with no existing statement (robust against local re-runs on a
    // persistent DB; in CI the DB is fresh so the first pick always closes).
    let month = ''
    let periodStart = ''
    let closeBody: { statements: Array<{ providerId: string; creditsCents: number; debitsCents: number; closingCents: number }> } | null = null
    for (let attempt = 0; attempt < 8 && !closeBody; attempt++) {
      const year = 1000 + Math.floor(Math.random() * 800)
      month = `${year}-06`
      periodStart = `${year}-06-01`
      await insertBackdatedPaidEval01(world, new Date(Date.UTC(year, 5, 10))) // inside month M
      const close = await asUser(ADMIN).post('/api/admin/payables/close').send({ month })
      if (close.status === 201) closeBody = close.body
      else expect(close.body.error.code).toBe('ALREADY_CLOSED') // collided with a prior run; retry
    }
    expect(closeBody, 'closed a fresh far-past month within 8 attempts').toBeTruthy()

    // Month M captures the 4408 credit, nothing else.
    const mStmt = closeBody!.statements.find((s) => s.providerId === world.providerId)
    expect(mStmt).toMatchObject({ creditsCents: 4408, debitsCents: 0, closingCents: 4408 })

    // Refund through the REAL route; the REFUND journal posts at now() = current period.
    const backdatedOrder = (await db('orders').where({ provider_id: world.providerId, status: 'paid' }).orderBy('created_at').first()).id
    expect((await refundViaAdmin(backdatedOrder)).status).toBe(200)

    // ADR-014: the CLOSED month-M statement is NEVER rewritten - still credits-only.
    const view = await asUser(ADMIN).get(`/api/admin/payables?month=${month}`)
    expect(view.status).toBe(200)
    expect(view.body.closed).toBe(true)
    const stored = view.body.statements.find((s: { providerId: string }) => s.providerId === world.providerId)
    expect(stored).toMatchObject({ periodStart, creditsCents: 4408, debitsCents: 0, closingCents: 4408 })

    // EVAL-10: the current (open) period shows the refund as a debit = margin + fee, with
    // the closed month's balance carried forward as opening.
    const current = await asUser(world.userId).get('/api/reports/payables')
    expect(current.status).toBe(200)
    expect(current.body.openingCents).toBe(4408) // carried forward from closed month M
    expect(current.body.creditsCents).toBe(0)
    expect(current.body.debitsCents).toBe(4472) // 4408 margin reversal + 64 fee retention
    expect(current.body.closingCents).toBe(-64) // provider eats the retained fee (ADR-012)
  })
})
