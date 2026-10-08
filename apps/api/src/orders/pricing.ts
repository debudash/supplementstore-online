// Order pricing for the API (ADR-028). One place decides how a set of lines is priced, so
// drafts, send, recurring cycles and the audit all agree:
//  - every line carries the provider's markup -> priceOrder: the patient total is rounded
//    once per order, the fee is 0.75% of it rounded up once, the provider nets exactly
//    qty x markup on every line, and nothing is left over as rounding;
//  - an order with a line priced before ADR-028 (no markup) keeps its stored unit prices
//    and is split the old way (split()), so history is never repriced.
// All arithmetic stays in @cerbo/money (AGENTS.md money rule 2).
import { priceOrder, split, type PricedOrder } from '@cerbo/money'

export interface PriceableLine {
  position: number
  qty: number
  unitCogsCents: number
  /** The provider's per-unit markup; null on lines priced before ADR-028. */
  unitMarkupCents: number | null
  /** The stored unit price, used only for lines without a markup. */
  unitPriceCents: number
}

/** Price an order's lines (see the module header). */
export function priceLines(lines: PriceableLine[], feeBps: number): PricedOrder {
  if (lines.every((l) => l.unitMarkupCents !== null)) {
    return priceOrder(
      lines.map((l) => ({
        position: l.position,
        qty: l.qty,
        unitCogsCents: l.unitCogsCents,
        markupCents: l.unitMarkupCents as number
      })),
      feeBps
    )
  }
  const s = split(
    lines.map((l) => ({ position: l.position, qty: l.qty, unitPriceCents: l.unitPriceCents, unitCogsCents: l.unitCogsCents })),
    feeBps
  )
  return {
    ...s,
    lines: s.lines.map((sl, i) => ({ ...sl, unitPriceCents: lines[i]!.unitPriceCents, unitPriceIsAverage: false }))
  }
}

/** A single line priced on its own: the unit price stored on a draft line until send. */
export function standaloneUnitPrice(qty: number, unitCogsCents: number, markupCents: number, feeBps: number): number {
  return priceOrder([{ position: 1, qty, unitCogsCents, markupCents }], feeBps).lines[0]!.unitPriceCents
}
