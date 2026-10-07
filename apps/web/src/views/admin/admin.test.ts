// @vitest-environment happy-dom
//
// Cerbo Admin views after the UX overhaul:
//  - Metrics shows the "Demo data included" banner only while the synthetic switch is on.
//  - Operations: a refund cannot be confirmed without a reason, and sends { reasonCode }.
//  - Demo data: reset requires typing RESET in the confirmation.
//  - Payables: closing a month goes through a confirmation first.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }))

vi.mock('../../api/client', () => {
  class ApiError extends Error {
    code = 'ERR'
    status = 500
    details = {}
  }
  return { apiRequest, ApiError }
})

const block = {
  gmvCents: 100000, refundedGmvCents: 0, settledGmvCents: 100000, platformFeeCents: 750,
  sunkFeeCents: 0, providerNetMarginCents: 40000, providerNetAfterSunkFeesCents: 40000,
  orderCount: 4, aovCents: 25000, recurringGmvCents: 0, recurringShareBps: 0
}
const recon = { formulaCents: 40000, ledgerCents: 40000, diffCents: 0, toleranceCents: 4, pass: true }
const metrics = (includeSynthetic: boolean) => ({
  period: { from: '2026-10-01', to: '2026-10-31' },
  includeSynthetic,
  groupBy: 'none',
  headline: block,
  reconciliation: recon,
  migration: {
    providers: [], overallInHouseGmvCents: 0, overallBaselineMonthlyGmvCents: 0,
    overallMigrationBps: null, adoptionBps: null, noBaselineProviderIds: []
  },
  groups: []
})

const auditOrder = {
  id: 'ord-1', status: 'paid', kind: 'one_time', providerId: 'prov-1', practiceId: 'pr-1',
  patientId: 'pat-1', feeBps: 75, subtotalCents: 5998, cogsCents: 2900, feeCents: 45, marginCents: 3053,
  isSynthetic: false, createdAt: '2026-10-01T00:00:00Z', sentAt: '2026-10-01T00:00:00Z',
  paidAt: '2026-10-02T00:00:00Z', fulfilledAt: null, cancelledAt: null, expiredAt: null,
  refundedAt: null, payToken: null, payPath: null
}

beforeEach(() => {
  apiRequest.mockReset()
  apiRequest.mockImplementation((path: string, opts?: { method?: string; body?: unknown }) => {
    if (path.startsWith('/admin/metrics')) return Promise.resolve(metrics(path.includes('includeSynthetic=true')))
    if (path.endsWith('/audit')) {
      return Promise.resolve({
        order: auditOrder, lines: [], statusHistory: [], payments: [], refunds: [], journals: [],
        inventoryMovements: [], invariants: { ok: true, checks: [] }
      })
    }
    if (path.endsWith('/refund') && opts?.method === 'POST') {
      return Promise.resolve({
        refundId: 'r1', orderId: 'ord-1', status: 'refunded', reasonCode: (opts.body as { reasonCode: string }).reasonCode,
        amountCents: 5998, feeRetainedCents: 45, restocked: true, writeoffCogsCents: 0
      })
    }
    if (path === '/admin/demo/reset') {
      return Promise.resolve({
        purged: {
          ledgerEntries: 8, journals: 2, payments: 1, refunds: 0, orderEvents: 3, orderLines: 2,
          orders: 1, baselineOrders: 5, baselineImports: 1, inventoryMovements: 2
        }
      })
    }
    if (path.startsWith('/admin/payables?')) {
      return Promise.resolve({
        month: '2026-09', periodStart: '2026-09-01', periodEnd: '2026-09-30', closed: false,
        statements: [
          { id: 's1', providerId: 'prov-1', practiceId: 'pr-1', periodStart: '2026-09-01', periodEnd: '2026-09-30',
            openingCents: 0, creditsCents: 3053, debitsCents: 0, closingCents: 3053, closedAt: '', closedBy: null },
          { id: 's2', providerId: 'prov-2', practiceId: 'pr-2', periodStart: '2026-09-01', periodEnd: '2026-09-30',
            openingCents: 0, creditsCents: 1000, debitsCents: 45, closingCents: 955, closedAt: '', closedBy: null }
        ]
      })
    }
    if (path === '/admin/payables/close') {
      return Promise.resolve({ month: '2026-09', periodStart: '2026-09-01', periodEnd: '2026-09-30', statements: [] })
    }
    return Promise.resolve({})
  })
})

