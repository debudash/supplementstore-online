// Catalog and price-preview tests (ADR-028): there is no catalog list price - providers
// price each line with a per-unit markup - so GET /api/products carries cost and stock
// only, the seed keeps the protected seed facts (cogs, on_hand) and the 5-product
// invariant, and the price preview derives COGS + markup + fee on the server. Runs against
// real Postgres (DATABASE_URL); migrations via the tsx CLI in beforeAll (the proven
// pattern - db.migrate.latest() throws under vitest).
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { db } from '../../src/db/knex'
import { createApp } from '../../src/app'
import { createKnexActorLoader } from '../../src/auth/loadActor'
import { seedCore } from '../../src/db/seeds/01_core'

const apiRoot = path.resolve(__dirname, '../..')
function migrateViaCli(): void {
  execFileSync('npm', ['run', 'db:migrate'], { cwd: apiRoot, stdio: 'inherit', shell: process.platform === 'win32' })
}

const app = createApp({ db, loadActor: createKnexActorLoader(db) })
const asProvider = (url: string) => request(app).get(url).set('X-Demo-User', 'prov-ana')

// cogs/on_hand are the PROTECTED EVALS seed facts and must be unchanged.
const EXPECTED: Record<string, { cogs: number; onHand: number }> = {
  'MAG-GLY-120': { cogs: 1450, onHand: 50 },
  'VITD3-K2': { cogs: 1125, onHand: 40 },
  'OMEGA3-1000': { cogs: 2280, onHand: 30 },
  'PROBIO-50B': { cogs: 2675, onHand: 5 },
  'ZINC-30': { cogs: 690, onHand: 0 }
}

beforeAll(async () => {
  migrateViaCli()
  await seedCore(db)
})
afterAll(async () => {
  await db.destroy()
})

describe('catalog (ADR-028: no list price)', () => {
  it('seed is idempotent and leaves exactly 5 products with the protected seed facts', async () => {
    await seedCore(db)
    await seedCore(db)
    const [{ count }] = await db('products').count<{ count: string }[]>('* as count')
    expect(Number(count)).toBe(5)
    const rows = await db('products').select('sku', 'unit_cogs_cents', 'on_hand_qty')
    for (const r of rows) {
      const e = EXPECTED[r.sku]
      expect(e).toBeTruthy()
      expect(r.unit_cogs_cents).toBe(e.cogs)
      expect(r.on_hand_qty).toBe(e.onHand)
    }
  })

  it('GET /api/products returns cost and availability, and no list price or margin', async () => {
    const res = await asProvider('/api/products')
    expect(res.status).toBe(200)
    const products = res.body.products as Array<Record<string, unknown>>
    expect(products).toHaveLength(5)
    for (const p of products) {
      expect(Object.keys(p).sort()).toEqual(['active', 'available', 'name', 'sku', 'unitCogsCents'])
      expect(p.unitCogsCents).toBe(EXPECTED[p.sku as string].cogs)
    }
  })
})

describe('price preview (ADR-028)', () => {
  it('derives COGS + markup + fee for a quantity, with the split from the server', async () => {
    const res = await asProvider('/api/products/MAG-GLY-120/price-preview?markupCents=1000&qty=3')
    expect(res.status).toBe(200)
    // 2469 x 3 = 7407; fee half-up(7407 x 0.0075) = 56; margin 7407 - 4350 - 56 = 3001.
    expect(res.body).toEqual({
      sku: 'MAG-GLY-120',
      markupCents: 1000,
      unitPriceCents: 2469,
      qty: 3,
      lineTotalCents: 7407,
      lineCogsCents: 4350,
      lineFeeCents: 56,
      lineMarginCents: 3001
    })
  })

  it('markup 0 previews cost + fee with 1 cent of rounding headroom', async () => {
    const res = await asProvider('/api/products/MAG-GLY-120/price-preview?markupCents=0')
    expect(res.body).toMatchObject({ unitPriceCents: 1462, lineFeeCents: 11, lineMarginCents: 1 })
  })

  it.each([
    ['missing markup', ''],
    ['decimal markup', '?markupCents=10.5'],
    ['negative markup', '?markupCents=-1'],
    ['markup over $1,000', '?markupCents=100001'],
    ['quantity over 100', '?markupCents=1000&qty=101']
  ])('rejects %s with 400', async (_label, query) => {
    const res = await asProvider(`/api/products/MAG-GLY-120/price-preview${query}`)
    expect(res.status).toBe(400)
  })
})
