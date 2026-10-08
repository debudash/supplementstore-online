// DEMO extension (ADR-029): the simulated lab rules. One suggestion per LOW marker, in panel
// order, flagged when already on the order or out of stock; in-range results listed as normal.
import { describe, it, expect } from 'vitest'
import { labSuggestions } from './labSuggestions'

const CARA = 'cccccccc-0000-0000-0000-000000000001'
const DEV = 'cccccccc-0000-0000-0000-000000000002'
const products = [
  { sku: 'MAG-GLY-120', name: 'Magnesium Glycinate 120ct', available: 50 },
  { sku: 'VITD3-K2', name: 'Vitamin D3 + K2', available: 40 },
  { sku: 'OMEGA3-1000', name: 'Omega-3 Fish Oil 1000mg', available: 30 },
  { sku: 'PROBIO-50B', name: 'Probiotic 50B CFU', available: 5 },
  { sku: 'ZINC-30', name: 'Zinc Picolinate 30mg', available: 0 }
]

describe('labSuggestions (DEMO, simulated)', () => {
  it("Cara: four low markers, Vitamin D already on the order, zinc out of stock, CRP normal", () => {
    const v = labSuggestions(CARA, new Set(['VITD3-K2']), products)!
    expect(v.collectedOn).toBe('2026-09-28')
    expect(v.suggestions.map((s) => [s.sku, s.onOrder, s.outOfStock])).toEqual([
      ['VITD3-K2', true, false],
      ['MAG-GLY-120', false, false],
      ['OMEGA3-1000', false, false],
      ['ZINC-30', false, true]
    ])
    expect(v.suggestions[1]).toMatchObject({ productName: 'Magnesium Glycinate 120ct', result: '4.0 mg/dL', range: '4.2-6.8' })
    expect(v.normal).toEqual(['hs-CRP 0.6 mg/L'])
  })

  it('Dev: a different profile (omega-3 and microbiome low, the rest normal)', () => {
    const v = labSuggestions(DEV, new Set(), products)!
    expect(v.suggestions.map((s) => s.sku)).toEqual(['OMEGA3-1000', 'PROBIO-50B'])
    expect(v.normal).toEqual(['25-OH Vitamin D 41 ng/mL', 'RBC magnesium 5.1 mg/dL', 'hs-CRP 0.8 mg/L'])
  })

  it('a patient with no panel on file gets null', () => {
    expect(labSuggestions('someone-else', new Set(), products)).toBeNull()
    expect(labSuggestions(null, new Set(), products)).toBeNull()
  })
})
