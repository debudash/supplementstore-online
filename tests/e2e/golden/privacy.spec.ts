// EVAL-12: the patient pay view is a strict field whitelist - no provider economics
// (cogs, fee, margin) ever cross the patient boundary (ADR-002, RT-10).
import { afterAll, beforeEach, describe, expect } from 'vitest'
import { anon, db, evalCase, resetState, sendOrderHttp, EVAL01_LINES } from './_harness'

beforeEach(async () => {
  await resetState()
})
afterAll(async () => {
  await db.destroy()
})

describe('privacy (golden)', () => {
  evalCase('EVAL-12', 'GET /api/pay/:token strict whitelist, no economics', async () => {
    const { token } = await sendOrderHttp(EVAL01_LINES)
    const res = await anon.get(`/api/pay/${token}`)
    expect(res.status).toBe(200)

    // Strict top-level key set.
    expect(Object.keys(res.body).sort()).toEqual(['items', 'patientFirstName', 'status', 'totalCents'])
    expect(res.body.totalCents).toBe(8497)
    expect(res.body.status).toBe('sent')
    expect(res.body.patientFirstName).toBe('Cara')

    // Strict per-item key set - no cogs/fee/margin.
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(['lineTotalCents', 'name', 'qty', 'unitPriceCents'])
    }

    // Nothing anywhere in the serialized payload mentions provider economics.
    const blob = JSON.stringify(res.body).toLowerCase()
    for (const leak of ['cogs', 'margin', 'fee', 'provider', 'practice']) {
      expect(blob).not.toContain(leak)
    }
  })
})
