// T2 database-invariant tests (GATE G2). These run against real Postgres via
// DATABASE_URL (CI provides a postgres:16 service; locally `docker compose up -d db`).
// They assert the "Database-level protections" from docs/ARCHITECTURE.md section 3:
// the products stock check, the deferred zero-sum journal trigger, the append-only
// UPDATE/DELETE guards, and the single guarded synthetic-purge path (ADR-019).
//
// Fixtures use random UUIDs and are intentionally NOT torn down: the append-only
// ledger tables cannot be deleted except through the synthetic-purge path, which is
// itself under test. CI runs against a fresh database each pipeline, so leftover
// synthetic fixtures are harmless.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../src/db/knex'
import { seedCore } from '../../src/db/seeds/01_core'

// Shared fixtures (a practice, provider, patient, and a draft order to hang journals on).
const practiceId = randomUUID()
const providerId = randomUUID()
const patientId = randomUUID()
const orderId = randomUUID()

async function makeOrder(isSynthetic = true): Promise<string> {
  const id = randomUUID()
  await db('orders').insert({
    id,
    provider_id: providerId,
    practice_id: practiceId,
    patient_id: patientId,
    kind: 'one_off',
    status: 'paid',
    is_synthetic: isSynthetic
  })
  return id
}

beforeAll(async () => {
  await db.migrate.latest()
  await db('practices').insert({ id: practiceId, name: 'Invariant Test Practice' })
  await db('providers').insert({
    id: providerId,
    practice_id: practiceId,
    name: 'Invariant Provider',
    email: `inv-${providerId}@example.com`
  })
  await db('patients').insert({
    id: patientId,
    practice_id: practiceId,
    name: 'Invariant Patient',
    email: `pat-${patientId}@example.com`
  })
  await db('orders').insert({
    id: orderId,
    provider_id: providerId,
    practice_id: practiceId,
    patient_id: patientId,
    kind: 'one_off',
    status: 'paid',
    is_synthetic: true
  })
})

afterAll(async () => {
  await db.destroy()
})

describe('products stock check constraint', () => {
  it('seedCore is idempotent (runs twice without error or duplication)', async () => {
    await seedCore(db)
    await seedCore(db)
    const [{ count }] = await db('products').count<{ count: string }[]>('* as count')
    expect(Number(count)).toBe(5)
    const mag = await db('products').where({ sku: 'MAG-GLY-120' }).first()
    expect(mag.unit_cogs_cents).toBe(1450)
    expect(mag.on_hand_qty).toBe(50)
  })

  it('rejects reserved_qty > on_hand_qty', async () => {
    await expect(
      db('products').insert({
        sku: `TEST-${randomUUID().slice(0, 8)}`,
        name: 'Over-reserved',
        unit_cogs_cents: 100,
        on_hand_qty: 5,
        reserved_qty: 6
      })
    ).rejects.toThrow()
  })

  it('rejects negative on_hand_qty', async () => {
    await expect(
      db('products').insert({
        sku: `TEST-${randomUUID().slice(0, 8)}`,
        name: 'Negative stock',
        unit_cogs_cents: 100,
        on_hand_qty: -1
      })
    ).rejects.toThrow()
  })

  it('rejects unit_cogs_cents <= 0', async () => {
    await expect(
      db('products').insert({
        sku: `TEST-${randomUUID().slice(0, 8)}`,
        name: 'Free',
        unit_cogs_cents: 0,
        on_hand_qty: 1
      })
    ).rejects.toThrow()
  })
})

describe('orders money check constraints', () => {
  it('rejects subtotal_cents != cogs + fee + margin', async () => {
    await expect(
      db('orders').insert({
        id: randomUUID(),
        provider_id: providerId,
        practice_id: practiceId,
        patient_id: patientId,
        kind: 'one_off',
        status: 'sent',
        subtotal_cents: 1000,
        cogs_cents: 500,
        fee_cents: 10,
        margin_cents: 400 // 500+10+400 = 910 != 1000
      })
    ).rejects.toThrow()
  })

  it('rejects negative margin_cents', async () => {
    await expect(
      db('orders').insert({
        id: randomUUID(),
        provider_id: providerId,
        practice_id: practiceId,
        patient_id: patientId,
        kind: 'one_off',
        status: 'sent',
        subtotal_cents: 500,
        cogs_cents: 510,
        fee_cents: 0,
        margin_cents: -10
      })
    ).rejects.toThrow()
  })
})

describe('deferred journal balance trigger (checked at COMMIT)', () => {
  it('accepts a balanced journal committed in one transaction', async () => {
    const journalId = randomUUID()
    await db.transaction(async (trx) => {
      await trx('journals').insert({ id: journalId, order_id: orderId, type: 'PAYMENT', is_synthetic: true })
      await trx('ledger_entries').insert([
        { journal_id: journalId, order_id: orderId, account: 'CASH_CLEARING', amount_cents: 100, is_synthetic: true },
        { journal_id: journalId, order_id: orderId, account: 'PROVIDER_PAYABLE', amount_cents: -100, is_synthetic: true }
      ])
    })
    const [{ count }] = await db('ledger_entries').where({ journal_id: journalId }).count<{ count: string }[]>('* as count')
    expect(Number(count)).toBe(2)
  })

  it('rejects an unbalanced journal at commit', async () => {
    const journalId = randomUUID()
    await expect(
      db.transaction(async (trx) => {
        await trx('journals').insert({ id: journalId, order_id: orderId, type: 'PAYMENT', is_synthetic: true })
        await trx('ledger_entries').insert([
          { journal_id: journalId, order_id: orderId, account: 'CASH_CLEARING', amount_cents: 100, is_synthetic: true },
          { journal_id: journalId, order_id: orderId, account: 'PROVIDER_PAYABLE', amount_cents: -99, is_synthetic: true }
        ])
      })
    ).rejects.toThrow(/balance/i)
    // Nothing persisted: the aborted commit rolled the whole transaction back.
    const [{ count }] = await db('journals').where({ id: journalId }).count<{ count: string }[]>('* as count')
    expect(Number(count)).toBe(0)
  })
})

