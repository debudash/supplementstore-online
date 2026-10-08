// @vitest-environment happy-dom
//
// Order audit view: renders the summary strip and tabs from the server's audit payload.
// The ledger shows Debit / Credit columns and the server's balanced flag; a failed
// invariant check shows a fail badge with a readable name and formatted detail.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const { apiRequest, push } = vi.hoisted(() => ({ apiRequest: vi.fn(), push: vi.fn() }))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'o1' }, query: {} }),
  useRouter: () => ({ push })
}))
vi.mock('../../api/client', () => {
  class ApiError extends Error {
    code = 'ERR'
    status = 500
    details = {}
    constructor(message: string, status = 500) {
      super(message)
      this.status = status
    }
  }
  return { apiRequest, ApiError }
})

import OrderAudit from './OrderAudit.vue'
import { ApiError } from '../../api/client'

const audit = {
  order: {
    id: 'o1', status: 'paid', kind: 'one_time', providerId: 'pr1', practiceId: 'pc1', patientId: 'p1', feeBps: 75,
    subtotalCents: 5997, cogsCents: 2900, feeCents: 45, marginCents: 3052, markupCents: 3052, isSynthetic: false,
    createdAt: '2026-10-06T12:00:00.000Z', sentAt: '2026-10-06T12:05:00.000Z', paidAt: '2026-10-06T13:00:00.000Z',
    fulfilledAt: null, cancelledAt: null, expiredAt: null, refundedAt: null, payToken: null, payPath: null
  },
  lines: [
    {
      id: 'l1', position: 1, sku: 'MAG-GLY-120', name: 'Magnesium Glycinate 120ct', qty: 2, unitPriceCents: 2999,
      unitCogsCents: 1450, unitMarkupCents: 1526, lineTotalCents: 5997, lineCogsCents: 2900, lineFeeCents: 45, lineMarginCents: 3052,
      lineMarkupCents: 3052, unitPriceIsAverage: true
    }
  ],
  statusHistory: [
    { fromStatus: null, toStatus: 'draft', actorUserId: 'u1', at: '2026-10-06T12:00:00.000Z', note: null },
    { fromStatus: 'draft', toStatus: 'sent', actorUserId: 'u1', at: '2026-10-06T12:05:00.000Z', note: 'sent to patient' }
  ],
  payments: [],
  refunds: [],
  journals: [
    {
      id: 'j1', type: 'PAYMENT', refId: null, isSynthetic: false, postedAt: '2026-10-06T13:00:00.000Z',
      entries: [
        { id: 1, account: 'CASH_CLEARING', lineId: null, amountCents: 5997, memo: null },
        { id: 2, account: 'PROVIDER_PAYABLE', lineId: 'l1', amountCents: -3052, memo: null },
        { id: 3, account: 'COGS_RECOVERY', lineId: 'l1', amountCents: -2900, memo: null },
        { id: 4, account: 'PLATFORM_FEE_REVENUE', lineId: 'l1', amountCents: -45, memo: null }
      ],
      entrySumCents: 0,
      sumsToZero: true
    }
  ],
  inventoryMovements: [],
  invariants: {
    ok: false,
    checks: [
      { name: 'order.split_balances', pass: true, detail: { subtotal: 5997, cogs: 2900, fee: 45, margin: 3052 } },
      { name: 'order.margin_nonnegative', pass: false, detail: { margin: -120 } }
    ]
  }
}

beforeEach(() => {
  apiRequest.mockReset()
  apiRequest.mockImplementation((path: string) => {
    if (path === '/orders/o1/audit') return Promise.resolve(audit)
    if (path.startsWith('/patients')) return Promise.resolve({ patients: [{ id: 'p1', name: 'Cara Lopez' }] })
    return Promise.resolve({})
  })
})

describe('OrderAudit', () => {
  it('renders the header, summary strip and all tabs', async () => {
    const w = mount(OrderAudit)
    await flushPromises()
    expect(w.find('h1').text()).toBe('Order for Cara Lopez')
    expect(w.find('[data-test="invariants-overall"]').text()).toContain('1 check failed')
    for (const id of ['split', 'ledger', 'timeline', 'payments', 'stock', 'checks']) {
      expect(w.find(`[data-testid="tab-${id}"]`).exists()).toBe(true)
    }
    // Money split totals come from the order fields.
    const splitFoot = w.findAll('tfoot').at(-1)!
    expect(splitFoot.text()).toContain('$59.97')
    expect(splitFoot.text()).toContain('$30.52')
  })

  it('names every cent: cost + fee + markup = what the patient paid', async () => {
    const w = mount(OrderAudit)
    await flushPromises()
    const cents = w.find('[data-testid="every-cent"]')
    expect(cents.exists()).toBe(true)
    const text = cents.text()
    for (const part of ['Cost of goods', '$29.00', 'Platform fee (0.75% of the order, rounded up to the cent)', '$0.45', 'Provider markup (exactly as entered)', '$30.52', 'Patient paid', '$59.97']) {
      expect(text).toContain(part)
    }
    // Rounded once (ADR-028): no rounding is left over, so there is no rounding row.
    expect(cents.text()).not.toContain('rounding $')
    expect(w.find('[data-test="audit-rounding"]').exists()).toBe(false)
    expect(w.find('[data-test="audit-markup"]').text()).toContain('2 × $15.26')
  })

  it('shows a journal with Debit and Credit columns and a Balanced badge', async () => {
    const w = mount(OrderAudit)
    await flushPromises()
    await w.find('[data-testid="tab-ledger"]').trigger('click')
    const journal = w.find('[data-testid="journal"]')
    const headers = journal.findAll('th').map((th) => th.text())
    expect(headers).toContain('Debit')
    expect(headers).toContain('Credit')
    expect(journal.find('[data-test="journal-sum"]').text()).toContain('Balanced')
    // A negative entry is shown unsigned in the Credit column.
    const payableRow = journal.findAll('tbody tr')[1]
    const cells = payableRow.findAll('td')
    expect(cells[3].text()).toBe('')
    expect(cells[4].text()).toBe('$30.52')
  })

  it('shows a failed check with a fail badge, a readable name and formatted detail', async () => {
    const w = mount(OrderAudit)
    await flushPromises()
    await w.find('[data-testid="tab-checks"]').trigger('click')
    const checks = w.findAll('[data-testid="check"]')
    expect(checks).toHaveLength(2)
    const failed = checks[1]
    expect(failed.find('[data-testid="check-result"]').text()).toContain('Fail')
    expect(failed.find('[data-testid="check-result"]').classes()).toContain('badge-danger')
    expect(failed.text()).toContain('Order margin is not negative')
    expect(failed.text()).toContain('-$1.20')
    expect(failed.text()).not.toContain('{')
  })

  it('shows a friendly not-found state on 404', async () => {
    apiRequest.mockImplementation(() => Promise.reject(new (ApiError as unknown as new (m: string, s: number) => Error)('Not found', 404)))
    const w = mount(OrderAudit)
    await flushPromises()
    expect(w.find('[data-testid="audit-not-found"]').text()).toContain('Order not found')
  })
})
