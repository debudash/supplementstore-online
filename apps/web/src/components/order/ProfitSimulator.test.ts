// @vitest-environment happy-dom
//
// The profit simulator asks the server for two previews (scenario + list baseline),
// shows only the server's figures, warns when the margin cannot cover the fee, and
// "Use list price" asks for marginBps null.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { PricePreview } from '@cerbo/contracts'
import ProfitSimulator from './ProfitSimulator.vue'

const products = [
  { sku: 'OUT-1', name: 'Gone', unitCogsCents: 100, listPriceCents: 200, listMarginBps: 5000, available: 0, active: true },
  { sku: 'MAG-GLY-120', name: 'Magnesium Glycinate 120ct', unitCogsCents: 1450, listPriceCents: 2999, listMarginBps: 5165, available: 20, active: true }
]

const base = {
  sku: 'MAG-GLY-120', listPriceCents: 2999, listMarginBps: 5165, qty: 1
}
const listPreview: PricePreview = {
  ...base, marginBps: null, unitPriceCents: 2999, differenceFromListCents: 0,
  lineTotalCents: 2999, lineCogsCents: 1450, lineFeeCents: 22, lineMarginCents: 1527, coversFee: true
}
const scenarioPreview: PricePreview = {
  ...base, marginBps: 4000, unitPriceCents: 2417, differenceFromListCents: -582,
  lineTotalCents: 4834, lineCogsCents: 2900, lineFeeCents: 36, lineMarginCents: 1898, coversFee: true
}
const noFeePreview: PricePreview = {
  ...base, marginBps: 0, unitPriceCents: 1450, differenceFromListCents: -1549,
  lineTotalCents: 1450, lineCogsCents: 1450, lineFeeCents: null, lineMarginCents: null, coversFee: false
}

function makePreview(scenario: PricePreview) {
  return vi.fn((_sku: string, marginBps: number | null, _qty: number): Promise<PricePreview> =>
    Promise.resolve(marginBps === null ? listPreview : scenario)
  )
}

async function openSim(preview: ReturnType<typeof makePreview>) {
  const w = mount(ProfitSimulator, { props: { products, preview } })
  await w.find('[data-testid="sim-toggle"]').trigger('click')
  await vi.advanceTimersByTimeAsync(300)
  await flushPromises()
  return w
}

/** Open, then move the slider to a margin (the simulator opens at list price). */
async function openAt(preview: ReturnType<typeof makePreview>, bps: string) {
  const w = await openSim(preview)
  await w.find('[data-testid="sim-margin"]').setValue(bps)
  await vi.advanceTimersByTimeAsync(300)
  await flushPromises()
  return w
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('ProfitSimulator', () => {
  it('is collapsed and fetches nothing until opened', async () => {
    const preview = makePreview(scenarioPreview)
    const w = mount(ProfitSimulator, { props: { products, preview } })
    await vi.advanceTimersByTimeAsync(500)
    expect(preview).not.toHaveBeenCalled()
    expect(w.find('select').exists()).toBe(false)
    expect(w.find('[data-testid="sim-toggle"]').attributes('aria-expanded')).toBe('false')
  })

  it('opens at the exact list price for the first in-stock product', async () => {
    const preview = makePreview(scenarioPreview)
    const w = await openSim(preview)
    expect((w.find('[data-testid="sim-product"]').element as HTMLSelectElement).value).toBe('MAG-GLY-120')
    // Scenario and baseline are both the list price until the slider moves.
    expect(preview).toHaveBeenCalledTimes(2)
    expect(preview.mock.calls.every(([sku, m, q]) => sku === 'MAG-GLY-120' && m === null && q === 1)).toBe(true)
    expect(w.find('[data-testid="sim-margin-value"]').text()).toContain('List price')
    expect(w.find('[data-testid="sim-diff"]').exists() ? w.find('[data-testid="sim-diff"]').text() : '').not.toContain('below')
  })

  it('debounces slider and quantity changes and sends the new arguments', async () => {
    const preview = makePreview(scenarioPreview)
    const w = await openSim(preview)
    preview.mockClear()
    await w.find('[data-testid="sim-margin"]').setValue('4000')
    await w.find('[data-testid="qty-inc"]').trigger('click')
    await vi.advanceTimersByTimeAsync(100)
    expect(preview).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(preview).toHaveBeenCalledTimes(2)
    expect(preview).toHaveBeenCalledWith('MAG-GLY-120', 4000, 2)
    expect(preview).toHaveBeenCalledWith('MAG-GLY-120', null, 2)
  })

  it('renders the server figures in the headline and table', async () => {
    const w = await openAt(makePreview(scenarioPreview), '4000')
    expect(w.find('[data-testid="sim-headline"]').text()).toContain('You earn $18.98 a month')
    expect(w.find('[data-testid="sim-diff"]').text()).toBe('($5.82 below list)')
    expect(w.find('[data-testid="sim-unit"]').text()).toBe('$24.17')
    expect(w.find('[data-testid="sim-total"]').text()).toBe('$48.34')
    expect(w.find('[data-testid="sim-cogs"]').text()).toBe('$29.00')
    expect(w.find('[data-testid="sim-fee"]').text()).toBe('$0.36')
    expect(w.find('[data-testid="sim-net"]').text()).toBe('$18.98')
    const table = w.find('[data-testid="sim-table"]').text()
    expect(table).toContain('At list price')
    expect(table).toContain('$15.27') // list baseline net
    expect(w.find('[data-testid="sim-fee-warning"]').exists()).toBe(false)
  })

  it('warns and shows "-" for fee and net when the margin does not cover the fee', async () => {
    const w = await openAt(makePreview(noFeePreview), '0')
    expect(w.find('[data-testid="sim-fee-warning"]').text()).toContain(
      'This margin does not cover the 0.75% platform fee, so it cannot be ordered. Raise the margin.'
    )
    expect(w.find('[data-testid="sim-fee"]').text()).toBe('-')
    expect(w.find('[data-testid="sim-net"]').text()).toBe('-')
  })

  it('"Use list price" sends marginBps null for the scenario', async () => {
    const preview = makePreview(scenarioPreview)
    const w = await openAt(preview, '4000')
    preview.mockClear()
    await w.find('[data-testid="sim-use-list"]').trigger('click')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(preview).toHaveBeenCalledTimes(2)
    expect(preview.mock.calls.every(([, m]) => m === null)).toBe(true)
    expect(w.find('[data-testid="sim-margin-value"]').text()).toContain('List price')
  })

  it('does not crash when the preview resolves to an empty object', async () => {
    const preview = vi.fn(() => Promise.resolve({}))
    const w = mount(ProfitSimulator, { props: { products, preview: preview as never } })
    await w.find('[data-testid="sim-toggle"]').trigger('click')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(w.find('[data-testid="sim-headline"]').exists()).toBe(false)
  })
})
