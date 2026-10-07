// @vitest-environment happy-dom
//
// Proves the UI renders the SERVER's remaining-headroom (details.remaining) as N in the
// mandated INSUFFICIENT_STOCK sentence, and never computes it client-side. The sentence
// text is unchanged (AGENTS / T6 acceptance); only N reflects headroom.
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

// Empty draft so PROBIO is addable (a SKU already on the order would be hidden from the
// dropdown and the INSUFFICIENT_STOCK path would be unreachable for it).
const draftQuote = {
  orderId: 'o1',
  status: 'draft',
  totals: { feeBps: 75, subtotalCents: 0, cogsCents: 0, feeCents: 0, marginCents: 0 },
  lines: [] as unknown[]
}
const products = [
  { sku: 'PROBIO-50B', name: 'Probiotic 50B CFU', unitCogsCents: 2675, available: 2, active: true, listPriceCents: 4299, listMarginBps: 3777 }
]

beforeEach(() => {
  apiRequest.mockReset()
  routeQuery.orderId = 'o1'
  apiRequest.mockImplementation((path: string, opts?: { method?: string }) => {
    if (path.startsWith('/products')) return Promise.resolve({ products })
    if (path.startsWith('/patients')) return Promise.resolve({ patients: [{ id: 'p1', name: 'Cara Lopez' }] })
    if (path.includes('/lines') && opts?.method === 'POST') {
      // Server refuses: 5 available, 3 already on the order -> remaining 2.
      return Promise.reject(new ApiError(409, 'INSUFFICIENT_STOCK', 'Not enough stock', { available: 5, remaining: 2 }))
    }
    if (path.includes('/quote')) return Promise.resolve(draftQuote)
    return Promise.resolve({})
  })
})

import OrderBuilder from './OrderBuilder.vue'

describe('OrderBuilder - INSUFFICIENT_STOCK shows server remaining as N', () => {
  it('renders the mandated sentence with N = details.remaining (2), not raw available (5)', async () => {
    const wrapper = mount(OrderBuilder)
    await flushPromises() // resume hydrates the draft from the quote

    // Add PROBIO over availability -> server rejects, carrying its remaining headroom.
    await wrapper.find('select').setValue('PROBIO-50B')
    await wrapper.find('form.add-line').trigger('submit')
    await flushPromises()

    const err = wrapper.find('[data-test="add-error"]')
    expect(err.exists()).toBe(true)
    // Exact mandated copy, N = remaining headroom (2).
    expect(err.text()).toBe('On-hand stock cannot meet this quantity (available: 2). Wait for restock or reduce quantity.')
    // And NOT the raw catalog availability (5).
    expect(err.text()).not.toContain('available: 5')
  })
})
