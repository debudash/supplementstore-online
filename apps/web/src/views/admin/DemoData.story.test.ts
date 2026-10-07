// @vitest-environment happy-dom
//
// Demo data: the one-click "Reset demo story" requires typing RESET, then POSTs
// /admin/demo/reset-story (no body) and shows the purged / generated counts.
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

import DemoData from './DemoData.vue'

const storyResult = {
  story: { baselineSeed: 7, baselineMonths: 6, migrationSeed: 7, migrationMonths: 3 },
  reset: {
    purged: {
      ledgerEntries: 40, journals: 10, payments: 5, refunds: 0, orderEvents: 15, orderLines: 9,
      orders: 5, baselineOrders: 30, baselineImports: 1, inventoryMovements: 9
    }
  },
  baseline: { importBatchId: 'b1', seed: 7, months: 6, insertedCount: 36, replacedCount: 0 },
  migration: { seed: 7, months: 3, orderCount: 42, gmvCents: 1234567 }
}

beforeEach(() => {
  apiRequest.mockReset()
  apiRequest.mockImplementation((path: string) =>
    path === '/admin/demo/reset-story' ? Promise.resolve(storyResult) : Promise.resolve({})
  )
})

describe('Admin demo data - reset demo story', () => {
  it('requires typing RESET, then POSTs reset-story and shows the counts', async () => {
    const w = mount(DemoData)
    await w.find('[data-testid="demo-story-reset"]').trigger('click')

    const dialog = w.find('[data-testid="confirm-dialog"]')
    expect(dialog.text()).toContain('regenerates the standard demo story')
    const ok = w.find('[data-testid="confirm-ok"]')
    expect((ok.element as HTMLButtonElement).disabled).toBe(true)

    await w.find('[data-testid="confirm-require-input"]').setValue('RESET')
    expect((ok.element as HTMLButtonElement).disabled).toBe(false)
    expect(apiRequest).not.toHaveBeenCalled()

    await ok.trigger('click')
    await flushPromises()
    expect(apiRequest).toHaveBeenCalledWith('/admin/demo/reset-story', { method: 'POST' })

    const result = w.find('[data-testid="demo-story-result"]')
    expect(result.exists()).toBe(true)
    expect(w.find('[data-testid="story-purged-orders"]').text()).toBe('5')
    expect(w.find('[data-testid="story-baseline-rows"]').text()).toBe('36')
    expect(w.find('[data-testid="story-orders"]').text()).toBe('42')
    expect(w.find('[data-testid="story-gmv"]').text()).toBe('$12,345.67')
  })
})
