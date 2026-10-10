// T13 result reporter: the id-by-id pass report the acceptance criterion requires.
//
// Every EVAL and RT-A id from docs/EVALS.md and docs/RED_TEAM.md is listed in the
// MANIFEST below with its implementing task and current plan (live now, pending a
// not-yet-merged task, or cut from scope). Specs call recordResult(id, status) as they
// run; the global teardown (golden/global-setup.ts) merges those actual outcomes over
// the manifest and prints/writes a legible summary a human can read at a glance.
//
// This file is intentionally the single source of truth for "which ids exist and what
// is expected of each" so that cut and pending ids are reported explicitly rather than
// silently omitted (T13 brief + AGENTS.md section 9).
import fs from 'node:fs'
import path from 'node:path'

export type Status = 'pass' | 'fail' | 'pending' | 'cut' | 'not-run'

/** Where specs append their per-id results (one JSON object per line). */
export const RESULTS_FILE = path.resolve(__dirname, '..', '.results.ndjson')

export interface ManifestEntry {
  id: string
  area: string
  summary: string
  /** Who implements the product behaviour this id exercises. */
  task: string
  /**
   * live       - product code is merged; the spec runs and asserts now.
   * pending:Tn - behaviour arrives with task Tn; the spec is written and auto-enables
   *              (it probes the route and records pass once the route is real).
   * cut:Tn     - task Tn is cut from scope; the id cannot pass and is reported as such.
   */
  plan: 'live' | 'pending:T5' | 'pending:T8' | 'cut:T9' | 'cut:T10' | 'cut:T11'
  note?: string
}

