// @vitest-environment happy-dom
//
// Provider reports and demo data: the Dashboard excludes demo orders by default and the
// "Include demo data" switch asks the server for them (with a banner); Payables always
// shows real money only and says so.
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

const sales = {
  period: { from: '2026-10-01', to: '2026-10-31' },
  includeSynthetic: false,
  gmvCents: 0,
  refundedGmvCents: 0,
  settledGmvCents: 0,
  platformFeeCents: 0,
  providerNetMarginCents: 0,
  unitsBySku: [],
  ordersByStatus: []
}

beforeEach(() => {
  apiRequest.mockReset()
  apiRequest.mockResolvedValue(sales)
})

import Dashboard from './Dashboard.vue'

describe('Dashboard - demo data', () => {
  it('excludes demo orders by default, and the switch requests them with a banner', async () => {
    const w = mount(Dashboard)
    await flushPromises()
    expect(String(apiRequest.mock.calls[0]?.[0])).not.toContain('includeSynthetic')
    expect(w.find('[data-testid="demo-data-banner"]').exists()).toBe(false)

    await w.find('[data-testid="include-synthetic"]').setValue(true)
    await flushPromises()
    expect(String(apiRequest.mock.calls.at(-1)?.[0])).toContain('includeSynthetic=true')
    expect(w.find('[data-testid="demo-data-banner"]').exists()).toBe(true)
  })
})
