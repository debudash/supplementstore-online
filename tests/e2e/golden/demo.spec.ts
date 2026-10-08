// EVAL-09, EVAL-13, EVAL-15 and RT-14: Cerbo Admin metrics, synthetic demo data, and the
// DEMO_MODE guard (FR-13/14, ADR-015/018/019), driven over the real merged T10 routes:
//   GET  /api/admin/metrics
//   POST /api/admin/demo/baseline/regenerate | /demo/migration/generate | /demo/reset
// This suite is the INDEPENDENT check on T10. Expected values are verbatim from
// docs/EVALS.md / docs/METRICS.md; a disagreement with T10 is a finding, not something to
// reconcile. The demo guard reads process.env.DEMO_MODE per request, so each case toggles
// it and restores it in a finally.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect } from 'vitest'
import {
  asUser,
  db,
  evalCase,
  makeProviderWorld,
  payNewOrderAs,
  refundAsAdmin,
  resetState,
  ADMIN,
  SKU,
  type Line
} from './_harness'

beforeEach(async () => {
  await resetState()
})
afterAll(async () => {
  await db.destroy()
})

const EVAL01: Line[] = [
  { sku: SKU.MAG, qty: 2, price: 2999 },
  { sku: SKU.VITD, qty: 1, price: 2500 } // markup 1356: with MAG x2 the order rounds once to 8497 (EVAL-01)
]
const EVAL02: Line[] = [{ sku: SKU.OMEGA, qty: 1, price: 4999 }]

