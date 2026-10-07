// @vitest-environment happy-dom
//
// Provider refund panel: a pending patient request can be approved (with the money
// consequences stated) or declined (note required); a paid order can be refunded directly
// with a required reason.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }))
vi.mock('../../api/client', () => ({
  apiRequest,
  ApiError: class ApiError extends Error {
    code = 'ERR'
    status = 500
    details = {}
  }
}))

import RefundPanel from './RefundPanel.vue'

let current: unknown = null
beforeEach(() => {
  apiRequest.mockReset()
  apiRequest.mockImplementation((path: string, opts?: { method?: string }) => {
    if (opts?.method === 'POST') return Promise.resolve({})
    if (path.endsWith('/refund-request')) return Promise.resolve({ request: current })
    return Promise.resolve({})
  })
})

const props = { orderId: 'o1', status: 'paid', subtotalCents: 8497, fulfilled: false }
const posts = () => apiRequest.mock.calls.filter(([, o]) => o?.method === 'POST')

describe('RefundPanel', () => {
  it('approves a pending request after stating the consequences', async () => {
    current = { id: 'r1', orderId: 'o1', reasonCode: 'damaged', note: 'Cracked', status: 'pending', decisionNote: null, decidedAt: null, createdAt: '2026-10-07T11:00:00Z' }
    const w = mount(RefundPanel, { props })
    await flushPromises()
    expect(w.find('[data-testid="refund-request-card"]').text()).toContain('Damaged or defective')
    expect(w.find('[data-testid="direct-refund"]').exists()).toBe(false)

    await w.find('[data-testid="approve-refund"]').trigger('click')
    const dialog = w.find('[data-testid="confirm-dialog"]').text()
    expect(dialog).toContain('Refund $84.97?')
    expect(dialog).toContain('platform fee is kept')
    expect(dialog).toContain('stock is returned')
    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(posts()[0][0]).toBe('/orders/o1/refund-request/approve')
    expect(w.emitted('changed')).toHaveLength(1)
  })

  it('declining needs a note for the patient', async () => {
    current = { id: 'r1', orderId: 'o1', reasonCode: 'other', note: null, status: 'pending', decisionNote: null, decidedAt: null, createdAt: '2026-10-07T11:00:00Z' }
    const w = mount(RefundPanel, { props })
    await flushPromises()
    await w.find('[data-testid="decline-refund"]').trigger('click')
    await w.find('[data-testid="confirm-ok"]').trigger('click')
    expect(posts()).toHaveLength(0)
    await w.find('[data-testid="decline-note"]').setValue('Please send a photo')
    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(posts()[0]).toEqual(['/orders/o1/refund-request/decline', { method: 'POST', body: { note: 'Please send a photo' } }])
  })

  it('refunds a paid order directly with a required reason', async () => {
    current = null
    const w = mount(RefundPanel, { props: { ...props, fulfilled: true } })
    await flushPromises()
    await w.find('[data-testid="direct-refund"]').trigger('click')
    expect(w.find('[data-testid="confirm-dialog"]').text()).toContain('Cerbo writes off the cost')
    await w.find('[data-testid="confirm-ok"]').trigger('click')
    expect(posts()).toHaveLength(0)
    await w.find('[data-testid="direct-reason"]').setValue('provider_error')
    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(posts()[0]).toEqual(['/orders/o1/refund', { method: 'POST', body: { reasonCode: 'provider_error' } }])
  })
})