// ---------------------------------------------------------------------------
// The complete id manifest. Order mirrors docs/EVALS.md then docs/RED_TEAM.md.
// ---------------------------------------------------------------------------
export const MANIFEST: ManifestEntry[] = [
  // Money core (T1, merged) - exercised at the API quote/add level end to end.
  { id: 'EVAL-01', area: 'money', task: 'T1/T3', plan: 'live', summary: 'MAG x2 markup 1526 + VITD3 x1 markup 1356, priced once -> subtotal 8497, fee 64, line fees [45,19], margins [3052,1356] (exactly the markups)' },
  { id: 'EVAL-02', area: 'money', task: 'T1/T3', plan: 'live', summary: 'OMEGA3 x1@4999 -> fee 38 (37.49 rounded up, ADR-028), margin 2681' },
  { id: 'EVAL-03', area: 'money', task: 'T1/T3', plan: 'live', summary: 'VITD3 x1@2200 -> fee 17 (16.5 rounded up), margin 1058' },
  { id: 'EVAL-04', area: 'money', task: 'T1/T3', plan: 'live', summary: 'VITD3 margin floor: markup 0 -> price 1134 (cost + fee), margin exactly 0 (split floor still rejects @1125/@1133, accepts @1134)' },
  { id: 'EVAL-04b', area: 'money', task: 'T1/T3', plan: 'live', summary: 'MAG markup 1000 -> unit price 2469, fee 19, margin 1000 (ADR-028)' },
  { id: 'EVAL-P1', area: 'money', task: 'T1/T3', plan: 'live', summary: 'Property: line fees sum to order fee; cogs+fee+margin=total; fee rounded up; deterministic (API-driven)' },

  // Inventory (T3, merged).
  { id: 'EVAL-05', area: 'inventory', task: 'T3', plan: 'live', summary: 'PROBIO x6 -> 409 INSUFFICIENT_STOCK available 5; x5 succeeds' },
  { id: 'EVAL-05b', area: 'inventory', task: 'T3', plan: 'live', summary: 'ZINC x1 -> 409 available 0' },
  { id: 'EVAL-05c', area: 'inventory', task: 'T3', plan: 'live', summary: 'cross-order reservation: ben 409 available 0; after ana cancels, available 5' },
  { id: 'EVAL-14', area: 'inventory', task: 'T3', plan: 'live', summary: 'reservation expiry after 7d+1m -> expired, released, pay ORDER_EXPIRED', note: 'driven via the merged runExpireReservations job fn; the admin HTTP route POST /api/admin/jobs/expire-reservations calls the same function' },

  // Payment + ledger (T4, merged).
  { id: 'EVAL-06', area: 'payment', task: 'T4', plan: 'live', summary: 'pay twice same key -> same payment id; new key -> 409 ALREADY_PAID; exactly 1 payment/1 journal' },
  { id: 'EVAL-06b', area: 'payment', task: 'T4', plan: 'live', summary: 'PAYMENT journal: CASH +8497, COGS -4025, PAYABLE -4408, FEE -64, sum 0; MAG 48 / VITD3 39, reserved 0' },
  { id: 'EVAL-06c', area: 'payment', task: 'T4', plan: 'live', summary: 'audit: all invariant checks pass; history draft->sent->paid' },
  { id: 'EVAL-06d', area: 'payment', task: 'T4', plan: 'live', summary: 'decline at 1313 -> 402 PAYMENT_DECLINED; order stays sent; no payment/journal' },

  // Refunds (T5, merged).
  { id: 'EVAL-07', area: 'refund', task: 'T5', plan: 'live', summary: 'refund paid EVAL-01 (patient_request): amount 8497; REFUND CASH -8497, COGS +4025, PAYABLE +4472 (4408 margin_reversal + 64 fee_retention); FEE untouched; PAYMENT journal unchanged (ADR-007); restock to 50/40; refunded' },
  { id: 'EVAL-07b', area: 'refund', task: 'T5', plan: 'live', summary: 'refund again -> 409 ALREADY_REFUNDED' },
  { id: 'EVAL-08', area: 'refund', task: 'T5', plan: 'live', summary: 'pay EVAL-02, fulfill, refund damaged: no restock (OMEGA stays 29); writeoff_cogs 2280' },
  { id: 'EVAL-08b', area: 'refund', task: 'T5', plan: 'live', summary: 'refund a sent order -> 409 NOT_REFUNDABLE' },

  // Reports / payables (T8, merged) and admin metrics (T10, merged).
  { id: 'EVAL-09', area: 'metrics', task: 'T10', plan: 'live', summary: 'admin metrics (groupBy=provider): GMV 13496, refunded 8497, settled 4999, fee revenue 102, sunk fees 64, net margin 2681, net after sunk fees 2617; reconciliation passes' },
  { id: 'EVAL-09b', area: 'reports', task: 'T8', plan: 'live', summary: 'provider payables: credits 7089, debits 4472, closing 2617; refunded order nets -64 (ADR-012)' },
  { id: 'EVAL-10', area: 'reports', task: 'T8', plan: 'live', summary: 'late refund of a closed-month order: M statement frozen (credits 4408); current period debits 4472, closing -64 (ADR-014/016)' },

  // Recurring (T9, merged).
  { id: 'EVAL-11', area: 'recurring', task: 'T9', plan: 'live', summary: 'authorized cycle pays: recurring_cycle, fee 23, margin 1526 (the markup), MAG on_hand -1; balanced PAYMENT journal via T4 path' },
  { id: 'EVAL-11b', area: 'recurring', task: 'T9', plan: 'live', summary: 'schedule PROBIO x6 -> cycle on_hold INSUFFICIENT_STOCK, no journal, stock untouched' },
  { id: 'EVAL-11c', area: 'recurring', task: 'T9', plan: 'live', summary: 'unauthorized schedule run -> cycle on_hold NOT_AUTHORIZED, no journal' },
  { id: 'EVAL-11d', area: 'recurring', task: 'T9', plan: 'live', summary: 'raise MAG cogs to 3000, run cycle -> pays at 4561, provider still nets the 1526 markup (ADR-028 pass-through)' },

  // Privacy + demo isolation.
  { id: 'EVAL-12', area: 'privacy', task: 'T4', plan: 'live', summary: 'GET /api/pay/:token strict whitelist; no cogs/fee/margin/provider economics' },
  { id: 'EVAL-13', area: 'demo', task: 'T10', plan: 'live', summary: 'synthetic baseline + migration generated via real split/posting: includeSynthetic=false metrics identical before/after; =true surfaces migration %; reset purges synthetic to 0 and leaves real ledger untouched' },
  { id: 'EVAL-15', area: 'demo', task: 'T10', plan: 'live', summary: 'DEMO_MODE=false -> every /api/admin/demo/* returns 403 DEMO_DISABLED' },

  // RT-A application attacks.
  { id: 'RT-01', area: 'redteam', task: 'T3/T4', plan: 'live', summary: 'IDOR: another provider reads/edits an order -> 404, no leak' },
  { id: 'RT-02', area: 'redteam', task: 'T4', plan: 'live', summary: 'bad/foreign patient token -> 404; tokens are 24 random bytes, no sequential ids' },
  { id: 'RT-03', area: 'redteam', task: 'T4', plan: 'live', summary: 'client-sent amount/price at pay is ignored; charged snapshot subtotal' },
  { id: 'RT-04', area: 'redteam', task: 'T4', plan: 'live', summary: '10 parallel pays (mixed keys) -> exactly 1 payment, 1 journal, stock sold once' },
  { id: 'RT-05', area: 'redteam', task: 'T3', plan: 'live', summary: 'two concurrent sends for last units -> exactly one wins; reserved <= on_hand' },
  { id: 'RT-06', area: 'redteam', task: 'T3', plan: 'live', summary: 'edit lines after send -> 409 ORDER_NOT_EDITABLE' },
  { id: 'RT-07', area: 'redteam', task: 'T3', plan: 'live', summary: 'negative/zero/decimal/string/huge qty & markup, and retired price/margin fields -> 400 INVALID_INPUT; no float reaches money' },
  { id: 'RT-08', area: 'redteam', task: 'T5', plan: 'live', summary: '10 parallel refunds -> exactly 1 refund, 1 REFUND journal, restock once' },
  { id: 'RT-09', area: 'redteam', task: 'T0/T11', plan: 'live', summary: 'provider calls restock/metrics/demo -> 403 FORBIDDEN (role guard)' },
  { id: 'RT-10', area: 'redteam', task: 'T4', plan: 'live', summary: 'patient routes and error bodies never leak COGS/margin/fee' },
  { id: 'RT-11', area: 'redteam', task: 'T2', plan: 'live', summary: 'direct SQL UPDATE/DELETE on ledger tables -> trigger raises; synthetic purge gated' },
  { id: 'RT-12', area: 'redteam', task: 'T3', plan: 'live', summary: 'SQL injection via sku / date filters -> parameterized, no injection, table intact', note: 'CSV-import row validation is covered by the baseline import API test (apps/api/test/admin/demo.test.ts, RT-12)' },
  { id: 'RT-13', area: 'redteam', task: 'T9', plan: 'live', summary: 'recurring cycle triggered twice (concurrent) for the same period -> exactly ONE child order', note: 'enforced by a schedule row lock + next_run_at due-gate, NOT a DB unique constraint (none exists on (schedule_id, cycle_number) in the approved data model)' },
  { id: 'RT-14', area: 'redteam', task: 'T10', plan: 'live', summary: 'demo endpoints refused in production mode (403 DEMO_DISABLED); no real data purged; payable_statements never deletable even with the purge flag set' },
  { id: 'RT-15', area: 'redteam', task: 'T4', plan: 'live', summary: 'pay an expired order after reservation released -> 409 ORDER_EXPIRED; no oversell' }
]

