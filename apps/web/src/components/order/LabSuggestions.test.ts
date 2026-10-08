// @vitest-environment happy-dom
//
// DEMO extension (ADR-029): the read-only lab suggestions block renders the simulated panel,
// is DEMO-labelled, has no action buttons, and follows the order as items change.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LabSuggestions from './LabSuggestions.vue'

const CARA = 'cccccccc-0000-0000-0000-000000000001'
const products = [
  { sku: 'MAG-GLY-120', name: 'Magnesium Glycinate 120ct', available: 50 },
  { sku: 'VITD3-K2', name: 'Vitamin D3 + K2', available: 40 },
  { sku: 'OMEGA3-1000', name: 'Omega-3 Fish Oil 1000mg', available: 30 },
  { sku: 'ZINC-30', name: 'Zinc Picolinate 30mg', available: 0 }
]

describe('LabSuggestions', () => {
  it("shows Cara's suggestions with the panel date, DEMO label and provider-only footer, and no buttons", () => {
    const w = mount(LabSuggestions, { props: { patientId: CARA, patientFirstName: 'Cara', onOrderSkus: new Set(['VITD3-K2']), products } })
    const text = w.text()
    expect(text).toContain("Suggestions from Cara's latest labs")
    expect(text).toContain('DEMO - simulated labs')
    expect(text).toContain('Panel collected Sep 28, 2026')
    const items = w.findAll('[data-testid="lab-suggestion"]').map((li) => li.text())
    expect(items).toHaveLength(4)
    expect(items[0]).toContain('Vitamin D3 + K2')
    expect(items[0]).toContain('Already on this order.')
    expect(items[1]).toContain('Also helps the body use vitamin D.')
    expect(items[3]).toContain('Currently out of stock.')
    expect(text).toContain('Normal results in this panel: hs-CRP 0.6 mg/L.')
    expect(text).toContain('not shown to the patient')
    expect(w.findAll('button')).toHaveLength(0)
  })

  it('follows the order: a product added to the order is marked as on the order', async () => {
    const w = mount(LabSuggestions, { props: { patientId: CARA, patientFirstName: 'Cara', onOrderSkus: new Set<string>(), products } })
    expect(w.text()).not.toContain('Already on this order.')
    await w.setProps({ onOrderSkus: new Set(['MAG-GLY-120']) })
    const mag = w.findAll('[data-testid="lab-suggestion"]').find((li) => li.text().includes('Magnesium'))!
    expect(mag.text()).toContain('Already on this order.')
  })

  it('a patient without a panel gets one muted line', () => {
    const w = mount(LabSuggestions, { props: { patientId: 'nobody', patientFirstName: 'Pat', onOrderSkus: new Set<string>(), products } })
    expect(w.find('[data-testid="lab-none"]').text()).toBe('No recent lab results on file (DEMO).')
  })
})