import Metrics from './Metrics.vue'
import Operations from './Operations.vue'
import DemoData from './DemoData.vue'
import Payables from './Payables.vue'

const posts = () => apiRequest.mock.calls.filter(([, o]) => o?.method === 'POST')

describe('Admin metrics', () => {
  it('shows the "Demo data included" banner only while the synthetic switch is on', async () => {
    const w = mount(Metrics)
    await flushPromises()
    expect(w.find('[data-testid="demo-data-banner"]').exists()).toBe(false)

    await w.find('[data-testid="include-synthetic"]').setValue(true)
    await flushPromises()
    const banner = w.find('[data-testid="demo-data-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('Demo data included')
    expect(apiRequest.mock.calls.some(([p]) => String(p).includes('includeSynthetic=true'))).toBe(true)

    await w.find('[data-testid="include-synthetic"]').setValue(false)
    await flushPromises()
    expect(w.find('[data-testid="demo-data-banner"]').exists()).toBe(false)
  })
})

describe('Admin operations - refund', () => {
  async function lookedUp() {
    const w = mount(Operations)
    await w.find('[data-testid="order-id-input"]').setValue('ord-1')
    await w.find('[data-testid="order-lookup"]').trigger('submit')
    await flushPromises()
    expect(apiRequest).toHaveBeenCalledWith('/admin/orders/ord-1/audit')
    return w
  }

  it('cannot open the refund confirmation without a reason', async () => {
    const w = await lookedUp()
    expect((w.find('[data-testid="refund-reason"]').element as HTMLSelectElement).value).toBe('')
    await w.find('[data-testid="refund-open"]').trigger('click')
    expect(w.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
    expect(w.text()).toContain('Choose a reason before refunding.')
    expect(posts()).toHaveLength(0)
  })

  it('sends { reasonCode } only after confirming', async () => {
    const w = await lookedUp()
    await w.find('[data-testid="refund-reason"]').setValue('damaged')
    await w.find('[data-testid="refund-open"]').trigger('click')
    const dialog = w.find('[data-testid="confirm-dialog"]')
    expect(dialog.text()).toContain('Refunds $59.98 to the patient in full. The 0.75% platform fee is kept. This cannot be undone.')
    expect(posts()).toHaveLength(0)

    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(apiRequest).toHaveBeenCalledWith('/admin/orders/ord-1/refund', { method: 'POST', body: { reasonCode: 'damaged' } })
    expect(w.find('[data-testid="action-result"]').text()).toContain('Damaged')
  })
})

describe('Admin demo data - reset', () => {
  it('requires typing RESET before the reset is sent', async () => {
    const w = mount(DemoData)
    await w.find('[data-testid="demo-reset"]').trigger('click')
    const ok = w.find('[data-testid="confirm-ok"]')
    expect((ok.element as HTMLButtonElement).disabled).toBe(true)

    await w.find('[data-testid="confirm-require-input"]').setValue('reset')
    expect((ok.element as HTMLButtonElement).disabled).toBe(true)

    await w.find('[data-testid="confirm-require-input"]').setValue('RESET')
    expect((ok.element as HTMLButtonElement).disabled).toBe(false)
    expect(posts()).toHaveLength(0)

    await ok.trigger('click')
    await flushPromises()
    expect(apiRequest).toHaveBeenCalledWith('/admin/demo/reset', { method: 'POST', body: {} })
    expect(w.find('[data-testid="demo-result"]').text()).toContain('Synthetic data reset')
  })
})

describe('Admin payables - close month', () => {
  it('confirms with the provider count before closing', async () => {
    const w = mount(Payables)
    await flushPromises()
    await w.find('[data-testid="payables-close"]').trigger('click')
    expect(posts()).toHaveLength(0)
    expect(w.find('[data-testid="confirm-dialog"]').text()).toContain('Creates immutable statements for 2 providers. This cannot be undone.')

    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(posts()).toHaveLength(1)
    expect(apiRequest.mock.calls.find(([p]) => p === '/admin/payables/close')?.[1]).toMatchObject({ method: 'POST' })
  })

  it('warns when the month is still in progress', async () => {
    const w = mount(Payables)
    await flushPromises()
    await w.find('[data-testid="payables-close"]').trigger('click')
    // The default month is the current UTC month.
    expect(w.find('[data-testid="close-in-progress"]').text()).toContain('This month is still in progress')
  })
})
