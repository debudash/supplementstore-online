// @vitest-environment happy-dom
//
// Provider refund review page (ADR-027): shows the request and order from the token,
// Accept refunds now (consequences stated), Decline needs a note, and a link that is not
// the provider's shows a friendly error.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }))
vi.mock('../../api/client', () => {
  class ApiError extends Error {
    code = 'NOT_FOUND'
    status: number
    details = {}
    constructor(status: number) {
      super('not found')
      this.status = status
    }
  }
  return { apiRequest, ApiError }
})
vi.mock('vue-router', () => ({
  RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  useRoute: () => ({ params: { token: 'tok123' } })
}))

import { ApiError } from '../../api/client'
import RefundReview from './RefundReview.vue'

const review = (status = 'pending', shipped = true) => ({
  request: { id: 'r1', orderId: 'o1', reasonCode: 'damaged', note: 'Seal intact', status, decisionNote: null, decidedAt: null, createdAt: '2026-10-07T11:00:00Z', unopenedConfirmed: true, reviewPath: '/refund-review/tok123' },
  order: { id: 'o1', status: 'paid', patientName: 'Maya Chen', subtotalCents: 2999, paidAt: '2026-10-07T10:00:00Z', shipped, refundWindowEndsAt: '2026-11-06T10:00:00Z', items: [{ sku: 'MAG-GLY-120', name: 'Magnesium Glycinate', qty: 1, lineTotalCents: 2999 }] }
})
let current: unknown
const posts = () => apiRequest.mock.calls.filter(([, o]) => o?.method === 'POST')

beforeEach(() => {
  current = review()
  apiRequest.mockReset()
  apiRequest.mockImplementation((_path: string, opts?: { method?: string }) =>
    opts?.method === 'POST' ? Promise.resolve({}) : Promise.resolve(current)
  )
})

describe('RefundReview', () => {
  it('shows the request and accepts with the consequences stated', async () => {
    const w = mount(RefundReview)
    await flushPromises()
    expect(apiRequest).toHaveBeenCalledWith('/refund-review/tok123')
    const card = w.find('[data-testid="review-card"]').text()
    expect(card).toContain('Maya Chen')
    expect(card).toContain('Magnesium Glycinate')
    expect(w.find('[data-testid="review-unopened"]').text()).toBe('Confirmed by the patient')

    await w.find('[data-testid="review-accept"]').trigger('click')
    const dialog = w.find('[data-testid="confirm-dialog"]').text()
    expect(dialog).toContain('Refund $29.99 now?')
    expect(dialog).toContain('writes off the returned stock')
    current = review('approved')
    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(posts()[0]).toEqual(['/refund-review/tok123/accept', { method: 'POST', body: {} }])
    expect(w.find('[data-testid="review-approved"]').exists()).toBe(true)
    expect(w.find('[data-testid="review-accept"]').exists()).toBe(false)
  })

  it('declining needs a note', async () => {
    const w = mount(RefundReview)
    await flushPromises()
    await w.find('[data-testid="review-decline"]').trigger('click')
    await w.find('[data-testid="confirm-ok"]').trigger('click')
    expect(posts()).toHaveLength(0)
    await w.find('[data-testid="review-decline-note"]').setValue('Seal broken in photo')
    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(posts()[0]).toEqual(['/refund-review/tok123/decline', { method: 'POST', body: { note: 'Seal broken in photo' } }])
  })

  it('a link that is not yours shows a friendly error', async () => {
    apiRequest.mockImplementation(() => Promise.reject(new (ApiError as unknown as new (s: number) => Error)(404)))
    const w = mount(RefundReview)
    await flushPromises()
    expect(w.find('[data-testid="review-error"]').text()).toContain('not valid for your account')
  })
})
