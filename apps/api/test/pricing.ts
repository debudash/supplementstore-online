// Test helper (ADR-028): providers price a line with a per-unit markup, not a price. Many
// scenarios are specified by the PRICE the patient pays (docs/EVALS.md: MAG @ 2999 ...),
// so this returns the exact markup that prices a seed SKU at that price, and fails loudly
// if no markup can (the grossed-up price skips about 1 in 133 cent values).
import { priceFromMarkupCents, DEFAULT_FEE_BPS } from '@cerbo/money'

/** Seed COGS from docs/EVALS.md, keyed by SKU. */
export const SEED_COGS: Record<string, number> = {
  'MAG-GLY-120': 1450,
  'VITD3-K2': 1125,
  'OMEGA3-1000': 2280,
  'PROBIO-50B': 2675,
  'ZINC-30': 690
}

/** The per-unit markup that prices `sku` (at `cogs`, default seed COGS) at exactly `priceCents`. */
export function markupFor(sku: string, priceCents: number, cogs: number = SEED_COGS[sku]): number {
  const markup = Math.floor((priceCents * (10000 - DEFAULT_FEE_BPS)) / 10000) - cogs
  if (markup < 0 || priceFromMarkupCents(cogs, markup, DEFAULT_FEE_BPS) !== priceCents) {
    throw new Error(`no markup prices ${sku} (cogs ${cogs}) at exactly ${priceCents}`)
  }
  return markup
}
