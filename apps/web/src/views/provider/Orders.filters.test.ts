// @vitest-environment happy-dom
//
// Orders list filters and row navigation: the status/date filters become query params on
// GET /orders, an empty filtered result says so (not "No orders yet"), and a row opens
// the order's audit by click or Enter, while in-row controls do not.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

const { push, apiRequest, state } = vi.hoisted(() => ({
  push: vi.fn(),
  apiRequest: vi.fn(),
  state: { orders: [] as unknown[] }
}))

vi.mock('vue-router', async () => {
  const { defineComponent: dc, h: hh } = await import('vue')
  return {
    useRouter: () => ({ push }),
    RouterLink: dc({ name: 'RouterLink', setup: (_p, { slots }) => () => hh('a', slots.default?.()) })
  }
})
vi.mock('../../api/client', () => {
  class ApiError extends Error {
    code = 'ERR'
    status = 500
    details = {}
  }
  return { apiRequest, ApiError }
})

const sentOrder = {
  id: 'o-sent', status: 'sent', patientId: 'p1', subtotalCents: 2999,
  createdAt: '2026-10-06T12:00:00.000Z', sentAt: '2026-10-06T12:51:21.000Z', payToken: 'tok123', payPath: '/pay/tok123'
}

beforeEach(() => {
  push.mockReset()
  apiRequest.mockReset()
  state.orders = [sentOrder]
  apiRequest.mockImplementation((path: string) => {
    if (path.startsWith('/patients')) return Promise.resolve({ patients: [{ id: 'p1', name: 'Cara Lopez' }] })
    if (path.startsWith('/orders')) return Promise.resolve({ orders: state.orders })
    return Promise.resolve({})
  })
})

import Orders from './Orders.vue'

const Link = defineComponent({ setup: (_p, { slots }) => () => h('a', slots.default?.()) })
const mountOrders = () => mount(Orders, { global: { stubs: { RouterLink: Link } } })
const orderPaths = () => apiRequest.mock.calls.map(([p]) => p as string).filter((p) => p.startsWith('/orders'))

describe('Orders - filters', () => {
  it('sends status, from and to as query params', async () => {
    const w = mountOrders()
    await flushPromises()
    expect(orderPaths()).toEqual(['/orders'])

    await w.find('[data-testid="filter-status"]').setValue('paid')
    await flushPromises()
    expect(orderPaths().at(-1)).toBe('/orders?status=paid')

    await w.find('[data-testid="filter-from"]').setValue('2026-10-01')
    await w.find('[data-testid="filter-from"]').trigger('change')
    await w.find('[data-testid="filter-to"]').setValue('2026-10-31')
    await w.find('[data-testid="filter-to"]').trigger('change')
    await flushPromises()
    const last = new URLSearchParams(orderPaths().at(-1)!.split('?')[1])
    expect(last.get('status')).toBe('paid')
    expect(last.get('from')).toBe('2026-10-01')
    expect(last.get('to')?.startsWith('2026-10-31')).toBe(true)
  })

  it('says no orders match when a filter returns nothing', async () => {
    const w = mountOrders()
    await flushPromises()
    state.orders = []
    await w.find('[data-testid="filter-status"]').setValue('refunded')
    await flushPromises()
    expect(w.text()).toContain('No orders match these filters')
    expect(w.text()).not.toContain('No orders yet')
  })

  it('says no orders yet when there are none and no filters', async () => {
    state.orders = []
    const w = mountOrders()
    await flushPromises()
    expect(w.text()).toContain('No orders yet')
  })
})

describe('Orders - row navigation', () => {
  it('opens the audit on row click and on Enter', async () => {
    const w = mountOrders()
    await flushPromises()
    const row = w.find('[data-testid="order-row"]')
    expect(row.attributes('tabindex')).toBe('0')

    await row.trigger('click')
    expect(push).toHaveBeenCalledWith({ name: 'order-audit', params: { id: 'o-sent' } })

    push.mockReset()
    await row.trigger('keydown', { key: 'Enter' })
    expect(push).toHaveBeenCalledWith({ name: 'order-audit', params: { id: 'o-sent' } })
  })

  it('does not navigate when an in-row control is used', async () => {
    const w = mountOrders()
    await flushPromises()
    await w.find('[data-testid="toggle-link"]').trigger('click')
    expect(push).not.toHaveBeenCalled()
    expect(w.find('[data-test="pay-url"]').exists()).toBe(true)
  })
})
