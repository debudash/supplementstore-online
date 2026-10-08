// T10 API tests: baseline import + demo data (FR-14). Covers EVAL-13 (synthetic toggle +
// reset lifecycle), EVAL-15 / RT-14 (DEMO_DISABLED gate), RT-12 (CSV injection / row-level
// validation), and - the highest-risk part of the task - ADVERSARIAL proof that the demo
// reset cannot destroy a real row (AGENTS.md money rule 6, ADR-019).
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { AdminMetricsResponse, BaselineImportResult } from '@cerbo/contracts'
import { db } from '../../src/db/knex'
import { createApp } from '../../src/app'
import { createKnexActorLoader } from '../../src/auth/loadActor'
import { seedCore } from '../../src/db/seeds/01_core'
import { resetDemoData } from '../../src/admin/demo/reset'
import { generateMigration } from '../../src/admin/demo/migration'
import { regenerateSyntheticBaseline } from '../../src/admin/demo/baseline'
import { markupFor } from '../pricing'

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
const admin = () => asUser('admin-cerbo')

const SKU_MAG = 'MAG-GLY-120'
const SKU_VITD = 'VITD3-K2'
const CANONICAL_STOCK: Record<string, number> = { [SKU_MAG]: 50, [SKU_VITD]: 40 }
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
  providerEmail: string
}
async function makeProviderWorld(): Promise<ProviderWorld> {
  const practiceId = randomUUID()
  const providerId = randomUUID()
  const patientId = randomUUID()
  const userId = `t10d-${randomUUID().slice(0, 12)}`
  const providerEmail = `${userId}@t10.example`
  await db('practices').insert({ id: practiceId, name: 'T10 Demo Practice' })
  await db('providers').insert({ id: providerId, practice_id: practiceId, name: 'Dr. T10D', email: providerEmail })
  await db('patients').insert({ id: patientId, practice_id: practiceId, name: 'Pat T10D', email: `${patientId}@t10.example`, ship_to: '1 T10 St' })
  await db('users').insert({ id: userId, role: 'provider', provider_id: providerId, patient_id: null, display_name: 'Dr. T10D' })
  return { practiceId, providerId, patientId, userId, providerEmail }
}

async function payNewOrder(world: ProviderWorld, lines: Array<{ sku: string; qty: number; price: number }>): Promise<string> {
  const draft = await asUser(world.userId).post('/api/orders').send({ patientId: world.patientId })
  const orderId = draft.body.id as string
  for (const l of lines) {
    await asUser(world.userId).post(`/api/orders/${orderId}/lines`).send({ sku: l.sku, qty: l.qty, markupCents: markupFor(l.sku, l.price) })
  }
  const send = await asUser(world.userId).post(`/api/orders/${orderId}/send`).send({})
  const token = send.body.order.payToken as string
  await anon.post(`/api/pay/${token}`).send({ idempotencyKey: randomUUID() })
  return orderId
}

/** Count synthetic rows across every table the reset is responsible for. */
async function syntheticCounts(): Promise<Record<string, number>> {
  const one = async (table: string, where: Record<string, unknown>): Promise<number> => {
    const r = await db(table).where(where).count<{ c: string }[]>({ c: '*' })
    return Number(r[0]?.c ?? 0)
  }
  return {
    ledgerEntries: await one('ledger_entries', { is_synthetic: true }),
    journals: await one('journals', { is_synthetic: true }),
    payments: await one('payments', { is_synthetic: true }),
    refunds: await one('refunds', { is_synthetic: true }),
    orders: await one('orders', { is_synthetic: true }),
    baselineOrders: await one('baseline_orders', { is_synthetic: true }),
    baselineImports: await one('baseline_imports', { source: 'synthetic' })
  }
}

beforeAll(async () => {
  migrateViaCli()
  await seedCore(db)
})
beforeEach(async () => {
  process.env.DEMO_MODE = 'true'
  await resetStock()
  // Start every case free of synthetic leftovers so generation counts and the
  // before/after comparisons are deterministic on the shared DB.
  await resetDemoData(db)
})
afterEach(() => {
  process.env.DEMO_MODE = 'true'
})
afterAll(async () => {
  await db.destroy()
})

