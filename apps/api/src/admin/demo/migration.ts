// Synthetic in-house migration activity generator (T10) - FR-14 AC3, ADR-019.
//
// THE POINT (ADR-019, and the #1 thing not to get wrong): synthetic demo orders must be
// generated through the REAL split and posting code so they prove the same invariants a
// real order does. We therefore:
//   - compute every amount with @cerbo/money's split() (money rule 2), never by hand;
//   - post the money with the REAL ledger postPaymentJournal() (T4), the same function
//     the pay flow uses - we do NOT write journals/entries directly;
//   - flag every row is_synthetic = true so metrics exclude it by default;
//   - BYPASS inventory entirely (ADR-019: "synthetic orders never touch inventory") - no
//     reservation, no sale, no inventory_movements - so demo data never moves real stock;
//   - BACKDATE via the injected Clock seam: paid_at / created_at are set from a per-month
//     date derived from clock.now(), so the activity lands in past calendar months. The
//     admin metrics period basis is orders.paid_at (docs/METRICS.md), so backdating via
//     paid_at is sufficient even though the real posting code stamps journals.posted_at
//     with the DB now() (and the ledger is append-only, so that is never rewritten).
//
// Activity ramps: more recent months generate more orders, so in-house GMV (and thus
// migration %) grows toward the present - the "ramping share of baseline" of FR-14 AC3.
import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { split, priceFromMarginBps, type SplitLineInput } from '@cerbo/money'
import { postPaymentJournal } from '../../ledger'
import type { Clock } from '../../seams/types'
import { SystemClock } from '../../seams'
import type { MigrationGenerateResult } from '@cerbo/contracts'
import { makeRng } from './rng'

interface ProductRow {
  sku: string
  unit_cogs_cents: number
}

/** A provider that has a baseline and a patient to attribute synthetic orders to. */
interface GenProvider {
  providerId: string
  practiceId: string
  patientId: string
}

/** Pick 1-3 distinct SKUs for a synthetic order, priced above COGS so margin >= 0. */
function buildLines(
  products: ProductRow[],
  rng: { int: (a: number, b: number) => number; pick: <T>(x: T[]) => T }
): Array<SplitLineInput & { sku: string; unitCogsCents: number }> {
  const count = Math.min(rng.int(1, 3), products.length)
  const chosen = new Set<string>()
  const lines: Array<SplitLineInput & { sku: string; unitCogsCents: number }> = []
  let position = 1
  while (lines.length < count) {
    const product = rng.pick(products)
    if (chosen.has(product.sku)) continue
    chosen.add(product.sku)
    const qty = rng.int(1, 4)
    // 25%-40% target margin -> integer price strictly above COGS (ADR-005).
    const marginBps = rng.int(2500, 4000)
    const unitPriceCents = priceFromMarginBps(product.unit_cogs_cents, marginBps)
    lines.push({ position: position++, sku: product.sku, qty, unitPriceCents, unitCogsCents: product.unit_cogs_cents })
  }
  return lines
}

/**
 * Generate synthetic in-house migration activity (FR-14 AC3). One transaction per order:
 * insert the order + lines from a real split, insert the payment, post the REAL PAYMENT
 * journal, mark paid - all backdated via the injected Clock, with NO inventory effect.
 */
