// @vitest-environment happy-dom
//
// Component (render + interaction) test for the Orders pay-link toggle.
//
// Why this exists: the owner's number one issue was recovering a sent order's pay link.
// We surface it in the Orders list behind a "Show link" toggle that reveals the shared
// CopyLink. The rest of the web suite is pure-logic and never renders a component or
// exercises a toggle, so a broken toggle (bad v-if, lost reactivity) could pass CI. This
// mounts the real component, dispatches a real click, and asserts the pay link appears
// and hides again - exactly the behaviour a provider depends on.
import { describe, it, expect, vi } from 'vitest'
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

// Mock the API client so mounting is deterministic and offline.
vi.mock('../../api/client', () => ({
  apiRequest: vi.fn((path: string) => {
    if (path.startsWith('/patients')) {
      return Promise.resolve({ patients: [{ id: 'p1', name: 'Cara Lopez', email: 'cara@example.com' }] })
    }
    if (path.startsWith('/orders')) {
      return Promise.resolve({ orders: [sentOrder, draftOrder] })
    }
    return Promise.resolve({})
  }),
  ApiError: class ApiError extends Error {
    code = 'ERR'
    status = 500
    details = {}
  }
}))

import Orders from './Orders.vue'

function showLinkButtons(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('button').filter((b) => b.text() === 'Show link')
}

describe('Orders pay-link toggle', () => {
  it('shows a Show link control only for orders with a payPath (not drafts)', async () => {
    const wrapper = mount(Orders, { global: { stubs: { RouterLink: true } } })
    await flushPromises()

    // One sent order with payPath -> exactly one toggle; the draft shows no toggle.
    expect(showLinkButtons(wrapper)).toHaveLength(1)
    // Link is not present until revealed.
    expect(wrapper.find('[data-test="pay-url"]').exists()).toBe(false)
  })

  it('reveals the CopyLink with the pay URL on click, and hides it again', async () => {
    const wrapper = mount(Orders, { global: { stubs: { RouterLink: true } } })
    await flushPromises()

    await showLinkButtons(wrapper)[0].trigger('click')
    const field = wrapper.find('[data-test="pay-url"]')
    expect(field.exists()).toBe(true)
    expect((field.element as HTMLInputElement).value).toContain('/pay/tok123')
    expect(wrapper.findAll('button').some((b) => b.text() === 'Hide link')).toBe(true)

    // Toggle off collapses it.
    await wrapper.findAll('button').filter((b) => b.text() === 'Hide link')[0].trigger('click')
    expect(wrapper.find('[data-test="pay-url"]').exists()).toBe(false)
  })
})
