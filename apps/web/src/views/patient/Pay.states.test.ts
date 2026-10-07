// @vitest-environment happy-dom
//
// Patient pay page states (UX overhaul): payable, paid receipt, decline + retry with
// the same idempotency key, expired, and the privacy whitelist (no COGS/fee/margin).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const { apiRequest, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    code: string
    status: number
    details: Record<string, unknown> = {}
    constructor(status: number, code: string, message = code) {
      super(message)
      this.status = status
      this.code = code
    }
  }
  return { apiRequest: vi.fn(), ApiError }
})

vi.mock('vue-router', () => ({ useRoute: () => ({ params: { token: 'tok-abc' } }) }))
vi.mock('../../api/client', () => ({ apiRequest, ApiError }))

import Pay from './Pay.vue'

const sentView = {
  status: 'sent',
  patientFirstName: 'Cara',
  totalCents: 5998,
  items: [{ name: 'Magnesium Glycinate 120ct', qty: 2, unitPriceCents: 2999, lineTotalCents: 5998 }]
}

const posts = () => apiRequest.mock.calls.filter(([, o]) => o?.method === 'POST')

beforeEach(() => {
  apiRequest.mockReset()
})

describe('Pay - states', () => {
  it('payable: greets the patient, shows the total and one pay button', async () => {
    apiRequest.mockResolvedValue(sentView)
    const w = mount(Pay)
    await flushPromises()

    expect(apiRequest).toHaveBeenCalledWith('/pay/tok-abc', { auth: false })
    expect(w.find('h1').text()).toBe('Complete your payment')
    expect(w.text()).toContain('Hi Cara,')
    expect(w.find('[data-testid="pay-total"]').text()).toContain('$59.98')
    const buttons = w.findAll('[data-testid="pay-button"]')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].text()).toContain('Pay $59.98')
  })

  it('paying shows the receipt with amount and confirmation number', async () => {
    apiRequest.mockImplementation((_path: string, opts?: { method?: string }) =>
      Promise.resolve(opts?.method === 'POST' ? { paymentId: 'pay_123', status: 'paid', totalCents: 5998 } : sentView)
    )
    const w = mount(Pay)
    await flushPromises()
    await w.find('[data-testid="pay-button"]').trigger('click')
    await flushPromises()

    const [, opts] = posts()[0]
    expect(opts).toMatchObject({ method: 'POST', auth: false })
    expect(typeof opts.body.idempotencyKey).toBe('string')
    expect(w.find('h1').text()).toBe('Payment complete')
    const receipt = w.find('[data-testid="receipt"]')
    expect(receipt.text()).toContain('$59.98')
    expect(w.find('[data-testid="confirmation"]').text()).toBe('pay_123')
    expect(w.text()).toContain('Magnesium Glycinate 120ct')
    expect(w.find('[data-testid="pay-button"]').exists()).toBe(false)
  })

  it('a decline shows the notice and Try again, retrying with the same idempotency key', async () => {
    apiRequest.mockImplementation((_path: string, opts?: { method?: string }) =>
      opts?.method === 'POST' ? Promise.reject(new ApiError(402, 'PAYMENT_DECLINED')) : Promise.resolve(sentView)
    )
    const w = mount(Pay)
    await flushPromises()
    await w.find('[data-testid="pay-button"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="decline-notice"]').text()).toContain(
      'The payment was declined. Please check your payment details and try again.'
    )
    expect(w.find('[data-testid="decline-notice"]').attributes('role')).toBe('alert')
    expect(w.find('[data-testid="pay-button"]').text()).toContain('Try again')

    await w.find('[data-testid="pay-button"]').trigger('click')
    await flushPromises()
    const keys = posts().map(([, o]) => o.body.idempotencyKey)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })

  it('an expired order renders the expired title and message', async () => {
    apiRequest.mockResolvedValue({ ...sentView, status: 'expired' })
    const w = mount(Pay)
    await flushPromises()
    expect(w.find('h1').text()).toBe('This order has expired')
    expect(w.find('[data-testid="pay-message"]').text()).toContain('can no longer be paid')
    expect(w.find('[data-testid="pay-button"]').exists()).toBe(false)
  })

  it('an unexpected error offers a Retry that reloads', async () => {
    apiRequest.mockRejectedValueOnce(new ApiError(500, 'INTERNAL')).mockResolvedValueOnce(sentView)
    const w = mount(Pay)
    await flushPromises()
    expect(w.find('h1').text()).toBe('Something went wrong')
    await w.find('[data-testid="retry"]').trigger('click')
    await flushPromises()
    expect(w.find('h1').text()).toBe('Complete your payment')
  })

  it('never shows COGS, fee or margin in any state', async () => {
    const leak = /\bcogs\b|\bfees?\b|margin/i
    for (const status of ['sent', 'paid', 'expired', 'cancelled', 'refunded', 'draft']) {
      apiRequest.mockReset()
      apiRequest.mockResolvedValue({ ...sentView, status })
      const w = mount(Pay)
      await flushPromises()
      expect(w.text()).not.toMatch(leak)
      w.unmount()
    }
  })
})
