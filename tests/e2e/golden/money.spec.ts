// EVAL-01..04b and EVAL-P1: the money core, exercised end to end through the provider
// order + quote HTTP surface (not by calling packages/money directly - the point is to
// prove the system computes the right split, ADR-003). Expected cents are verbatim from
// docs/EVALS.md and must never be edited to make a test pass (AGENTS.md section 4).
import { afterAll, beforeEach, describe, expect } from 'vitest'
import { asUser, db, evalCase, newDraft, resetState, PROV_ANA, SKU } from './_harness'

/** The order-level fee, half-up, from docs/ARCHITECTURE.md section 4. */
function orderFee(subtotal: number, feeBps = 75): number {
  return Math.floor((subtotal * feeBps + 5000) / 10000)
}

async function addLine(orderId: string, body: object) {
  return asUser(PROV_ANA).post(`/api/orders/${orderId}/lines`).send(body)
}
async function quote(orderId: string) {
  return asUser(PROV_ANA).get(`/api/orders/${orderId}/quote`)
}

beforeEach(async () => {
  await resetState()
})
afterAll(async () => {
  await db.destroy()
})

describe('money core (golden)', () => {
  evalCase('EVAL-01', 'MAG x2@2999 + VITD3 x1@2499 split', async () => {
    const id = await newDraft()
    expect((await addLine(id, { sku: SKU.MAG, qty: 2, unitPriceCents: 2999 })).status).toBe(200)
    expect((await addLine(id, { sku: SKU.VITD, qty: 1, unitPriceCents: 2499 })).status).toBe(200)

    const q = await quote(id)
    expect(q.status).toBe(200)
    expect(q.body.totals).toMatchObject({
      subtotalCents: 8497,
      cogsCents: 4025,
      feeCents: 64,
      marginCents: 4408
    })
    const mag = q.body.lines.find((l: { sku: string }) => l.sku === SKU.MAG)
    const vit = q.body.lines.find((l: { sku: string }) => l.sku === SKU.VITD)
    expect(mag).toMatchObject({ lineFeeCents: 45, lineMarginCents: 3053, lineCogsCents: 2900 })
    expect(vit).toMatchObject({ lineFeeCents: 19, lineMarginCents: 1355, lineCogsCents: 1125 })
    // Line fees sum to the order fee (AI-02: order-level allocation, not per-line rounding).
    expect(mag.lineFeeCents + vit.lineFeeCents).toBe(64)
  })

  evalCase('EVAL-02', 'OMEGA3 x1@4999 -> fee 37, margin 2682', async () => {
    const id = await newDraft()
    expect((await addLine(id, { sku: SKU.OMEGA, qty: 1, unitPriceCents: 4999 })).status).toBe(200)
    const q = await quote(id)
    expect(q.body.totals.feeCents).toBe(37)
    expect(q.body.totals.marginCents).toBe(2682)
    expect(q.body.lines[0].lineMarginCents).toBe(2682)
  })

  evalCase('EVAL-03', 'VITD3 x1@2200 half-up -> fee 17, margin 1058', async () => {
    const id = await newDraft()
    expect((await addLine(id, { sku: SKU.VITD, qty: 1, unitPriceCents: 2200 })).status).toBe(200)
    const q = await quote(id)
    // 16.5 rounds UP to 17 (half-up).
    expect(q.body.totals.feeCents).toBe(17)
    expect(q.body.totals.marginCents).toBe(1058)
  })

  evalCase('EVAL-04', 'VITD3 margin floor: @1125 and @1132 rejected, @1133 margin 0', async () => {
    const d1 = await newDraft()
    const r1 = await addLine(d1, { sku: SKU.VITD, qty: 1, unitPriceCents: 1125 })
    expect(r1.status).toBe(422)
    expect(r1.body.error.code).toBe('MARGIN_NEGATIVE')

    const d2 = await newDraft()
    const r2 = await addLine(d2, { sku: SKU.VITD, qty: 1, unitPriceCents: 1132 })
    expect(r2.status).toBe(422)
    expect(r2.body.error.code).toBe('MARGIN_NEGATIVE')

    const d3 = await newDraft()
    const r3 = await addLine(d3, { sku: SKU.VITD, qty: 1, unitPriceCents: 1133 })
    expect(r3.status).toBe(200)
    const q = await quote(d3)
    expect(q.body.lines[0].lineMarginCents).toBe(0)
  })

  evalCase('EVAL-04b', 'MAG marginBps 5000 -> unit price 2900', async () => {
    const id = await newDraft()
    const r = await addLine(id, { sku: SKU.MAG, qty: 1, marginBps: 5000 })
    expect(r.status).toBe(200)
    expect(r.body.lines[0].unitPriceCents).toBe(2900)
  })

  // EVAL-P1: property check driven through the API. fast-check is a packages/money dev
  // dependency and is intentionally NOT added to the e2e suite (strict npm ci, no new
  // deps); instead we drive a deterministic, seeded batch of random baskets through the
  // real quote endpoint and assert the invariants hold every time:
  //   - line fees sum to the order fee (allocation, not per-line rounding)
  //   - each line: cogs + fee + margin = total; margin >= 0
  //   - order fee = half-up of subtotal x 0.0075
  //   - allocation is deterministic (same basket -> same split twice)
  evalCase('EVAL-P1', 'property: fee allocation + invariants over seeded random baskets', async () => {
    // Small deterministic LCG so the run is reproducible (seed fixed).
    let state = 123456789
    const rnd = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff

    // Use SKUs with ample stock; qty small so add-time stock checks always pass (no send).
    const catalog = [
      { sku: SKU.MAG, cogs: 1450 },
      { sku: SKU.VITD, cogs: 1125 },
      { sku: SKU.OMEGA, cogs: 2280 }
    ]

    // Enough cases to exercise the allocation across varied baskets without making the
    // suite slow; the determinism rebuild (below) is limited to the first few to keep the
    // HTTP volume - and wall-clock - bounded on a loaded CI runner.
    const CASES = 24
    for (let c = 0; c < CASES; c++) {
      const nLines = 1 + Math.floor(rnd() * catalog.length) // 1..3 distinct SKUs
      const chosen = [...catalog].sort(() => rnd() - 0.5).slice(0, nLines)
      const basket = chosen.map((p) => {
        const qty = 1 + Math.floor(rnd() * 4) // 1..4
        // price comfortably above cogs so no line hits the margin floor.
        const price = p.cogs + 300 + Math.floor(rnd() * 6000)
        return { sku: p.sku, qty, price }
      })

      const build = async () => {
        const id = await newDraft()
        for (const b of basket) {
          const r = await addLine(id, { sku: b.sku, qty: b.qty, unitPriceCents: b.price })
          expect(r.status, `add ${b.sku} case ${c}`).toBe(200)
        }
        return (await quote(id)).body
      }

      const q = await build()
      const subtotal = q.totals.subtotalCents
      expect(q.totals.feeCents).toBe(orderFee(subtotal))

      let feeSum = 0
      for (const line of q.lines) {
        expect(line.lineCogsCents + line.lineFeeCents + line.lineMarginCents).toBe(line.lineTotalCents)
        expect(line.lineMarginCents).toBeGreaterThanOrEqual(0)
        feeSum += line.lineFeeCents
      }
      expect(feeSum, `line fees sum to order fee, case ${c}`).toBe(q.totals.feeCents)

      // Deterministic: an identical basket yields an identical split. Checked on the
      // first few cases only (rebuilding every basket twice doubles the HTTP volume).
      if (c < 6) {
        const q2 = await build()
        expect(q2.totals).toMatchObject(q.totals)
        expect(q2.lines.map((l: { lineFeeCents: number }) => l.lineFeeCents)).toEqual(
          q.lines.map((l: { lineFeeCents: number }) => l.lineFeeCents)
        )
      }
    }
  }, 120_000)
})
