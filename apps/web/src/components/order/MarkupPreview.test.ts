// @vitest-environment happy-dom
//
// The live markup preview asks the server (never computes a price), debounces typing,
// shows the server's figures, and ignores a stale reply that arrives late.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MarkupPreview from './MarkupPreview.vue'

// MAG-GLY-120 (cogs 1450) + $10.00 markup -> 2469, fee 19, margin 1000 (EVAL-04b).
const result = (unitPriceCents: number, marginCents = 1000, feeCents = 19) => ({
  sku: 'MAG-GLY-120',
  markupCents: marginCents,
  unitPriceCents,
  qty: 1,
  lineTotalCents: unitPriceCents,
  lineCogsCents: 1450,
  lineFeeCents: feeCents,
  lineMarginCents: marginCents,
  unitPriceIsAverage: false
})

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('MarkupPreview', () => {
  it('asks the server for the markup in cents and shows what the patient pays', async () => {
    const preview = vi.fn().mockResolvedValue(result(2469))
    const w = mount(MarkupPreview, { props: { sku: 'MAG-GLY-120', markupInput: '10', preview } })
    await vi.advanceTimersByTimeAsync(350)
    await flushPromises()
    expect(preview).toHaveBeenCalledWith('MAG-GLY-120', 1000)
    expect(w.text()).toContain('Patient pays $24.69 per unit')
    expect(w.text()).toContain('cost $14.50 + your markup $10.00 + 0.75% fee')
    expect(w.text()).not.toContain('rounding')
  })

  it('does nothing for blank, malformed or over-cap markups', async () => {
    const preview = vi.fn()
    mount(MarkupPreview, { props: { sku: 'MAG-GLY-120', markupInput: '1000.01', preview } })
    mount(MarkupPreview, { props: { sku: 'MAG-GLY-120', markupInput: '-5', preview } })
    mount(MarkupPreview, { props: { sku: 'MAG-GLY-120', markupInput: '', preview } })
    await vi.advanceTimersByTimeAsync(500)
    expect(preview).not.toHaveBeenCalled()
  })

  it('debounces typing and ignores a stale reply', async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    const preview = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(result(3477, 2000, 26))
    const w = mount(MarkupPreview, { props: { sku: 'MAG-GLY-120', markupInput: '1', preview } })
    await w.setProps({ markupInput: '10' }) // typed again within the debounce window
    await vi.advanceTimersByTimeAsync(350)
    expect(preview).toHaveBeenCalledTimes(1)
    await w.setProps({ markupInput: '20' })
    await vi.advanceTimersByTimeAsync(350)
    await flushPromises()
    resolveFirst(result(1, 0, 0)) // the older request answers last
    await flushPromises()
    expect(w.text()).toContain('$34.77')
    expect(w.text()).not.toContain('$0.01')
  })
})
