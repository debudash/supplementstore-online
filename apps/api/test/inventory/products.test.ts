// Catalog list-price tests: GET /api/products exposes the seeded listPriceCents, and the
// seed/migration keep the protected seed facts (cogs, on_hand) and the 5-product invariant
// intact. Runs against real Postgres (DATABASE_URL); migrations via the tsx CLI in
// beforeAll (the proven pattern - db.migrate.latest() throws under vitest).
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

// The owner-approved catalog list prices (docs: migration 6 + seed). cogs/on_hand are the
// PROTECTED EVALS seed facts and must be unchanged.
const EXPECTED: Record<string, { cogs: number; onHand: number; listPrice: number }> = {
  'MAG-GLY-120': { cogs: 1450, onHand: 50, listPrice: 2999 },
  'VITD3-K2': { cogs: 1125, onHand: 40, listPrice: 2499 },
  'OMEGA3-1000': { cogs: 2280, onHand: 30, listPrice: 4999 },
  'PROBIO-50B': { cogs: 2675, onHand: 5, listPrice: 4299 },
  'ZINC-30': { cogs: 690, onHand: 0, listPrice: 1290 }
}

beforeAll(async () => {
  migrateViaCli()
  await seedCore(db) // idempotent; restores canonical rows incl. list_price_cents
})
afterAll(async () => {
  await db.destroy()
})

describe('catalog list price (owner decision)', () => {
  it('seed is idempotent and leaves exactly 5 products with a positive NOT NULL list price', async () => {
    await seedCore(db)
    await seedCore(db)
    const [{ count }] = await db('products').count<{ count: string }[]>('* as count')
    expect(Number(count)).toBe(5)
    const rows = await db('products').select('sku', 'unit_cogs_cents', 'on_hand_qty', 'list_price_cents')
    for (const r of rows) {
      const e = EXPECTED[r.sku]
      expect(e).toBeTruthy()
      expect(r.list_price_cents).toBe(e.listPrice)
      expect(r.list_price_cents).toBeGreaterThan(0)
      // Protected EVALS seed facts are unchanged by this additive price.
      expect(r.unit_cogs_cents).toBe(e.cogs)
      expect(r.on_hand_qty).toBe(e.onHand)
    }
  })

  it('GET /api/products returns listPriceCents (integer cents) for every catalog row', async () => {
    const res = await asProvider('/api/products')
    expect(res.status).toBe(200)
    const products = res.body.products as Array<Record<string, unknown>>
    expect(products).toHaveLength(5)
    for (const p of products) {
      const e = EXPECTED[p.sku as string]
      expect(e).toBeTruthy()
      expect(p.listPriceCents).toBe(e.listPrice)
      expect(Number.isInteger(p.listPriceCents)).toBe(true)
      // The existing economics field is still present and unchanged alongside the new one.
      expect(p.unitCogsCents).toBe(e.cogs)
    }
  })
})
