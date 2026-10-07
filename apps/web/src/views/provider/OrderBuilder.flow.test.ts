// @vitest-environment happy-dom
//
// Order builder flows added by the UX overhaul:
//  - Send goes through a confirmation that summarises the order, then shows a success
//    state with the copyable patient link.
//  - Remove asks for confirmation before deleting the line.
//  - "Change margin" on an item sends marginBps only (never a typed price).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const { routeQuery, replace, apiRequest } = vi.hoisted(() => ({
  routeQuery: { orderId: 'o1' } as { orderId?: string },
  replace: vi.fn(),
  apiRequest: vi.fn()
}))

vi.mock('vue-router', () => ({ useRoute: () => ({ query: routeQuery }), useRouter: () => ({ replace }) }))
vi.mock('../../api/client', () => {
  class ApiError extends Error {
    code = 'ERR'
    status = 500
    details = {}
  }
  return { apiRequest, ApiError }
})

const line = {
  id: 'l1', position: 1, sku: 'MAG-GLY-120', name: 'Magnesium Glycinate 120ct', qty: 2,
  unitPriceCents: 2999, unitCogsCents: 1450, lineTotalCents: 5998, lineCogsCents: 2900,
  lineFeeCents: 45, lineMarginCents: 3053
}
const draftQuote = {
  orderId: 'o1',
  status: 'draft',
  totals: { feeBps: 75, subtotalCents: 5998, cogsCents: 2900, feeCents: 45, marginCents: 3053 },
  lines: [line]
}
let quote: Record<string, unknown> = draftQuote

beforeEach(() => {
  apiRequest.mockReset()
  quote = draftQuote
  apiRequest.mockImplementation((path: string, opts?: { method?: string }) => {
    if (path.startsWith('/products')) return Promise.resolve({ products: [] })
    if (path.startsWith('/patients')) return Promise.resolve({ patients: [{ id: 'p1', name: 'Cara Lopez' }] })
    if (path.startsWith('/orders?')) return Promise.resolve({ orders: [{ id: 'o1', patientId: 'p1' }] })
    if (path.endsWith('/send') && opts?.method === 'POST') {
      quote = { ...draftQuote, status: 'sent' }
      return Promise.resolve({ order: { status: 'sent' }, payUrl: '/pay/tok-xyz' })
    }
    if (path.includes('/quote')) return Promise.resolve(quote)
    return Promise.resolve({})
  })
})

import OrderBuilder from './OrderBuilder.vue'

const calls = (method: string) => apiRequest.mock.calls.filter(([, o]) => o?.method === method)

describe('OrderBuilder - send flow', () => {
  it('titles the draft with the patient name', async () => {
    const w = mount(OrderBuilder)
    await flushPromises()
    expect(w.find('h1').text()).toBe('Draft order for Cara Lopez')
  })

  it('confirms with an order summary before sending, then shows the pay link', async () => {
    const w = mount(OrderBuilder)
    await flushPromises()

    await w.find('[data-testid="review-send"]').trigger('click')
    const dialog = w.find('[data-testid="confirm-dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('2 × Magnesium Glycinate 120ct')
    expect(dialog.text()).toContain('$59.98')
    expect(calls('POST')).toHaveLength(0) // nothing sent yet

    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(apiRequest).toHaveBeenCalledWith('/orders/o1/send', { method: 'POST' })
    expect(w.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
    expect(w.text()).toContain('Sent to Cara Lopez')
    expect((w.find('[data-test="pay-url"]').element as HTMLInputElement).value).toContain('/pay/tok-xyz')
  })

  it('cancelling the confirmation sends nothing', async () => {
    const w = mount(OrderBuilder)
    await flushPromises()
    await w.find('[data-testid="review-send"]').trigger('click')
    await w.find('[data-testid="confirm-cancel"]').trigger('click')
    expect(calls('POST')).toHaveLength(0)
  })
})

describe('OrderBuilder - item actions', () => {
  it('asks before removing an item', async () => {
    const w = mount(OrderBuilder)
    await flushPromises()
    await w.find('[data-testid="remove-line"]').trigger('click')
    expect(calls('DELETE')).toHaveLength(0)
    expect(w.find('[data-testid="confirm-dialog"]').text()).toContain('Magnesium Glycinate 120ct')
    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(apiRequest).toHaveBeenCalledWith('/orders/o1/lines/l1', { method: 'DELETE' })
  })

  it('changes margin by sending marginBps only', async () => {
    const w = mount(OrderBuilder)
    await flushPromises()
    await w.find('[data-testid="change-margin"]').trigger('click')
    await w.find('[data-testid="line-margin-input"]').setValue('40')
    await w.find('[data-testid="line-margin-apply"]').trigger('submit')
    await flushPromises()
    expect(apiRequest).toHaveBeenCalledWith('/orders/o1/lines/l1', { method: 'PATCH', body: { marginBps: 4000 } })
  })
})
