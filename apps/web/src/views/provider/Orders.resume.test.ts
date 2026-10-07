// @vitest-environment happy-dom
//
// The Orders list offers a "Resume" link back into the builder for DRAFT orders only
// (owner requirement: drafts were stranded with no way back in). Non-draft orders must
// not offer it, because they are not editable.
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const draftOrder = { id: 'o-draft', status: 'draft', patientId: 'p1', subtotalCents: null, createdAt: '2026-10-06T12:10:00.000Z', sentAt: null, payToken: null, payPath: null }
const sentOrder = { id: 'o-sent', status: 'sent', patientId: 'p1', subtotalCents: 2999, createdAt: '2026-10-06T12:00:00.000Z', sentAt: '2026-10-06T12:51:21.000Z', payToken: 'tok123', payPath: '/pay/tok123' }

vi.mock('../../api/client', () => ({
  apiRequest: vi.fn((path: string) => {
    if (path.startsWith('/patients')) return Promise.resolve({ patients: [{ id: 'p1', name: 'Cara Lopez' }] })
    if (path.startsWith('/orders')) return Promise.resolve({ orders: [draftOrder, sentOrder] })
    return Promise.resolve({})
  }),
  ApiError: class ApiError extends Error { code = 'ERR'; status = 500; details = {} }
}))

import Orders from './Orders.vue'

describe('Orders - resume draft link', () => {
  it('shows a Resume link only for draft orders', async () => {
    const wrapper = mount(Orders, { global: { stubs: { RouterLink: true } } })
    await flushPromises()
    // Exactly one of the two orders (the draft) offers Resume; the sent order does not.
    expect(wrapper.findAll('[data-test="resume-draft"]')).toHaveLength(1)
  })
})
