// Baseline import (CSV) and synthetic baseline regeneration (T10) - FR-14 AC1/AC2,
// ADR-018. Baseline rows are the historical marketplace volume migration % is measured
// against.
//
// CSV TRANSPORT: the raw CSV text arrives as a JSON string field (no multipart/multer,
// no new dependency - AGENTS.md section 10, and app.ts/T0 wires only express.json()).
// Validation is identical to what an uploaded file would get: every row is checked and
// bad rows are reported, never inserted (RT-12). The parser is deliberately simple (no
// quoted-field / embedded-comma support); that limitation is documented in the MR.
//
// SAFETY (RT-12): every DB access is a parameterized Knex query. A malicious cell value
// is either rejected by validation (gmv_cents, order_date, provider_email) or stored as
// plain text via a bound parameter (source_marketplace) - never concatenated into SQL.
import type { Knex } from 'knex'
import type { BaselineImportResult, BaselineImportRejectedRow, BaselineRegenerateResult } from '@cerbo/contracts'
import { invalidInput } from '../errors'
import { makeRng } from './rng'

const EXPECTED_HEADER = ['provider_email', 'order_date', 'gmv_cents', 'source']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const GMV_RE = /^\d{1,12}$/ // positive integer cents, bounded length (safe integer)
const SOURCE_MAX = 120

interface ParsedRow {
  row: number
  raw: string
  providerEmail: string
  orderDate: string
  gmvCents: number
  source: string
}

/** True if the date is a real calendar date (rejects 2026-02-31 etc.). */
function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * Import a CSV of historical marketplace orders (FR-14 AC1). Header must be exactly
 * `provider_email,order_date,gmv_cents,source`. Each data row is validated; valid rows
 * are inserted under one import_batch_id (source 'csv', is_synthetic false), invalid
 * rows are returned with a reason and NOT inserted (RT-12).
 */
export async function importBaselineCsv(db: Knex, csvText: unknown): Promise<BaselineImportResult> {
  if (typeof csvText !== 'string' || csvText.trim() === '') {
    throw invalidInput('csv must be a non-empty string', { field: 'csv' })
  }

  const lines = csvText.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) throw invalidInput('csv has no rows', { field: 'csv' })

  const header = (lines[0] as string).split(',').map((h) => h.trim().toLowerCase())
  if (header.length !== EXPECTED_HEADER.length || !EXPECTED_HEADER.every((h, i) => header[i] === h)) {
    throw invalidInput(`csv header must be: ${EXPECTED_HEADER.join(',')}`, { header })
  }

  const rejected: BaselineImportRejectedRow[] = []
  const valid: ParsedRow[] = []

  // Resolve emails to providers once (parameterized). Unknown emails reject their rows.
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i] as string
    const rowNum = i + 1 // 1-based incl. header, so the human row number
    const cols = raw.split(',').map((c) => c.trim())
    if (cols.length !== EXPECTED_HEADER.length) {
      rejected.push({ row: rowNum, raw, reason: `expected ${EXPECTED_HEADER.length} columns, got ${cols.length}` })
      continue
    }
    const [providerEmail, orderDate, gmvRaw, source] = cols as [string, string, string, string]
    if (!providerEmail || providerEmail.length > 200) {
      rejected.push({ row: rowNum, raw, reason: 'provider_email is missing or too long' })
      continue
    }
    if (!isValidDate(orderDate)) {
      rejected.push({ row: rowNum, raw, reason: 'order_date must be a valid YYYY-MM-DD date' })
      continue
    }
    if (!GMV_RE.test(gmvRaw) || Number(gmvRaw) <= 0 || !Number.isSafeInteger(Number(gmvRaw))) {
      rejected.push({ row: rowNum, raw, reason: 'gmv_cents must be a positive integer' })
      continue
    }
    if (!source || source.length > SOURCE_MAX) {
      rejected.push({ row: rowNum, raw, reason: 'source is missing or too long' })
      continue
    }
    valid.push({ row: rowNum, raw, providerEmail, orderDate, gmvCents: Number(gmvRaw), source })
  }

  if (valid.length === 0) {
    return { importBatchId: '', insertedCount: 0, rejected }
  }

  // Resolve provider emails (parameterized whereIn). Rows for unknown emails are rejected.
  const emails = [...new Set(valid.map((v) => v.providerEmail))]
  const providers = await db('providers')
    .whereIn('email', emails)
    .select('id', 'practice_id', 'email')
  const byEmail = new Map<string, { id: string; practice_id: string }>(
    providers.map((p: { id: string; practice_id: string; email: string }) => [p.email, { id: p.id, practice_id: p.practice_id }])
  )

  const toInsert: Array<ParsedRow & { providerId: string; practiceId: string }> = []
  for (const v of valid) {
    const provider = byEmail.get(v.providerEmail)
    if (!provider) {
      rejected.push({ row: v.row, raw: v.raw, reason: `no provider with email ${v.providerEmail}` })
      continue
    }
    toInsert.push({ ...v, providerId: provider.id, practiceId: provider.practice_id })
  }

  rejected.sort((a, b) => a.row - b.row)

  if (toInsert.length === 0) {
    return { importBatchId: '', insertedCount: 0, rejected }
  }

  return db.transaction(async (trx) => {
    const [batch] = await trx('baseline_imports')
      .insert({ source: 'csv', seed: null, months: null, row_count: toInsert.length })
      .returning<{ id: string }[]>('id')
    const importBatchId = batch.id
    await trx('baseline_orders').insert(
      toInsert.map((r) => ({
        import_batch_id: importBatchId,
        provider_id: r.providerId,
        practice_id: r.practiceId,
        source_marketplace: r.source,
        order_date: r.orderDate,
        gmv_cents: r.gmvCents,
        is_synthetic: false
      }))
    )
    return { importBatchId, insertedCount: toInsert.length, rejected }
  })
}

