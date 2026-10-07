// @vitest-environment happy-dom
//
// Resume-draft behaviour for the New Order builder (owner requirement): arriving at
// /orders/new?orderId=<id> hydrates the builder from GET /orders/:id/quote instead of
// starting a blank draft, and degrades cleanly when the id is unknown / not the
// provider's / not a draft (no crash, no silent blank draft). No new endpoint is used.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// Hoisted handles so the (hoisted) vi.mock factories can reference them without a TDZ.
const { routeQuery, replace, apiRequest } = vi.hoisted(() => ({
  routeQuery: {} as { orderId?: string },
  replace: vi.fn(),
  apiRequest: vi.fn()
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery }),
  useRouter: () => ({ replace })
}))

// ApiError is defined INSIDE the factory (referencing an outer class would hit the TDZ);
// the test imports it back from the mocked module to construct 404s.
vi.mock('../../api/client', () => {
  class ApiError extends Error {
    code = 'NOT_FOUND'
    status: number
    details = {}
    constructor(status = 404) {
      super('not found')
      this.status = status
    }
  }
  return { apiRequest, ApiError }
})

import { ApiError } from '../../api/client'

const draftQuote = {
  orderId: 'o-draft',
  status: 'draft',
  totals: { feeBps: 75, subtotalCents: 5800, cogsCents: 2900, feeCents: 44, marginCents: 2856 },
  lines: [
    {
      id: 'l1', position: 1, sku: 'MAG-GLY-120', name: 'Magnesium Glycinate 120ct', qty: 2,
      unitPriceCents: 2900, unitCogsCents: 1450, lineTotalCents: 5800, lineCogsCents: 2900,
      lineFeeCents: 44, lineMarginCents: 2856
    }
  ]
}

import OrderBuilder from './OrderBuilder.vue'

function baseRoutes(quoteResult: unknown) {
  apiRequest.mockImplementation((path: string) => {
    if (path.startsWith('/products')) return Promise.resolve({ products: [] })
    if (path.startsWith('/patients')) return Promise.resolve({ patients: [{ id: 'p1', name: 'Cara Lopez' }] })
    if (path.includes('/quote')) {
      return quoteResult instanceof Error ? Promise.reject(quoteResult) : Promise.resolve(quoteResult)
    }
    return Promise.resolve({})
  })
}

beforeEach(() => {
  apiRequest.mockReset()
  replace.mockReset()
  delete routeQuery.orderId
})

describe('OrderBuilder - resume an existing draft', () => {
  it('hydrates the builder from the quote and shows the existing line (no blank draft)', async () => {
    routeQuery.orderId = 'o-draft'
    baseRoutes(draftQuote)
    const wrapper = mount(OrderBuilder)
    await flushPromises()

    // The builder (not the patient-start panel) is shown, bound to the resumed order.
    expect(wrapper.text()).toContain('o-draft')
    expect(wrapper.text()).toContain('status: draft')
    // The existing line is rendered from the quote.
    expect(wrapper.find('[data-test="line-total"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Magnesium Glycinate 120ct')
    // It fetched the quote for that id and never created a new draft.
    expect(apiRequest).toHaveBeenCalledWith('/orders/o-draft/quote')
    expect(apiRequest).not.toHaveBeenCalledWith('/orders', expect.objectContaining({ method: 'POST' }))
  })

  it('degrades cleanly when the order is not found (404 = ownership check)', async () => {
    routeQuery.orderId = 'missing'
    baseRoutes(new ApiError(404))
    const wrapper = mount(OrderBuilder)
    await flushPromises()

    expect(wrapper.find('[data-test="resume-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="resume-error"]').text()).toContain('not found')
    // Falls back to the start panel rather than opening a blank draft or crashing.
    expect(wrapper.text()).toContain('Patient')
  })

  it('refuses to resume a non-draft order with a clear message', async () => {
    routeQuery.orderId = 'o-sent'
    baseRoutes({ ...draftQuote, orderId: 'o-sent', status: 'sent' })
    const wrapper = mount(OrderBuilder)
    await flushPromises()

    expect(wrapper.find('[data-test="resume-error"]').text()).toContain('sent')
    expect(wrapper.text()).toContain('Patient')
  })

  it('starts a blank draft normally when no orderId is present', async () => {
    baseRoutes(draftQuote)
    const wrapper = mount(OrderBuilder)
    await flushPromises()

    // The patient-start panel is shown; no quote fetch happened on mount.
    expect(wrapper.text()).toContain('Patient')
    expect(apiRequest).not.toHaveBeenCalledWith('/orders/o-draft/quote')
  })
})
