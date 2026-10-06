// T4 ledger-invariant tests (GATE G3). These are the proofs a human reviews at G3:
// the per-line PAYMENT posting function, the transaction boundary, and the DB-enforced
// journal-balance invariant.
//
// PROTECTED PATH: apps/api/test/invariants/** is protected (AGENTS.md section 4). T4 is
// explicitly assigned ledger.*.test.ts here (docs/TASKS.md T4 "Owns"), so this file is
// authorized - but the ai03-protected CI job WILL go red on the MR until the project
// owner applies the `approved-protected-change` label at G3. That is EXPECTED. The
// build-test job (needs: []) still runs these tests regardless.
//
// Runs against real Postgres (DATABASE_URL) so the deferred constraint trigger T2
// installed actually executes (AI-08: never mock the DB in invariant tests). Migrations
// are applied via the tsx CLI in beforeAll (knex raw-requires .ts migrations outside
// vite's transform). Fixtures use random UUIDs and a dedicated product, so this suite
// never races the seed-SKU suites.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../src/db/knex'
import { seedCore } from '../../src/db/seeds/01_core'
import { postPaymentJournal } from '../../src/ledger'

const apiRoot = path.resolve(__dirname, '../..')
function migrateViaCli(): void {
  execFileSync('npm', ['run', 'db:migrate'], {
    cwd: apiRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
}

// Isolated fixtures (fresh ids per run).
const practiceId = randomUUID()
const providerId = randomUUID()
const patientId = randomUUID()
const orderId = randomUUID()
const magLineId = randomUUID()
const vitdLineId = randomUUID()
// Reference the seed SKUs read-only (for order_lines/ledger_entries FK). This suite never
// mutates product stock, so using the shared catalog adds no new products (keeping the
// protected db.invariants "exactly 5 products" assertion true) and races nothing.
const SKU_MAG = 'MAG-GLY-120'
const SKU_VITD = 'VITD3-K2'

// The EVAL-01 split, persisted as it would be after send. Order totals and each line
// satisfy total = cogs + fee + margin (the DB check constraint would reject otherwise).
const posting = {
  order: { id: orderId, providerId, practiceId, isSynthetic: true },
  lines: [
    { id: magLineId, lineTotalCents: 5998, lineCogsCents: 2900, lineFeeCents: 45, lineMarginCents: 3053 },
    { id: vitdLineId, lineTotalCents: 2499, lineCogsCents: 1125, lineFeeCents: 19, lineMarginCents: 1355 }
  ]
}

beforeAll(async () => {
  migrateViaCli()
  await seedCore(db) // ensure the seed SKUs the fixtures reference exist (idempotent)
  await db('practices').insert({ id: practiceId, name: 'Ledger Test Practice' })
  await db('providers').insert({ id: providerId, practice_id: practiceId, name: 'Ledger Provider', email: `ledg-${providerId}@example.com` })
  await db('patients').insert({ id: patientId, practice_id: practiceId, name: 'Ledger Patient', email: `ledg-${patientId}@example.com` })
  await db('orders').insert({
    id: orderId,
    provider_id: providerId,
    practice_id: practiceId,
    patient_id: patientId,
    kind: 'one_off',
    status: 'paid',
    is_synthetic: true,
    subtotal_cents: 8497,
    cogs_cents: 4025,
    fee_cents: 64,
    margin_cents: 4408
  })
  await db('order_lines').insert([
    { id: magLineId, order_id: orderId, position: 1, sku: SKU_MAG, qty: 2, unit_price_cents: 2999, unit_cogs_cents: 1450, line_total_cents: 5998, line_cogs_cents: 2900, line_fee_cents: 45, line_margin_cents: 3053 },
    { id: vitdLineId, order_id: orderId, position: 2, sku: SKU_VITD, qty: 1, unit_price_cents: 2499, unit_cogs_cents: 1125, line_total_cents: 2499, line_cogs_cents: 1125, line_fee_cents: 19, line_margin_cents: 1355 }
  ])
})

afterAll(async () => {
  await db.destroy()
})

describe('postPaymentJournal: per-line PAYMENT journal across the four accounts (FR-6 AC4)', () => {
  it('posts one balanced set of entries per line; every cent maps to a SKU; journal sums to zero', async () => {
    const paymentId = randomUUID()
    const journalId = await db.transaction((trx) => postPaymentJournal(trx, { ...posting, paymentId }))

    const journal = await db('journals').where({ id: journalId }).first()
    expect(journal.type).toBe('PAYMENT')
    expect(journal.ref_id).toBe(paymentId)

    const entries = await db('ledger_entries').where({ journal_id: journalId }).orderBy('id')
    // 2 lines x 4 accounts.
    expect(entries).toHaveLength(8)

    // Every entry maps to a SKU line and carries provider/practice attribution.
    for (const e of entries) {
      expect([magLineId, vitdLineId]).toContain(e.line_id)
      expect(e.provider_id).toBe(providerId)
      expect(e.practice_id).toBe(practiceId)
    }

    // Per-line: the four entries for a line sum to zero (total - cogs - margin - fee).
    for (const lineId of [magLineId, vitdLineId]) {
      const lineEntries = entries.filter((e) => e.line_id === lineId)
      expect(lineEntries).toHaveLength(4)
      expect(lineEntries.reduce((a, e) => a + e.amount_cents, 0)).toBe(0)
    }

    // Account totals (EVAL-06b): debit positive, credits negative.
    const sumBy = (account: string) =>
      entries.filter((e) => e.account === account).reduce((a, e) => a + e.amount_cents, 0)
    expect(sumBy('CASH_CLEARING')).toBe(8497)
    expect(sumBy('COGS_RECOVERY')).toBe(-4025)
    expect(sumBy('PROVIDER_PAYABLE')).toBe(-4408)
    expect(sumBy('PLATFORM_FEE_REVENUE')).toBe(-64)

    // Whole journal sums to zero (money rule 7).
    expect(entries.reduce((a, e) => a + e.amount_cents, 0)).toBe(0)
  })
})

describe('deferred balance trigger rejects an unbalanced PAYMENT journal at COMMIT (money rule 7)', () => {
  it('an unbalanced set of PAYMENT entries aborts the commit and persists nothing', async () => {
    const journalId = randomUUID()
    await expect(
      db.transaction(async (trx) => {
        await trx('journals').insert({ id: journalId, order_id: orderId, type: 'PAYMENT', is_synthetic: true })
        // CASH is tampered to 5999 (should be 5998), so the journal sums to 1, not 0.
        await trx('ledger_entries').insert([
          { journal_id: journalId, order_id: orderId, line_id: magLineId, account: 'CASH_CLEARING', provider_id: providerId, practice_id: practiceId, amount_cents: 5999, is_synthetic: true },
          { journal_id: journalId, order_id: orderId, line_id: magLineId, account: 'COGS_RECOVERY', provider_id: providerId, practice_id: practiceId, amount_cents: -2900, is_synthetic: true },
          { journal_id: journalId, order_id: orderId, line_id: magLineId, account: 'PROVIDER_PAYABLE', provider_id: providerId, practice_id: practiceId, amount_cents: -3053, is_synthetic: true },
          { journal_id: journalId, order_id: orderId, line_id: magLineId, account: 'PLATFORM_FEE_REVENUE', provider_id: providerId, practice_id: practiceId, amount_cents: -45, is_synthetic: true }
        ])
      })
    ).rejects.toThrow(/balance/i)

    // The aborted commit rolled the whole transaction back.
    const count = await db('journals').where({ id: journalId }).then((r) => r.length)
    expect(count).toBe(0)
  })
})

describe('transaction boundary: postPaymentJournal uses the caller transaction', () => {
  it('rolls back with the surrounding transaction - no journal or entries persist', async () => {
    let journalId = ''
    await expect(
      db.transaction(async (trx) => {
        journalId = await postPaymentJournal(trx, { ...posting, paymentId: randomUUID() })
        // Abort AFTER posting but before commit: the posting must not have self-committed.
        throw new Error('force rollback')
      })
    ).rejects.toThrow('force rollback')

    expect(journalId).not.toBe('')
    expect(await db('journals').where({ id: journalId }).then((r) => r.length)).toBe(0)
    expect(await db('ledger_entries').where({ journal_id: journalId }).then((r) => r.length)).toBe(0)
  })
})

describe('idempotency guarded at the database layer (RT-04, no double charge)', () => {
  it('rejects a second payment for the same order and a reused idempotency key', async () => {
    const key = randomUUID()
    await db('payments').insert({ order_id: orderId, idempotency_key: key, amount_cents: 8497, is_synthetic: true })

    // Same order again -> payments.order_id is unique.
    await expect(
      db('payments').insert({ order_id: orderId, idempotency_key: randomUUID(), amount_cents: 8497, is_synthetic: true })
    ).rejects.toThrow()

    // Reused idempotency key on a different order -> idempotency_key is unique.
    const otherOrderId = randomUUID()
    await db('orders').insert({
      id: otherOrderId,
      provider_id: providerId,
      practice_id: practiceId,
      patient_id: patientId,
      kind: 'one_off',
      status: 'sent',
      is_synthetic: true
    })
    await expect(
      db('payments').insert({ order_id: otherOrderId, idempotency_key: key, amount_cents: 1, is_synthetic: true })
    ).rejects.toThrow()
  })
})
