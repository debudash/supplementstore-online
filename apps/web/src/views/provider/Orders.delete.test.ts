// @vitest-environment happy-dom
//
// Component test for deleting a draft from the Orders list: the Delete control appears
// only on drafts, confirming sends DELETE /orders/:id and removes the row, and declining
// the confirm sends nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const sentOrder = {
  id: 'o-sent',
  status: 'sent',
  patientId: 'p1',
  subtotalCents: 2999,
  createdAt: '2026-10-06T12:00:00.000Z',
  sentAt: '2026-10-06T12:51:21.000Z',
  payToken: 'tok123',
  payPath: '/pay/tok123'
}
const draftOrder = {
  id: 'o-draft',
  status: 'draft',
  patientId: 'p1',
  subtotalCents: null,
  createdAt: '2026-10-06T12:10:00.000Z',
  sentAt: null,
  payToken: null,
  payPath: null
}

const apiRequest = vi.fn((path: string, opts?: { method?: string }) => {
  if (opts?.method === 'DELETE') return Promise.resolve(null)
  if (path.startsWith('/patients')) {
    return Promise.resolve({ patients: [{ id: 'p1', name: 'Cara Lopez', email: 'cara@example.com' }] })
  }
  if (path.startsWith('/orders')) return Promise.resolve({ orders: [sentOrder, draftOrder] })
  return Promise.resolve({})
})

vi.mock('../../api/client', () => ({
  apiRequest: (path: string, opts?: { method?: string }) => apiRequest(path, opts),
  ApiError: class ApiError extends Error {
    code = 'ERR'
    status = 500
    details = {}
  }
}))

import Orders from './Orders.vue'

const deleteButtons = (w: ReturnType<typeof mount>) => w.findAll('[data-test="delete-draft"]')
const deleteCalls = () => apiRequest.mock.calls.filter(([, opts]) => opts?.method === 'DELETE')

beforeEach(() => {
  apiRequest.mockClear()
})

describe('Orders draft delete', () => {
  it('offers Delete only on draft orders', async () => {
    const wrapper = mount(Orders, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    expect(deleteButtons(wrapper)).toHaveLength(1)
  })

  it('deletes the draft after confirm and removes its row', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const wrapper = mount(Orders, { global: { stubs: { RouterLink: true } } })
    await flushPromises()

    await deleteButtons(wrapper)[0].trigger('click')
    await flushPromises()

    expect(deleteCalls()).toEqual([['/orders/o-draft', { method: 'DELETE' }]])
    expect(deleteButtons(wrapper)).toHaveLength(0)
    expect(wrapper.text()).toContain('sent')
  })

  it('does nothing when the confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const wrapper = mount(Orders, { global: { stubs: { RouterLink: true } } })
    await flushPromises()

    await deleteButtons(wrapper)[0].trigger('click')
    await flushPromises()

    expect(deleteCalls()).toHaveLength(0)
    expect(deleteButtons(wrapper)).toHaveLength(1)
  })
})
