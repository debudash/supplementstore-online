// @vitest-environment happy-dom
//
// The migration leading indicator: the card shows migration month by month (server
// figures only), labels a multi-month headline as the monthly average, adds a per-provider
// trend, and the "Last 3 months" preset asks the server for that range.
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

const ANA = 'aaaaaaaa-0000-0000-0000-000000000001'
const block = {
  gmvCents: 0, refundedGmvCents: 0, settledGmvCents: 0, platformFeeCents: 0, sunkFeeCents: 0,
  providerNetMarginCents: 0, providerNetAfterSunkFeesCents: 0, providerMarkupCents: 0, markupUnits: 0,
  avgMarkupPerUnitCents: 0, orderCount: 0, aovCents: 0, recurringGmvCents: 0, recurringShareBps: 0
}
const month = (m: string, inHouse: number, bps: number) => ({ month: m, inHouseGmvCents: inHouse, migrationBps: bps })
const metrics = {
  period: { from: '2026-08-01', to: '2026-10-31' },
  includeSynthetic: true,
  groupBy: 'none',
  providerId: null,
  headline: block,
  reconciliation: { formulaCents: 0, ledgerCents: 0, diffCents: 0, toleranceCents: 0, pass: true },
  migration: {
    months: 3,
    providers: [{
      providerId: ANA, baselineMonthlyGmvCents: 100000, inHouseGmvCents: 71000, migrationBps: 2366, adopted: true,
      byMonth: [month('2026-08', 10000, 1000), month('2026-09', 18000, 1800), month('2026-10', 43000, 4300)]
    }],
    overallInHouseGmvCents: 71000,
    overallBaselineMonthlyGmvCents: 100000,
    overallMigrationBps: 2366,
    byMonth: [month('2026-08', 10000, 1000), month('2026-09', 18000, 1800), month('2026-10', 43000, 4300)],
    adoptionBps: 10000,
    noBaselineProviderIds: []
  },
  groups: [],
  providerNames: { [ANA]: { providerName: 'Dr. Ana Reyes', practiceName: 'Riverside Integrative' } }
}

beforeEach(() => {
  apiRequest.mockReset()
  apiRequest.mockImplementation((path: string) => {
    if (path === '/admin/providers') return Promise.resolve({ providers: [] })
    if (path.startsWith('/admin/metrics')) return Promise.resolve(metrics)
    return Promise.resolve({})
  })
})

import Metrics from './Metrics.vue'

describe('Admin Metrics - migration leading indicator', () => {
  it('shows migration by month, the monthly average headline and a per-provider trend', async () => {
    const w = mount(Metrics)
    await flushPromises()
    const months = w.findAll('[data-testid="migration-month"]').map((li) => li.text())
    expect(months).toHaveLength(3)
    expect(months[0]).toContain('Aug 2026')
    expect(months[0]).toContain('10%')
    expect(months[2]).toContain('Oct 2026')
    expect(months[2]).toContain('43%')
    expect(w.text()).toContain('Average monthly migration')
    expect(w.text()).toContain('over 3 months')
    expect(w.find('[data-testid="provider-trend"]').text()).toBe('10% → 18% → 43%')
  })

  it('"Last 3 months" asks the server for the last three calendar months', async () => {
    const w = mount(Metrics)
    await flushPromises()
    apiRequest.mockClear()
    await w.find('[data-testid="range-last-3"]').trigger('click')
    await flushPromises()
    const call = apiRequest.mock.calls.map(([p]) => String(p)).find((p) => p.startsWith('/admin/metrics'))
    expect(call).toBeTruthy()
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1))
    const from = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-01`
    expect(call).toContain(`from=${from}`)
  })
})