interface ResultLine {
  id: string
  status: Status
  note?: string
}

/** Append a single id outcome. Safe to call repeatedly; last write per id wins. */
export function recordResult(id: string, status: Status, note?: string): void {
  const line: ResultLine = { id, status, note }
  fs.appendFileSync(RESULTS_FILE, JSON.stringify(line) + '\n', 'utf8')
}

/** Reset the results log at the start of a run. */
export function clearResults(): void {
  try {
    fs.rmSync(RESULTS_FILE, { force: true })
  } catch {
    /* ignore */
  }
}

function readResults(): Map<string, ResultLine> {
  const byId = new Map<string, ResultLine>()
  if (!fs.existsSync(RESULTS_FILE)) return byId
  const text = fs.readFileSync(RESULTS_FILE, 'utf8')
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    try {
      const line = JSON.parse(trimmed) as ResultLine
      byId.set(line.id, line)
    } catch {
      /* ignore malformed */
    }
  }
  return byId
}

const SYMBOL: Record<Status, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  pending: 'PENDING',
  cut: 'CUT',
  'not-run': 'NOT-RUN'
}

/** Final status for an id = the recorded outcome if any, else the manifest default. */
function finalStatus(entry: ManifestEntry, recorded?: ResultLine): { status: Status; note?: string } {
  if (recorded) return { status: recorded.status, note: recorded.note ?? entry.note }
  if (entry.plan.startsWith('cut:')) return { status: 'cut', note: entry.note }
  if (entry.plan.startsWith('pending:')) return { status: 'pending', note: entry.note ?? `awaiting ${entry.task}` }
  return { status: 'not-run', note: entry.note }
}

