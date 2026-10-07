// @vitest-environment happy-dom
//
// Admin Metrics provider selection: the breakdown shows each provider's name AND full id
// (ids that share a long prefix stay distinguishable), Select scopes the whole report to
// that provider via ?providerId=, and "Show all providers" clears it. The dropdown does
// the same.
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
const BEN = 'aaaaaaaa-0000-0000-0000-000000000002'
const block = (gmv: number) => ({
  gmvCents: gmv, refundedGmvCents: 0, settledGmvCents: gmv, platformFeeCents: 66, sunkFeeCents: 0,
  providerNetMarginCents: 3596, providerNetAfterSunkFeesCents: 3596, orderCount: 1, aovCents: gmv,
  recurringGmvCents: 0, recurringShareBps: 0
})
const recon = { formulaCents: 3596, ledgerCents: 3596, diffCents: 0, toleranceCents: 1, pass: true }
const names = {
  [ANA]: { providerName: 'Dr. Ana Reyes', practiceName: 'Riverside Integrative' },
  [BEN]: { providerName: 'Dr. Ben Cole', practiceName: 'Summit DPC' }
}

function metricsFor(path: string) {
  const providerId = new URLSearchParams(path.split('?')[1]).get('providerId')
  const ids = providerId ? [providerId] : [ANA, BEN]
  return {
    period: { from: '2026-10-01', to: '2026-10-31' }, includeSynthetic: false, groupBy: 'provider',
    providerId: providerId ?? null,
    headline: block(providerId === BEN ? 52485 : 8812), reconciliation: recon,
    migration: { providers: [], overallInHouseGmvCents: 0, overallBaselineMonthlyGmvCents: 0, overallMigrationBps: null, adoptionBps: null, noBaselineProviderIds: [] },
    groups: ids.map((id) => ({ key: id, block: block(id === BEN ? 52485 : 8812), reconciliation: recon })),
    providerNames: names
  }
}

beforeEach(() => {
  apiRequest.mockReset()
  apiRequest.mockImplementation((path: string) => {
    if (path === '/admin/providers') {
      return Promise.resolve({ providers: [
        { id: ANA, name: 'Dr. Ana Reyes', practiceId: 'p1', practiceName: 'Riverside Integrative' },
        { id: BEN, name: 'Dr. Ben Cole', practiceId: 'p2', practiceName: 'Summit DPC' }
      ] })
    }
    if (path.startsWith('/admin/metrics')) return Promise.resolve(metricsFor(path))
    return Promise.resolve({})
  })
})

import Metrics from './Metrics.vue'

const metricCalls = () => apiRequest.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/admin/metrics'))

async function mountGrouped() {
  const w = mount(Metrics)
  await flushPromises()
  await w.find('[data-testid="metrics-group-by"]').setValue('provider')
  await flushPromises()
  return w
}

describe('Admin Metrics - provider selection', () => {
  it('shows each provider name with the FULL id, so similar ids stay distinct', async () => {
    const w = await mountGrouped()
    const ana = w.find(`[data-testid="group-row-${ANA}"]`).text()
    const ben = w.find(`[data-testid="group-row-${BEN}"]`).text()
    expect(ana).toContain('Dr. Ana Reyes')
    expect(ana).toContain(ANA)
    expect(ben).toContain('Dr. Ben Cole')
    expect(ben).toContain(BEN)
  })

  it('Select scopes the whole report to that provider, and Show all clears it', async () => {
    const w = await mountGrouped()
    await w.find(`[data-testid="select-provider-${BEN}"]`).trigger('click')
    await flushPromises()
    expect(metricCalls().at(-1)).toContain(`providerId=${BEN}`)
    const chip = w.find('[data-testid="provider-scope"]')
    expect(chip.text()).toContain('Dr. Ben Cole')
    expect(chip.text()).toContain(BEN)
    expect(w.find(`[data-testid="group-row-${ANA}"]`).exists()).toBe(false)
    expect(w.text()).toContain('$524.85')

    await w.find('[data-testid="clear-provider"]').trigger('click')
    await flushPromises()
    expect(metricCalls().at(-1)).not.toContain('providerId=')
    expect(w.find('[data-testid="provider-scope"]').exists()).toBe(false)
  })

  it('the Provider dropdown lists providers and scopes the report', async () => {
    const w = mount(Metrics)
    await flushPromises()
    const options = w.findAll('[data-testid="metrics-provider"] option').map((o) => o.text())
    expect(options).toEqual(['All providers', 'Dr. Ana Reyes - Riverside Integrative', 'Dr. Ben Cole - Summit DPC'])
    await w.find('[data-testid="metrics-provider"]').setValue(ANA)
    await flushPromises()
    expect(metricCalls().at(-1)).toContain(`providerId=${ANA}`)
  })
})
