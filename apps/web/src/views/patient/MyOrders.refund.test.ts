// @vitest-environment happy-dom
//
// Patient refund request from My orders: only offered when the server says so, requires a
// reason, says nothing needs returning, posts the request, and shows each request state.
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
vi.mock('vue-router', () => ({ RouterLink: { template: '<a><slot /></a>' } }))

const item = { name: 'Magnesium Glycinate 120ct', qty: 1, unitPriceCents: 2999, lineTotalCents: 2999 }
const base = { status: 'paid', sentAt: '2026-10-07T10:00:00Z', paidAt: '2026-10-07T10:05:00Z', amountCents: 2999, payToken: null, payPath: null, isPayable: false, items: [item] }
let orders: unknown[] = []

beforeEach(() => {
  apiRequest.mockReset()
  orders = [
    { ...base, orderId: 'o-paid', refundRequest: null, canRequestRefund: true },
    { ...base, orderId: 'o-pending', canRequestRefund: false, refundRequest: { status: 'pending', createdAt: '2026-10-07T11:00:00Z', decisionNote: null } },
    { ...base, orderId: 'o-declined', canRequestRefund: true, refundRequest: { status: 'declined', createdAt: '2026-10-07T11:00:00Z', decisionNote: 'Please send a photo first' } }
  ]
  apiRequest.mockImplementation((path: string, opts?: { method?: string }) => {
    if (opts?.method === 'POST') return Promise.resolve({ status: 'pending' })
    if (path === '/patient/orders') return Promise.resolve({ orders })
    return Promise.resolve({})
  })
})

import MyOrders from './MyOrders.vue'

describe('My orders - refund requests', () => {
  it('offers the request only where allowed and shows each state', async () => {
    const w = mount(MyOrders)
    await flushPromises()
    expect(w.find('[data-testid="request-refund-o-paid"]').text()).toBe('Request a refund')
    expect(w.find('[data-testid="request-refund-o-pending"]').exists()).toBe(false)
    expect(w.find('[data-testid="refund-area-o-pending"]').text()).toContain('Your provider will review it')
    expect(w.find('[data-testid="refund-area-o-declined"]').text()).toContain('Please send a photo first')
    expect(w.find('[data-testid="request-refund-o-declined"]').text()).toBe('Request again')
  })

  it('requires a reason, says nothing needs returning, then posts the request', async () => {
    const w = mount(MyOrders)
    await flushPromises()
    await w.find('[data-testid="request-refund-o-paid"]').trigger('click')
    const dialog = w.find('[data-testid="confirm-dialog"]')
    expect(dialog.text()).toContain('You do not need to send anything back')

    await w.find('[data-testid="confirm-ok"]').trigger('click')
    expect(w.text()).toContain('Choose a reason.')
    expect(apiRequest.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false)

    await w.find('[data-testid="refund-reason"]').setValue('damaged')
    await w.find('[data-testid="refund-note"]').setValue('Bottle cracked')
    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(apiRequest).toHaveBeenCalledWith('/patient/orders/o-paid/refund-request', {
      method: 'POST',
      body: { reasonCode: 'damaged', note: 'Bottle cracked' }
    })
  })
})