describe('append-only UPDATE guard', () => {
  it('rejects UPDATE on journals', async () => {
    const id = randomUUID()
    await db('journals').insert({ id, order_id: orderId, type: 'PAYMENT', is_synthetic: true })
    await expect(db('journals').where({ id }).update({ type: 'REFUND' })).rejects.toThrow(/append-only/i)
  })

  it('rejects UPDATE on ledger_entries', async () => {
    const journalId = randomUUID()
    await db.transaction(async (trx) => {
      await trx('journals').insert({ id: journalId, order_id: orderId, type: 'PAYMENT', is_synthetic: true })
      await trx('ledger_entries').insert([
        { journal_id: journalId, order_id: orderId, account: 'CASH_CLEARING', amount_cents: 50, is_synthetic: true },
        { journal_id: journalId, order_id: orderId, account: 'PROVIDER_PAYABLE', amount_cents: -50, is_synthetic: true }
      ])
    })
    await expect(
      db('ledger_entries').where({ journal_id: journalId }).update({ amount_cents: 999 })
    ).rejects.toThrow(/append-only/i)
  })

  it('rejects UPDATE on payments', async () => {
    const order = await makeOrder()
    const id = randomUUID()
    await db('payments').insert({ id, order_id: order, idempotency_key: randomUUID(), amount_cents: 100, is_synthetic: true })
    await expect(db('payments').where({ id }).update({ amount_cents: 1 })).rejects.toThrow(/append-only/i)
  })
})

describe('append-only DELETE guard and synthetic purge path (ADR-019)', () => {
  it('rejects DELETE of a non-synthetic journal', async () => {
    const id = randomUUID()
    await db('journals').insert({ id, order_id: orderId, type: 'PAYMENT', is_synthetic: false })
    await expect(db('journals').where({ id }).del()).rejects.toThrow(/append-only/i)
  })

  it('rejects DELETE of a synthetic journal WITHOUT the purge flag', async () => {
    const id = randomUUID()
    await db('journals').insert({ id, order_id: orderId, type: 'PAYMENT', is_synthetic: true })
    await expect(db('journals').where({ id }).del()).rejects.toThrow(/append-only/i)
  })

  it('allows DELETE of synthetic ledger rows WITH the transaction-local purge flag', async () => {
    const journalId = randomUUID()
    await db.transaction(async (trx) => {
      await trx('journals').insert({ id: journalId, order_id: orderId, type: 'PAYMENT', is_synthetic: true })
      await trx('ledger_entries').insert([
        { journal_id: journalId, order_id: orderId, account: 'CASH_CLEARING', amount_cents: 70, is_synthetic: true },
        { journal_id: journalId, order_id: orderId, account: 'PROVIDER_PAYABLE', amount_cents: -70, is_synthetic: true }
      ])
    })

    await db.transaction(async (trx) => {
      await trx.raw("select set_config('app.allow_synthetic_purge', 'on', true)")
      await trx('ledger_entries').where({ journal_id: journalId }).del()
      await trx('journals').where({ id: journalId }).del()
    })

    const [{ count }] = await db('journals').where({ id: journalId }).count<{ count: string }[]>('* as count')
    expect(Number(count)).toBe(0)
  })

  it('still rejects purge of a NON-synthetic row even with the flag set', async () => {
    const id = randomUUID()
    await db('journals').insert({ id, order_id: orderId, type: 'PAYMENT', is_synthetic: false })
    await expect(
      db.transaction(async (trx) => {
        await trx.raw("select set_config('app.allow_synthetic_purge', 'on', true)")
        await trx('journals').where({ id }).del()
      })
    ).rejects.toThrow(/append-only/i)
  })
})

describe('payable_statements are never deletable (ADR-016)', () => {
  it('rejects DELETE even with the synthetic purge flag set', async () => {
    const id = randomUUID()
    await db('payable_statements').insert({
      id,
      provider_id: providerId,
      practice_id: practiceId,
      period_start: '2026-01-01',
      period_end: '2026-01-31',
      opening_cents: 0,
      credits_cents: 100,
      debits_cents: 0,
      closing_cents: 100
    })
    await expect(
      db.transaction(async (trx) => {
        await trx.raw("select set_config('app.allow_synthetic_purge', 'on', true)")
        await trx('payable_statements').where({ id }).del()
      })
    ).rejects.toThrow(/append-only/i)
    await expect(db('payable_statements').where({ id }).update({ credits_cents: 1 })).rejects.toThrow(/append-only/i)
  })
})
