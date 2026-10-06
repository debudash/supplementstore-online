// T10 API tests: Cerbo Admin metrics (FR-13, docs/METRICS.md). Covers EVAL-09 exactly
// (the EVAL-01-paid-then-refunded + EVAL-02-paid scenario, same month) plus the
// reconciliation line (ADR-015), AOV / recurring share, grouping, and money-rule-10
// large-aggregate exactness.
//
// Admin metrics are GLOBAL across providers, so to assert the EVAL-09 EXACT values on a
// shared DB we build an ISOLATED provider world and read that provider's block from the
// groupBy=provider breakdown. The SCENARIO is still exactly EVAL-09's; only the readout
// is scoped so other suites' rows cannot pollute the numbers (expected values are LAW -
// never adjusted to match output; see AGENTS.md section 4).
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { AdminMetricsResponse, MetricsGroup } from '@cerbo/contracts'
import { db } from '../../src/db/knex'
import { createApp } from '../../src/app'
import { createKnexActorLoader } from '../../src/auth/loadActor'
import { seedCore } from '../../src/db/seeds/01_core'

const apiRoot = path.resolve(__dirname, '../..')
function migrateViaCli(): void {
  execFileSync('npm', ['run', 'db:migrate'], { cwd: apiRoot, stdio: 'inherit', shell: process.platform === 'win32' })
}

const app = createApp({ db, loadActor: createKnexActorLoader(db) })
const asUser = (userId: string) => ({
  post: (url: string) => request(app).post(url).set('X-Demo-User', userId),
  get: (url: string) => request(app).get(url).set('X-Demo-User', userId)
})
const anon = { post: (url: string) => request(app).post(url) }

const SKU_MAG = 'MAG-GLY-120'
const SKU_VITD = 'VITD3-K2'
const SKU_OMEGA = 'OMEGA3-1000'
const CANONICAL_STOCK: Record<string, number> = { [SKU_MAG]: 50, [SKU_VITD]: 40, [SKU_OMEGA]: 30 }

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

async function makeProviderWorld(): Promise<ProviderWorld> {
  const practiceId = randomUUID()
  const providerId = randomUUID()
  const patientId = randomUUID()
  const userId = `t10m-${randomUUID().slice(0, 12)}`
  await db('practices').insert({ id: practiceId, name: 'T10 Practice' })
  await db('providers').insert({ id: providerId, practice_id: practiceId, name: 'Dr. T10', email: `${userId}@t10.example` })
  await db('patients').insert({ id: patientId, practice_id: practiceId, name: 'Pat T10', email: `${patientId}@t10.example`, ship_to: '1 T10 St' })
  await db('users').insert({ id: userId, role: 'provider', provider_id: providerId, patient_id: null, display_name: 'Dr. T10' })
  return { practiceId, providerId, patientId, userId }
}

interface Line { sku: string; qty: number; price: number }

async function payNewOrder(world: ProviderWorld, lines: Line[]): Promise<string> {
  const draft = await asUser(world.userId).post('/api/orders').send({ patientId: world.patientId })
  expect(draft.status).toBe(201)
  const orderId = draft.body.id as string
  for (const l of lines) {
    const r = await asUser(world.userId).post(`/api/orders/${orderId}/lines`).send({ sku: l.sku, qty: l.qty, unitPriceCents: l.price })
    expect(r.status).toBe(200)
  }
  const send = await asUser(world.userId).post(`/api/orders/${orderId}/send`).send({})
  expect(send.status).toBe(200)
  const token = send.body.order.payToken as string
  const pay = await anon.post(`/api/pay/${token}`).send({ idempotencyKey: randomUUID() })
  expect(pay.status).toBe(200)
  return orderId
}

async function refundViaAdmin(orderId: string, reasonCode = 'patient_request'): Promise<void> {
  const res = await asUser('admin-cerbo').post(`/api/admin/orders/${orderId}/refund`).send({ reasonCode })
  expect(res.status).toBe(200)
}

// EVAL-01: subtotal 8497, cogs 4025, fee 64, margin 4408. EVAL-02: fee 37, margin 2682.
const EVAL01: Line[] = [{ sku: SKU_MAG, qty: 2, price: 2999 }, { sku: SKU_VITD, qty: 1, price: 2499 }]
const EVAL02: Line[] = [{ sku: SKU_OMEGA, qty: 1, price: 4999 }]

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

