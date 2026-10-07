// @vitest-environment happy-dom
//
// Admin evidence page: the all-pass banner for a clean payload, the loss callout with
// the break-even fee when Cerbo loses money per order, and Apply converting the typed
// percent "2.5" into processingRateBps=250 with integer math.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { EvidenceResponse } from '@cerbo/contracts'

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }))

vi.mock('../../api/client', () => {
  class ApiError extends Error {
    code = 'ERR'
    status = 500
    details = {}
  }
  return { apiRequest, ApiError }
})

import Evidence from './Evidence.vue'

function payload(perOrderNet = 12, breakevenFeeBps: number | null = null): EvidenceResponse {
  return {
    generatedAt: '2026-10-07T12:00:00Z',
    includeSynthetic: false,
    integrity: {
      journals: { total: 20, unbalanced: 0 },
      orders: { checked: 10, passing: 10, failing: 0, capped: false, failures: [] },
      stock: { issues: [] },
      guards: { expected: 6, present: 6, missing: [] },
      reconciliation: { formulaCents: 40000, ledgerCents: 40000, diffCents: 0, toleranceCents: 10, pass: true }
    },
    unitEconomics: {
      assumptions: { processingRateBps: 290, processingFixedCents: 30, platformFeeBps: 75 },
      orderCount: 10,
      gmvCents: 60000,
      platformFeeCents: 450,
      processingCostCents: 2040,
      cerboNetCents: perOrderNet * 10,
      perOrder: { aovCents: 6000, platformFeeCents: 45, processingCostCents: 204, cerboNetCents: perOrderNet },
      breakevenFeeBps
    },
    refundExposure: {
      refundCount: 1,
      paidOrderCount: 10,
      refundRateBps: 1000,
      refundedCents: 6000,
      feeRetainedCents: 45,
      cogsWrittenOffCents: 0,
      restockedCount: 1,
      writtenOffCount: 0,
      byReason: [{ reasonCode: 'patient_request', count: 1, amountCents: 6000 }],
      cerboNetAfterWriteoffsCents: -1590
    }
  }
}

let current: EvidenceResponse
const evidenceCalls = () => apiRequest.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/admin/evidence'))

beforeEach(() => {
  current = payload()
  apiRequest.mockReset()
  apiRequest.mockImplementation(() => Promise.resolve(current))
})

describe('Admin evidence', () => {
  it('renders the all-pass banner for a clean payload', async () => {
    const w = mount(Evidence)
    await flushPromises()
    expect(w.find('[data-testid="evidence-banner"]').text()).toContain('All checks pass')
    expect(w.findAll('.badge-success')).toHaveLength(5)
    expect(w.find('[data-testid="check-orders"]').text()).toContain('10 of 10 orders pass')
    expect(w.text()).toContain('Patient request')
    expect(w.find('[data-testid="evidence-callout"]').text()).toContain('Cerbo nets $0.12 per average order after processing.')
  })

  it('shows the loss callout with the break-even fee when net per order is negative', async () => {
    current = payload(-159, 340)
    const w = mount(Evidence)
    await flushPromises()
    const callout = w.find('[data-testid="evidence-callout"]').text()
    expect(callout).toContain('At 2.9% + $0.30 per charge, Cerbo loses $1.59 on an average order.')
    expect(callout).toContain('Break-even platform fee: 3.4%.')
    expect(w.text()).toContain('Raise the platform fee toward 3.4%')
  })

  it('Apply sends processingRateBps=250 when 2.5 is typed', async () => {
    const w = mount(Evidence)
    await flushPromises()
    await w.find('[data-testid="evidence-rate"]').setValue('2.5')
    expect((w.find('[data-testid="evidence-apply"]').element as HTMLButtonElement).disabled).toBe(false)
    await w.find('form').trigger('submit')
    await flushPromises()
    const last = evidenceCalls().at(-1) ?? ''
    expect(last).toContain('processingRateBps=250')
    expect(last).toContain('processingFixedCents=30')
  })
})