export async function generateMigration(
  db: Knex,
  seed: number,
  months: number,
  clock: Clock = new SystemClock()
): Promise<MigrationGenerateResult> {
  const rng = makeRng(seed)
  const now = clock.now()

  // Providers that have a baseline (real or synthetic) and at least one patient to use.
  const baselineProviderRows = await db('baseline_orders')
    .distinct('provider_id')
    .whereNotNull('provider_id')
  const baselineProviderIds = baselineProviderRows.map((r: { provider_id: string }) => r.provider_id)

  const providers: GenProvider[] = []
  for (const providerId of baselineProviderIds) {
    const provider = await db('providers').where('id', providerId).first<{ id: string; practice_id: string }>()
    if (!provider) continue
    const patient = await db('patients').where('practice_id', provider.practice_id).first<{ id: string }>()
    if (!patient) continue
    providers.push({ providerId, practiceId: provider.practice_id, patientId: patient.id })
  }

  const products = (await db('products').where('active', true).select('sku', 'unit_cogs_cents')) as ProductRow[]
  if (products.length === 0 || providers.length === 0) {
    return { seed, months, orderCount: 0, gmvCents: 0 }
  }

  let orderCount = 0
  let gmvCents = 0

  for (const provider of providers) {
    // r = 0 is the current month, r = months-1 the oldest. Recent months ramp up.
    for (let r = 0; r < months; r++) {
      const ordersThisMonth = months - r // most for the current month
      // A deterministic day inside month (now - r); clamp the current month to <= now.
      const monthBase = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - r, 1))
      const day = r === 0 ? Math.min(15, now.getUTCDate()) : 15
      const paidAt = new Date(Date.UTC(monthBase.getUTCFullYear(), monthBase.getUTCMonth(), day, 12, 0, 0))

      for (let o = 0; o < ordersThisMonth; o++) {
        const result = await generateOneOrder(db, provider, products, paidAt, rng)
        orderCount += 1
        gmvCents += result.subtotalCents
      }
    }
  }

  return { seed, months, orderCount, gmvCents }
}

/** Insert one fully-posted synthetic paid order (real split + real posting, no inventory). */
async function generateOneOrder(
  db: Knex,
  provider: GenProvider,
  products: ProductRow[],
  paidAt: Date,
  rng: ReturnType<typeof makeRng>
): Promise<{ subtotalCents: number }> {
  const lineInputs = buildLines(products, rng)
  // REAL split math (money rule 2). Margin is guaranteed >= 0 by the price-from-margin
  // construction, so this never throws MARGIN_NEGATIVE for synthetic data.
  const result = split(lineInputs, 75)
  const bySplitPosition = new Map(result.lines.map((l) => [l.position, l]))

  return db.transaction(async (trx) => {
    const orderId = randomUUID()
    await trx('orders').insert({
      id: orderId,
      provider_id: provider.providerId,
      practice_id: provider.practiceId,
      patient_id: provider.patientId,
      kind: 'one_off',
      status: 'paid',
      fee_bps: 75,
      subtotal_cents: result.subtotal,
      cogs_cents: result.cogs,
      fee_cents: result.fee,
      margin_cents: result.margin,
      sent_at: paidAt,
      paid_at: paidAt,
      is_synthetic: true,
      created_at: paidAt,
      updated_at: paidAt
    })

    const postingLines = []
    for (const input of lineInputs) {
      const s = bySplitPosition.get(input.position)
      if (!s) throw new Error('internal: missing split for synthetic line')
      const lineId = randomUUID()
      await trx('order_lines').insert({
        id: lineId,
        order_id: orderId,
        position: input.position,
        sku: input.sku,
        qty: input.qty,
        unit_price_cents: input.unitPriceCents,
        unit_cogs_cents: input.unitCogsCents,
        line_total_cents: s.total,
        line_cogs_cents: s.cogs,
        line_fee_cents: s.fee,
        line_margin_cents: s.margin
      })
      postingLines.push({
        id: lineId,
        lineTotalCents: s.total,
        lineCogsCents: s.cogs,
        lineFeeCents: s.fee,
        lineMarginCents: s.margin
      })
    }

    const [payment] = await trx('payments')
      .insert({
        order_id: orderId,
        idempotency_key: `synthetic-${randomUUID()}`,
        gateway_ref: 'synthetic',
        amount_cents: result.subtotal,
        is_synthetic: true,
        created_at: paidAt
      })
      .returning<{ id: string }[]>('id')

    // REAL posting code (T4). It stamps is_synthetic from the order context and verifies
    // the per-line balance; the deferred trigger checks the journal sums to zero at commit.
    await postPaymentJournal(trx, {
      order: {
        id: orderId,
        providerId: provider.providerId,
        practiceId: provider.practiceId,
        isSynthetic: true
      },
      lines: postingLines,
      paymentId: payment.id
    })

    await trx('order_events').insert({
      order_id: orderId,
      from_status: null,
      to_status: 'paid',
      actor_user_id: null,
      at: paidAt,
      note: 'synthetic demo order'
    })

    return { subtotalCents: result.subtotal }
  })
}