describe('FR-14 AC5 / EVAL-15 / RT-14: demo endpoints gated by DEMO_MODE', () => {
  it('every /api/admin/demo/* route returns 403 DEMO_DISABLED when DEMO_MODE != true', async () => {
    process.env.DEMO_MODE = 'false'
    for (const url of ['/api/admin/demo/baseline/regenerate', '/api/admin/demo/migration/generate', '/api/admin/demo/reset']) {
      const res = await admin().post(url).send({})
      expect(res.status, url).toBe(403)
      expect(res.body.error.code, url).toBe('DEMO_DISABLED')
    }
  })

  it('the CSV baseline import is NOT demo-gated (real interim mechanism, ADR-018)', async () => {
    process.env.DEMO_MODE = 'false'
    const res = await admin().post('/api/admin/baseline/import').send({ csv: 'provider_email,order_date,gmv_cents,source\n' })
    // No data rows -> a normal (non-403) response; the gate never fired.
    expect(res.status).not.toBe(403)
  })
})

describe('FR-14 AC1 / RT-12: CSV baseline import with row-level validation', () => {
  it('validates each row, rejects bad/malicious rows, inserts only valid ones (RT-12)', async () => {
    const world = await makeProviderWorld()
    const csv = [
      'provider_email,order_date,gmv_cents,source',
      `${world.providerEmail},2026-01-15,50000,Fullscript`, // valid
      `${world.providerEmail},2026-02-15,"0); DROP TABLE orders;--",Fullscript`, // bad gmv (injection) -> reject
      `${world.providerEmail},2026-13-40,50000,Fullscript`, // impossible date -> reject
      `nobody@nowhere.example,2026-01-15,50000,Fullscript`, // unknown provider -> reject
      `${world.providerEmail},2026-03-15,42000,Wellevate'); DROP TABLE orders;--` // injection in source text -> stored as literal text
    ].join('\n')

    const res = await admin().post('/api/admin/baseline/import').send({ csv })
    expect(res.status).toBe(201)
    const body = res.body as BaselineImportResult
    expect(body.insertedCount).toBe(2) // the valid row + the one with injection ONLY in the free-text source
    expect(body.rejected).toHaveLength(3)
    expect(body.rejected.map((r) => r.row).sort()).toEqual([3, 4, 5])

    // RT-12: the injection never executed - the orders table still exists and is queryable,
    // and the malicious source value was stored verbatim as text (parameterized insert).
    const stored = await db('baseline_orders')
      .where({ import_batch_id: body.importBatchId })
      .orderBy('order_date')
      .select('gmv_cents', 'source_marketplace')
    expect(stored).toHaveLength(2)
    expect(stored[1].source_marketplace).toContain('DROP TABLE')
    // Sanity: orders table intact.
    await expect(db('orders').count('* as c')).resolves.toBeTruthy()
  })

  it('rejects a bad header', async () => {
    const res = await admin().post('/api/admin/baseline/import').send({ csv: 'wrong,header\n1,2' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_INPUT')
  })
})

describe('FR-14 AC2/AC3 / EVAL-13: synthetic baseline + migration, toggle, and reset', () => {
  it('EVAL-13: includeSynthetic=false is identical before/after generate; =true surfaces migration %; reset purges only synthetic', async () => {
    // A real paid order so there is real activity that must survive untouched.
    const world = await makeProviderWorld()
    await payNewOrder(world, [{ sku: SKU_MAG, qty: 1, price: 2999 }])

    const metricsReal = async (includeSynthetic: boolean): Promise<AdminMetricsResponse> => {
      const q = includeSynthetic ? '?includeSynthetic=true' : ''
      const res = await admin().get(`/api/admin/metrics${q}`)
      expect(res.status).toBe(200)
      return res.body as AdminMetricsResponse
    }

    // Baseline (includeSynthetic=false) snapshot BEFORE any synthetic data exists.
    const before = await metricsReal(false)

    // Generate synthetic baseline + migration (demo endpoints).
    const regen = await admin().post('/api/admin/demo/baseline/regenerate').send({ seed: 7, months: 2 })
    expect(regen.status).toBe(201)
    expect(regen.body.insertedCount).toBeGreaterThan(0)
    const mig = await admin().post('/api/admin/demo/migration/generate').send({ seed: 7, months: 2 })
    expect(mig.status).toBe(201)
    expect(mig.body.orderCount).toBeGreaterThan(0)
    expect(mig.body.gmvCents).toBeGreaterThan(0)

    // includeSynthetic=false must be IDENTICAL to before (synthetic excluded by default).
    const afterFalse = await metricsReal(false)
    expect(afterFalse.headline).toEqual(before.headline)
    expect(afterFalse.migration).toEqual(before.migration)

    // includeSynthetic=true surfaces migration %: providers with a baseline and a % present.
    const afterTrue = await metricsReal(true)
    expect(afterTrue.migration.providers.length).toBeGreaterThan(0)
    expect(afterTrue.migration.overallMigrationBps).not.toBeNull()
    expect(afterTrue.headline.gmvCents).toBeGreaterThan(afterFalse.headline.gmvCents)

    // Reset purges ALL synthetic rows.
    const reset = await admin().post('/api/admin/demo/reset').send({})
    expect(reset.status).toBe(200)
    const counts = await syntheticCounts()
    for (const [table, n] of Object.entries(counts)) {
      expect(n, `synthetic ${table} after reset`).toBe(0)
    }

    // Real rows are untouched: the default-false metrics are identical again.
    const afterReset = await metricsReal(false)
    expect(afterReset.headline).toEqual(before.headline)

    // The real order's ledger entries still exist.
    const realLedger = await db('ledger_entries')
      .join('orders', 'orders.id', 'ledger_entries.order_id')
      .where('orders.provider_id', world.providerId)
      .count<{ c: string }[]>({ c: '*' })
    expect(Number(realLedger[0]?.c ?? 0)).toBeGreaterThan(0)
  }, 120_000)

  it('regenerate REPLACES prior synthetic baseline (does not append)', async () => {
    await admin().post('/api/admin/demo/baseline/regenerate').send({ seed: 1, months: 2 })
    const firstCount = (await syntheticCounts()).baselineOrders
    expect(firstCount).toBeGreaterThan(0)
    const second = await admin().post('/api/admin/demo/baseline/regenerate').send({ seed: 1, months: 2 })
    expect(second.body.replacedCount).toBe(firstCount)
    // Same seed + months -> same synthetic baseline row count (deterministic, replaced).
    expect((await syntheticCounts()).baselineOrders).toBe(firstCount)
  }, 60_000)
})

describe('ADR-019 / money rule 6: the reset is the ONLY append-only exception - prove it holds', () => {
  it('a NON-synthetic ledger row cannot be deleted even with the purge flag set', async () => {
    const world = await makeProviderWorld()
    await payNewOrder(world, [{ sku: SKU_MAG, qty: 1, price: 2999 }])
    const realEntry = await db('ledger_entries')
      .join('orders', 'orders.id', 'ledger_entries.order_id')
      .where('orders.provider_id', world.providerId)
      .select('ledger_entries.id as id')
      .first()
    expect(realEntry).toBeTruthy()

    // Deliberately open the guarded gate and TRY to delete a real row: the T2 trigger
    // must still reject it because the row is not synthetic.
    await expect(
      db.transaction(async (trx) => {
        await trx.raw("set local app.allow_synthetic_purge = 'on'")
        await trx('ledger_entries').where({ id: (realEntry as { id: number }).id }).del()
      })
    ).rejects.toThrow()

    // The real row survived.
    const still = await db('ledger_entries').where({ id: (realEntry as { id: number }).id }).first()
    expect(still).toBeTruthy()
  }, 30_000)

  it('a synthetic ledger row cannot be deleted WITHOUT the session flag (flag is genuinely required)', async () => {
    await admin().post('/api/admin/demo/baseline/regenerate').send({ seed: 2, months: 1 })
    await admin().post('/api/admin/demo/migration/generate').send({ seed: 2, months: 1 })
    const synthEntry = await db('ledger_entries').where({ is_synthetic: true }).select('id').first()
    expect(synthEntry).toBeTruthy()

    // No flag set -> even a synthetic row is protected by the append-only trigger.
    await expect(
      db('ledger_entries').where({ id: (synthEntry as { id: number }).id }).del()
    ).rejects.toThrow()

    // With the real guarded path it IS removable.
    await resetDemoData(db)
    const gone = await db('ledger_entries').where({ id: (synthEntry as { id: number }).id }).first()
    expect(gone).toBeUndefined()
  }, 60_000)

  it('payable_statements are NEVER deletable - not even with the purge flag', async () => {
    // Close a far-past month for a backdated provider to produce a statement, then prove
    // the guarded gate still cannot delete it (the DELETE-always trigger has no synthetic
    // exception, and the table has no is_synthetic column).
    const world = await makeProviderWorld()
    const paidAt = new Date(Date.UTC(1300 + Math.floor(Math.random() * 500), 5, 15))
    const orderId = randomUUID()
    await db('orders').insert({
      id: orderId, provider_id: world.providerId, practice_id: world.practiceId, patient_id: world.patientId,
      kind: 'one_off', status: 'paid', paid_at: paidAt, created_at: paidAt,
      fee_bps: 75, subtotal_cents: 8497, cogs_cents: 4025, fee_cents: 64, margin_cents: 4408
    })
    const journalId = randomUUID()
    await db('journals').insert({ id: journalId, order_id: orderId, type: 'PAYMENT', ref_id: null, posted_at: paidAt, is_synthetic: false })
    const base = { journal_id: journalId, order_id: orderId, provider_id: world.providerId, practice_id: world.practiceId, memo: null, is_synthetic: false, line_id: null }
    await db('ledger_entries').insert([
      { ...base, account: 'CASH_CLEARING', amount_cents: 8497 },
      { ...base, account: 'COGS_RECOVERY', amount_cents: -4025 },
      { ...base, account: 'PROVIDER_PAYABLE', amount_cents: -4408 },
      { ...base, account: 'PLATFORM_FEE_REVENUE', amount_cents: -64 }
    ])
    const y = paidAt.getUTCFullYear()
    const close = await admin().post('/api/admin/payables/close').send({ month: `${y}-06` })
    expect(close.status).toBe(201)
    const stmt = await db('payable_statements').where({ provider_id: world.providerId }).first()
    expect(stmt).toBeTruthy()

    // Even with the purge gate open, the statement cannot be deleted.
    await expect(
      db.transaction(async (trx) => {
        await trx.raw("set local app.allow_synthetic_purge = 'on'")
        await trx('payable_statements').where({ id: (stmt as { id: string }).id }).del()
      })
    ).rejects.toThrow()

    // And the reset path never targets statements: it survives a reset too.
    await resetDemoData(db)
    const survived = await db('payable_statements').where({ id: (stmt as { id: string }).id }).first()
    expect(survived).toBeTruthy()
  }, 30_000)
})

describe('synthetic demo orders are dated in the past', () => {
  // Fixed clock: early on Oct 8 UTC (still Oct 7 in the Americas). The current month's
  // orders must land two days before today, never on today (which reads as the future).
  it.each([
    ['2026-10-08T03:00:00.000Z', '2026-10-06'],
    ['2026-10-20T03:00:00.000Z', '2026-10-15'],
    ['2026-10-01T03:00:00.000Z', '2026-09-29']
  ])('with now = %s the latest synthetic order is paid on %s', async (nowIso, expected) => {
    await resetDemoData(db)
    await regenerateSyntheticBaseline(db, 1, 2)
    await generateMigration(db, 2, 2, { now: () => new Date(nowIso) })
    const row = await db('orders').where({ is_synthetic: true }).max<{ latest: Date }[]>('paid_at as latest').first()
    const latest = new Date((row as { latest: Date }).latest)
    expect(latest.toISOString().slice(0, 10)).toBe(expected)
    expect(latest.getTime()).toBeLessThan(new Date(nowIso).getTime() - 24 * 60 * 60 * 1000)
    await resetDemoData(db)
  }, 30_000)
})