const SYNTHETIC_MARKETPLACES = ['Fullscript', 'Wellevate', 'Emerson']

/**
 * Regenerate the synthetic baseline (FR-14 AC2): remove the PREVIOUS synthetic baseline
 * (replace, not append) and generate `months` months (default 6) of synthetic historical
 * marketplace GMV per provider, seeded for reproducibility. Real (CSV) baseline rows are
 * never touched. All rows are flagged is_synthetic.
 */
export async function regenerateSyntheticBaseline(
  db: Knex,
  seed: number,
  months: number
): Promise<BaselineRegenerateResult> {
  const rng = makeRng(seed)
  const providers = await db('providers').select('id', 'practice_id').orderBy('id')
  const now = new Date()

  return db.transaction(async (trx) => {
    // Replace: drop prior synthetic baseline rows + their synthetic import batches.
    const replacedCount = await trx('baseline_orders').where('is_synthetic', true).del()
    await trx('baseline_imports').where('source', 'synthetic').del()

    const rows: Array<Record<string, unknown>> = []
    for (const p of providers as Array<{ id: string; practice_id: string }>) {
      // A provider-specific base monthly volume so providers differ in the demo.
      const baseMonthly = rng.int(80_000, 250_000) // $800 - $2,500 in cents
      for (let m = 1; m <= months; m++) {
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 15))
        const orderDate = monthStart.toISOString().slice(0, 10)
        // A couple of marketplace orders per month, summing near baseMonthly.
        const perMonthOrders = rng.int(2, 4)
        for (let o = 0; o < perMonthOrders; o++) {
          const gmv = Math.max(1, Math.floor(baseMonthly / perMonthOrders) + rng.int(-5_000, 5_000))
          rows.push({
            provider_id: p.id,
            practice_id: p.practice_id,
            source_marketplace: rng.pick(SYNTHETIC_MARKETPLACES),
            order_date: orderDate,
            gmv_cents: gmv,
            is_synthetic: true
          })
        }
      }
    }

    const [batch] = await trx('baseline_imports')
      .insert({ source: 'synthetic', seed, months, row_count: rows.length })
      .returning<{ id: string }[]>('id')
    const importBatchId = batch.id
    if (rows.length > 0) {
      await trx('baseline_orders').insert(rows.map((r) => ({ ...r, import_batch_id: importBatchId })))
    }
    return { importBatchId, seed, months, insertedCount: rows.length, replacedCount }
  })
}