/** The current UTC month as a [from, to] window (metrics basis is orders.paid_at). */
function currentMonthWindow(): { from: string; to: string } {
  const now = new Date()
  const y = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const lastDay = new Date(Date.UTC(y, now.getUTCMonth() + 1, 0)).getUTCDate()
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(lastDay).padStart(2, '0')}` }
}

async function count(table: string, where: Record<string, unknown>): Promise<number> {
  const [{ c }] = await db(table).where(where).count<{ c: string }[]>('* as c')
  return Number(c)
}

function withDemoMode<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DEMO_MODE
  if (value === undefined) delete process.env.DEMO_MODE
  else process.env.DEMO_MODE = value
  const restore = () => {
    if (prev === undefined) delete process.env.DEMO_MODE
    else process.env.DEMO_MODE = prev
  }
  return fn().then(
    (r) => {
      restore()
      return r
    },
    (e) => {
      restore()
      throw e
    }
  )
}

describe('admin metrics + demo data (golden)', () => {
  evalCase('EVAL-09', 'metrics reconciliation: GMV 13496, refunded 8497, settled 4999, fees 102/64, net 2681/2617', async () => {
    // Metrics are GLOBAL, so isolate on a fresh provider and read its groupBy=provider block.
    const { from, to } = currentMonthWindow()
    const world = await makeProviderWorld('t13m')
    const refunded = await payNewOrderAs(world, EVAL01) // GMV 8497, fee 64, margin 4408
    expect((await refundAsAdmin(refunded)).status).toBe(200) // refund EVAL-01
    await payNewOrderAs(world, EVAL02) // GMV 4999, fee 38, margin 2681 (kept)

    const res = await asUser(ADMIN).get('/api/admin/metrics').query({ from, to, groupBy: 'provider' })
    expect(res.status).toBe(200)
    expect(res.body.includeSynthetic).toBe(false) // synthetic off by default (FR-13 AC3)

    const group = res.body.groups.find((g: { key: string }) => g.key === world.providerId)
    expect(group, 'this provider has a metrics group').toBeTruthy()
    const b = group.block
    // EVAL-09 exact figures (docs/EVALS.md).
    expect(b.gmvCents).toBe(13496)
    expect(b.refundedGmvCents).toBe(8497)
    expect(b.settledGmvCents).toBe(4999)
    expect(b.platformFeeCents).toBe(102) // 64 + 38 fee revenue (ADR-028: fee rounds up)
    expect(b.sunkFeeCents).toBe(64) // fee retained on the refunded order
    expect(b.providerNetMarginCents).toBe(2681) // only the settled (EVAL-02) order
    expect(b.providerNetAfterSunkFeesCents).toBe(2617) // 2681 - 64
    // Reconciliation (owner's per-order formula vs the ledger) passes.
    expect(group.reconciliation.pass).toBe(true)
  })

  evalCase('EVAL-13', 'synthetic data excluded by default; migration % with synthetic; reset purges, real survives', async () => {
    await withDemoMode('true', async () => {
      const wide = { from: '2000-01-01', to: '2999-12-31' }
      // Clean slate (clear any synthetic left by a prior local run).
      expect((await asUser(ADMIN).post('/api/admin/demo/reset').send({})).status).toBe(200)

      // Baseline (synthetic off): the real-metrics snapshot that must not move.
      const before = (await asUser(ADMIN).get('/api/admin/metrics').query({ ...wide, includeSynthetic: 'false' })).body
      const realJournalsBefore = await count('journals', { is_synthetic: false })

      // Generate synthetic baseline + in-house migration activity (through the real split
      // + posting code, flagged is_synthetic, no inventory effect - ADR-019).
      const baseline = await asUser(ADMIN).post('/api/admin/demo/baseline/regenerate').send({ seed: 2024, months: 6 })
      expect(baseline.status).toBe(201)
      expect(baseline.body.insertedCount).toBeGreaterThan(0)
      const mig = await asUser(ADMIN).post('/api/admin/demo/migration/generate').send({ seed: 7, months: 3 })
      expect(mig.status).toBe(201)
      expect(mig.body.orderCount).toBeGreaterThan(0)
      expect(await count('journals', { is_synthetic: true })).toBeGreaterThan(0)

      // includeSynthetic=false is IDENTICAL to before: synthetic never pollutes real metrics.
      const after = (await asUser(ADMIN).get('/api/admin/metrics').query({ ...wide, includeSynthetic: 'false' })).body
      expect(after.headline).toEqual(before.headline)

      // includeSynthetic=true surfaces the synthetic volume: migration % present, GMV higher.
      const withSynth = (await asUser(ADMIN).get('/api/admin/metrics').query({ ...wide, includeSynthetic: 'true' })).body
      expect(withSynth.migration.overallMigrationBps).not.toBeNull()
      expect(withSynth.headline.gmvCents).toBeGreaterThan(after.headline.gmvCents)

      // Reset purges ALL synthetic rows through the single guarded path; REAL rows survive.
      const reset = await asUser(ADMIN).post('/api/admin/demo/reset').send({})
      expect(reset.status).toBe(200)
      expect(await count('journals', { is_synthetic: true })).toBe(0)
      expect(await count('orders', { is_synthetic: true })).toBe(0)
      expect(await count('payments', { is_synthetic: true })).toBe(0)
      expect(await count('baseline_orders', { is_synthetic: true })).toBe(0)
      // The non-synthetic ledger is untouched by the purge (append-only honored).
      expect(await count('journals', { is_synthetic: false })).toBe(realJournalsBefore)
    })
  }, 120_000)

  evalCase('EVAL-15', 'DEMO_MODE=false -> every /api/admin/demo/* returns 403 DEMO_DISABLED', async () => {
    await withDemoMode('false', async () => {
      const calls = [
        asUser(ADMIN).post('/api/admin/demo/reset').send({}),
        asUser(ADMIN).post('/api/admin/demo/baseline/regenerate').send({ seed: 1, months: 1 }),
        asUser(ADMIN).post('/api/admin/demo/migration/generate').send({ seed: 1, months: 1 })
      ]
      for (const call of calls) {
        const res = await call
        expect(res.status).toBe(403)
        expect(res.body.error.code).toBe('DEMO_DISABLED')
      }
    })
  })

  evalCase('RT-14', 'demo endpoints refused in production mode; no data purged; statements never deletable', async () => {
    // A REAL paid order + journal that a purge must never touch.
    const world = await makeProviderWorld('t13rt14')
    const realOrder = await payNewOrderAs(world, [{ sku: SKU.OMEGA, qty: 1, price: 4999 }])
    const realJournal = await db('journals').where({ order_id: realOrder, type: 'PAYMENT' }).first()
    expect(realJournal).toBeTruthy()

    // Attack: in production mode (DEMO_MODE not true), fire the destructive reset and the
    // generators. All must be refused BEFORE touching any data.
    await withDemoMode('false', async () => {
      for (const call of [
        asUser(ADMIN).post('/api/admin/demo/reset').send({}),
        asUser(ADMIN).post('/api/admin/demo/baseline/regenerate').send({ seed: 1, months: 1 }),
        asUser(ADMIN).post('/api/admin/demo/migration/generate').send({ seed: 1, months: 1 })
      ]) {
        const res = await call
        expect(res.status).toBe(403)
        expect(res.body.error.code).toBe('DEMO_DISABLED')
      }
    })
    // Nothing was purged: the real journal still exists.
    expect(await db('journals').where({ id: realJournal.id }).first()).toBeTruthy()

    // Adversarial DB-guard proof: a payable_statement is NEVER deletable, even with the
    // synthetic-purge flag deliberately set (the reset's one exception never reaches it).
    const stmtId = randomUUID()
    await db('payable_statements').insert({
      id: stmtId,
      provider_id: world.providerId,
      practice_id: world.practiceId,
      period_start: '3000-01-01',
      period_end: '3000-01-31',
      opening_cents: 0,
      credits_cents: 0,
      debits_cents: 0,
      closing_cents: 0
    })
    await expect(
      db.transaction(async (trx) => {
        await trx.raw("select set_config('app.allow_synthetic_purge', 'on', true)")
        await trx('payable_statements').where({ id: stmtId }).del()
      })
    ).rejects.toThrow()
  })
})
