// @vitest-environment happy-dom
//
// The live margin preview asks the server (never computes a price), debounces typing,
// shows the server's figures, and ignores a stale reply that arrives late.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MarginPreview from './MarginPreview.vue'

const result = (unitPriceCents: number, diff: number) => ({
  sku: 'MAG-GLY-120', marginBps: 4000, unitPriceCents, listPriceCents: 2999, listMarginBps: 5165, differenceFromListCents: diff
})

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('MarginPreview', () => {
  it('asks the server for the margin in basis points and shows its price and comparison', async () => {
    const preview = vi.fn().mockResolvedValue(result(2417, -582))
    const w = mount(MarginPreview, { props: { sku: 'MAG-GLY-120', marginInput: '40', preview } })
    await vi.advanceTimersByTimeAsync(350)
    await flushPromises()
    expect(preview).toHaveBeenCalledWith('MAG-GLY-120', 4000)
    expect(w.text()).toContain('$24.17')
    expect(w.text()).toContain('$5.82 below list')
  })

  it('does nothing for blank or invalid margins', async () => {
    const preview = vi.fn()
    mount(MarginPreview, { props: { sku: 'MAG-GLY-120', marginInput: '96', preview } })
    mount(MarginPreview, { props: { sku: 'MAG-GLY-120', marginInput: '', preview } })
    await vi.advanceTimersByTimeAsync(500)
    expect(preview).not.toHaveBeenCalled()
  })

  it('debounces typing and ignores a stale reply', async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    const preview = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(result(3625, 626))
    const w = mount(MarginPreview, { props: { sku: 'MAG-GLY-120', marginInput: '4', preview } })
    await w.setProps({ marginInput: '40' }) // typed again within the debounce window
    await vi.advanceTimersByTimeAsync(350)
    expect(preview).toHaveBeenCalledTimes(1)
    await w.setProps({ marginInput: '60' })
    await vi.advanceTimersByTimeAsync(350)
    await flushPromises()
    resolveFirst(result(1, -2998)) // the older request answers last
    await flushPromises()
    expect(w.text()).toContain('$36.25')
    expect(w.text()).not.toContain('$0.01')
  })
})