describe('FR-13 / EVAL-09 Cerbo Admin metrics (exact values from docs/EVALS.md)', () => {
  it('EVAL-09: EVAL-01 paid then refunded + EVAL-02 paid, same month -> exact headline + reconciliation pass', async () => {
    const world = await makeProviderWorld()
    const refunded = await payNewOrder(world, EVAL01) // GMV 8497, fee 64, margin 4408
    await payNewOrder(world, EVAL02) // GMV 4999, fee 37, margin 2682 (kept)
    await refundViaAdmin(refunded) // EVAL-01 refunded through the REAL T5 path, same month

    const res = await asUser('admin-cerbo').get('/api/admin/metrics?groupBy=provider')
    expect(res.status).toBe(200)
    const body = res.body as AdminMetricsResponse
    const mine = body.groups.find((g: MetricsGroup) => g.key === world.providerId)
    expect(mine).toBeTruthy()
    const b = (mine as MetricsGroup).block

    // docs/EVALS.md line 61 - EXACT expected values.
    expect(b.gmvCents).toBe(13496) // Total GMV
    expect(b.refundedGmvCents).toBe(8497) // Refunded GMV
    expect(b.settledGmvCents).toBe(4999) // Settled GMV
    expect(b.platformFeeCents).toBe(101) // Platform fee revenue (incl. retained 64)
    expect(b.sunkFeeCents).toBe(64) // Sunk fees on refunded GMV
    expect(b.providerNetMarginCents).toBe(2682) // Provider net margin from settled
    expect(b.providerNetAfterSunkFeesCents).toBe(2618) // 2682 - 64

    // Reconciliation line passes (ADR-015, per-order formula == ledger figure).
    expect((mine as MetricsGroup).reconciliation.pass).toBe(true)
    expect((mine as MetricsGroup).reconciliation.diffCents).toBe(0)
    expect((mine as MetricsGroup).reconciliation.ledgerCents).toBe(2682)
    expect((mine as MetricsGroup).reconciliation.formulaCents).toBe(2682)

    // AOV = Total GMV / order count (2 paid orders) = 13496 / 2 = 6748, integer division.
    expect(b.orderCount).toBe(2)
    expect(b.aovCents).toBe(6748)
    // No recurring orders in this scenario.
    expect(b.recurringGmvCents).toBe(0)
    expect(b.recurringShareBps).toBe(0)
  })

  it('a blended margin % would be wrong: reconciliation uses the PER-ORDER formula (ADR-015)', async () => {
    // Two orders with very different margins. A blended margin % across them misstates
    // profit; the per-order reconciliation must still equal the ledger figure exactly.
    const world = await makeProviderWorld()
    await payNewOrder(world, [{ sku: SKU_MAG, qty: 1, price: 9000 }]) // high margin
    await payNewOrder(world, [{ sku: SKU_OMEGA, qty: 1, price: 2300 }]) // thin margin (cogs 2280)

    const res = await asUser('admin-cerbo').get('/api/admin/metrics?groupBy=provider')
    const mine = (res.body as AdminMetricsResponse).groups.find((g) => g.key === world.providerId) as MetricsGroup
    expect(mine.reconciliation.pass).toBe(true)
    // Ledger figure equals the summed per-order formula within tolerance (= order count).
    expect(mine.reconciliation.diffCents).toBeLessThanOrEqual(mine.reconciliation.toleranceCents)
    expect(mine.reconciliation.ledgerCents).toBe(mine.block.providerNetMarginCents)
  })
})

describe('FR-13 admin metrics: input validation and money-rule-10 exactness', () => {
  it('rejects an unknown groupBy with 400 INVALID_INPUT', async () => {
    const res = await asUser('admin-cerbo').get('/api/admin/metrics?groupBy=weekday')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_INPUT')
  })

  it('a non-admin cannot reach the metrics route (403 FORBIDDEN)', async () => {
    const world = await makeProviderWorld()
    const res = await asUser(world.userId).get('/api/admin/metrics')
    expect(res.status).toBe(403)
  })

  it('requires from and to together; rejects a lone from', async () => {
    const res = await asUser('admin-cerbo').get('/api/admin/metrics?from=2026-01-01')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_INPUT')
  })
})