/**
 * Build the human-readable report and write it to tests/e2e/RESULTS.md. Returns the
 * report text so the global teardown can also echo it to the console.
 */
export function buildSummary(): string {
  const recorded = readResults()
  const rows = MANIFEST.map((entry) => {
    const { status, note } = finalStatus(entry, recorded.get(entry.id))
    return { entry, status, note }
  })

  const tally: Record<Status, number> = { pass: 0, fail: 0, pending: 0, cut: 0, 'not-run': 0 }
  for (const r of rows) tally[r.status] += 1

  const lines: string[] = []
  lines.push('# T13 E2E golden evals and red-team - id-by-id report')
  lines.push('')
  lines.push('Generated by `npm run test:e2e` (tests/e2e/golden/**). Status legend:')
  lines.push('PASS = asserted against real Postgres this run; PENDING = spec written, product behaviour')
  lines.push('not yet merged (auto-enables when the named task lands); CUT = task cut from scope, cannot pass;')
  lines.push('FAIL = ran and a real expectation did not hold (a product finding - investigate, do not weaken).')
  lines.push('')
  lines.push(
    `Totals: PASS ${tally.pass} | PENDING ${tally.pending} | CUT ${tally.cut} | FAIL ${tally.fail}` +
      (tally['not-run'] ? ` | NOT-RUN ${tally['not-run']}` : '')
  )
  lines.push('')
  lines.push('| ID | Status | Area | Task | Scenario |')
  lines.push('|---|---|---|---|---|')
  for (const r of rows) {
    const scenario = r.note ? `${r.entry.summary} _(${r.note})_` : r.entry.summary
    lines.push(`| ${r.entry.id} | ${SYMBOL[r.status]} | ${r.entry.area} | ${r.entry.task} | ${scenario} |`)
  }
  lines.push('')

  const pending = rows.filter((r) => r.status === 'pending')
  const cut = rows.filter((r) => r.status === 'cut')
  const failed = rows.filter((r) => r.status === 'fail')
  if (pending.length) {
    lines.push('## Pending (slot in when the named task merges)')
    for (const r of pending) lines.push(`- ${r.entry.id} - ${r.entry.task}: ${r.entry.summary}`)
    lines.push('')
  }
  if (cut.length) {
    lines.push('## Not implemented - CUT from scope')
    for (const r of cut) lines.push(`- ${r.entry.id} - ${r.entry.task}: ${r.entry.summary}`)
    lines.push('')
  }
  if (failed.length) {
    lines.push('## FAILURES (product findings - report to the orchestrator, do not weaken the test)')
    for (const r of failed) lines.push(`- ${r.entry.id}: ${r.note ?? 'see test output'}`)
    lines.push('')
  }

  const report = lines.join('\n')
  try {
    fs.writeFileSync(path.resolve(__dirname, '..', 'RESULTS.md'), report, 'utf8')
  } catch {
    /* best effort */
  }
  return report
}
