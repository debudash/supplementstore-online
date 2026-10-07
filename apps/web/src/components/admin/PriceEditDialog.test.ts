// @vitest-environment happy-dom
//
// Admin list-price editor (ADR-025): validates before asking the server, reviews the
// server's preview, saves with the price the admin saw (optimistic concurrency), and
// explains a conflict instead of overwriting.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }))
vi.mock('../../api/client', () => {
  class ApiError extends Error {
    code: string
    status: number
    details: Record<string, unknown>
    constructor(status: number, code: string, message: string, details: Record<string, unknown>) {
      super(message)
      this.status = status
      this.code = code
      this.details = details
    }
  }
  return { apiRequest, ApiError }
})
import { ApiError } from '../../api/client'
import PriceEditDialog from './PriceEditDialog.vue'

const item = {
  sku: 'MAG-GLY-120', name: 'Magnesium Glycinate 120ct', unitCogsCents: 1450, listPriceCents: 2999, listMarginBps: 5165,
  activeScheduleCount: 2, onHandQty: 50, reservedQty: 0, available: 50, active: true
}
const preview = {
  sku: item.sku, name: item.name, unitCogsCents: 1450, currentPriceCents: 2999, listPriceCents: 3299,
  currentMarginBps: 5165, listMarginBps: 5604, belowCost: false, differenceCents: 300, activeScheduleCount: 2
}

async function fillAndReview(w: ReturnType<typeof mount>, price: string, reason: string) {
  await w.find('[data-testid="new-price-input"]').setValue(price)
  await w.find('[data-testid="price-reason-input"]').setValue(reason)
  await w.find('[data-testid="confirm-ok"]').trigger('click')
  await flushPromises()
}

beforeEach(() => apiRequest.mockReset())

describe('PriceEditDialog', () => {
  it('validates locally before calling the server', async () => {
    const w = mount(PriceEditDialog, { props: { item } })
    await fillAndReview(w, '12.00', 'x')
    expect(w.text()).toContain("above Cerbo's cost of $14.50")
    expect(w.text()).toContain('Give a reason')
    await fillAndReview(w, '29.99', 'Same price check')
    expect(w.text()).toContain('already the current price')
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('shows the server review with impact, then saves with the price the admin saw', async () => {
    apiRequest.mockResolvedValueOnce(preview).mockResolvedValueOnce({ sku: item.sku, name: item.name, previousPriceCents: 2999, listPriceCents: 3299 })
    const w = mount(PriceEditDialog, { props: { item } })
    await fillAndReview(w, '32.99', 'Supplier cost increase')
    expect(apiRequest).toHaveBeenCalledWith('/admin/products/MAG-GLY-120/list-price-preview?listPriceCents=3299')
    const review = w.find('[data-testid="price-review-step"]')
    expect(review.text()).toContain('$32.99')
    expect(review.text()).toContain('56.04%')
    expect(review.text()).toContain('$3.00 increase')
    expect(review.text()).toContain('2 active recurring schedules include this product')

    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(apiRequest).toHaveBeenLastCalledWith('/admin/products/MAG-GLY-120/list-price', {
      method: 'PATCH',
      body: { listPriceCents: 3299, expectedCurrentPriceCents: 2999, reason: 'Supplier cost increase' }
    })
    expect(w.emitted('saved')).toHaveLength(1)
  })

  it('explains a concurrent change instead of overwriting it', async () => {
    apiRequest
      .mockResolvedValueOnce(preview)
      .mockRejectedValueOnce(new ApiError(409, 'PRICE_CONFLICT', 'changed', { currentPriceCents: 3099 }))
    const w = mount(PriceEditDialog, { props: { item } })
    await fillAndReview(w, '32.99', 'Supplier cost increase')
    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('Someone else changed this price to $30.99')
    expect(w.text()).toContain('Nothing was saved')
    expect(w.emitted('saved')).toBeUndefined()
    expect(w.emitted('conflict')).toHaveLength(1)
  })
})
