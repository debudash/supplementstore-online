// EVAL-01..04b and EVAL-P1: the money core, exercised end to end through the provider
// order + quote HTTP surface (not by calling packages/money directly - the point is to
// prove the system computes the right split, ADR-003). Expected cents are verbatim from
// docs/EVALS.md and must never be edited to make a test pass (AGENTS.md section 4).
import { afterAll, beforeEach, describe, expect } from 'vitest'
import { asUser, db, evalCase, newDraft, resetState, PROV_ANA, SKU } from './_harness'
import { markupFor } from './_harness'

/** The order-level fee, rounded UP to the cent (ADR-001 as amended by ADR-028). */
function orderFee(subtotal: number, feeBps = 75): number {
  return Math.floor((subtotal * feeBps + 9999) / 10000)
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
  // ADR-028: the order is priced from markups and rounded ONCE. Markups 1526 + 1356 give the
  // brief's EVAL-01 order exactly (8497 / fee 64 / margin 4408 / line fees 45 + 19); the lines
  // split 5997 + 2500 and the provider nets exactly the markups (3052 + 1356).
  evalCase('EVAL-01', 'MAG x2 markup 1526 + VITD3 x1 markup 1356 -> order 8497, fee 64, margin 4408', async () => {
    const id = await newDraft()
    expect((await addLine(id, { sku: SKU.MAG, qty: 2, markupCents: 1526 })).status).toBe(200)
    expect((await addLine(id, { sku: SKU.VITD, qty: 1, markupCents: 1356 })).status).toBe(200)

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
    expect(mag).toMatchObject({ lineTotalCents: 5997, lineFeeCents: 45, lineMarginCents: 3052, lineCogsCents: 2900 })
    expect(vit).toMatchObject({ lineTotalCents: 2500, lineFeeCents: 19, lineMarginCents: 1356, lineCogsCents: 1125 })
    // Line fees sum to the order fee (AI-02: order-level allocation, not per-line rounding).
    expect(mag.lineFeeCents + vit.lineFeeCents).toBe(64)
  })

  evalCase('EVAL-02', 'OMEGA3 x1@4999 -> fee 38 (37.49 rounded up), margin 2681', async () => {
    const id = await newDraft()
    expect((await addLine(id, { sku: SKU.OMEGA, qty: 1, markupCents: markupFor(SKU.OMEGA, 4999) })).status).toBe(200)
    const q = await quote(id)
    expect(q.body.totals.feeCents).toBe(38)
    expect(q.body.totals.marginCents).toBe(2681)
    expect(q.body.lines[0].lineMarginCents).toBe(2681)
  })

  evalCase('EVAL-03', 'VITD3 x1@2200 -> fee 17 (16.5 rounded up), margin 1058', async () => {
    const id = await newDraft()
    expect((await addLine(id, { sku: SKU.VITD, qty: 1, markupCents: markupFor(SKU.VITD, 2200) })).status).toBe(200)
    const q = await quote(id)
    // 16.5 rounds UP to 17.
    expect(q.body.totals.feeCents).toBe(17)
    expect(q.body.totals.marginCents).toBe(1058)
  })

  // ADR-028: the split still enforces the floor (packages/money EVAL-04 @1125/@1133 rejected,
  // @1134 margin 0); an order priced from markups rounds once, so a $0 markup nets exactly 0.
  evalCase('EVAL-04', 'VITD3 margin floor: markup 0 -> price 1134 (cost + fee), margin exactly 0', async () => {
    const id = await newDraft()
    const r = await addLine(id, { sku: SKU.VITD, qty: 1, markupCents: 0 })
    expect(r.status).toBe(200)
    expect(r.body.lines[0].unitPriceCents).toBe(1134)
    const q = await quote(id)
    expect(q.body.lines[0]).toMatchObject({ lineFeeCents: 9, lineMarginCents: 0 })
  })

  evalCase('EVAL-04b', 'MAG markup 1000 -> unit price 2469, fee 19, margin 1000', async () => {
    const id = await newDraft()
    const r = await addLine(id, { sku: SKU.MAG, qty: 1, markupCents: 1000 })
    expect(r.status).toBe(200)
    expect(r.body.lines[0]).toMatchObject({ unitPriceCents: 2469, unitMarkupCents: 1000 })
    const q = await quote(id)
    expect(q.body.lines[0]).toMatchObject({ lineFeeCents: 19, lineMarginCents: 1000 })
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
          const r = await addLine(id, { sku: b.sku, qty: b.qty, markupCents: markupFor(b.sku, b.price) })
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
