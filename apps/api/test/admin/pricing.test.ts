// ADR-025: Cerbo Admin list-price editing and the provider price preview.
//
// Risk controls proven here: admin-only, optimistic concurrency (PRICE_CONFLICT), price
// must be above cost (PRICE_BELOW_COST), required reason, strict integer input, an
// append-only history written in the same transaction, the active-schedule impact count,
// and a preview that matches what the add-line path stores.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
const ADMIN = 'admin-cerbo'
const PROVIDER = 'prov-ana'
const SKU = 'MAG-GLY-120' // cogs 1450, seeded list 2999

const as = (userId: string) => ({
  get: (url: string) => request(app).get(url).set('X-Demo-User', userId),
  patch: (url: string) => request(app).patch(url).set('X-Demo-User', userId)
})
const patchPrice = (body: Record<string, unknown>, user = ADMIN) =>
  as(user).patch(`/api/admin/products/${SKU}/list-price`).send(body)
const listPrice = async (): Promise<number> => (await db('products').where({ sku: SKU }).first()).list_price_cents
const historyCount = async (): Promise<number> =>
  Number((await db('product_price_changes').where({ sku: SKU }).count<{ count: string }[]>('* as count'))[0].count)

beforeAll(async () => {
  migrateViaCli()
  await seedCore(db)
})
beforeEach(async () => {
  await db('products').where({ sku: SKU }).update({ list_price_cents: 2999, unit_cogs_cents: 1450 })
})
afterAll(async () => {
  await seedCore(db) // restore canonical catalog prices for the suites that follow
  await db.destroy()
})

describe('PATCH /api/admin/products/:sku/list-price', () => {
  it('updates the price, records history in the same change, and reports margins', async () => {
    const before = await historyCount()
    const res = await patchPrice({ listPriceCents: 3299, expectedCurrentPriceCents: 2999, reason: 'Supplier cost increase' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      sku: SKU,
      previousPriceCents: 2999,
      listPriceCents: 3299,
      unitCogsCents: 1450,
      previousMarginBps: 5165,
      listMarginBps: 5604 // floor((3299 - 1450) * 10000 / 3299) = 5604.7
    })
    expect(res.body.change).toMatchObject({ oldPriceCents: 2999, newPriceCents: 3299, reason: 'Supplier cost increase', actorUserId: ADMIN, actorName: 'Cerbo Admin' })
    expect(await listPrice()).toBe(3299)
    expect(await historyCount()).toBe(before + 1)
  })

  it('refuses a stale edit with PRICE_CONFLICT and changes nothing', async () => {
    const before = await historyCount()
    const res = await patchPrice({ listPriceCents: 3500, expectedCurrentPriceCents: 2500, reason: 'Stale screen' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('PRICE_CONFLICT')
    expect(res.body.error.details.currentPriceCents).toBe(2999)
    expect(await listPrice()).toBe(2999)
    expect(await historyCount()).toBe(before)
  })

  it('refuses a price at or below cost with PRICE_BELOW_COST', async () => {
    for (const p of [1450, 1000]) {
      const res = await patchPrice({ listPriceCents: p, expectedCurrentPriceCents: 2999, reason: 'Clearance' })
      expect(res.status).toBe(422)
      expect(res.body.error.code).toBe('PRICE_BELOW_COST')
      expect(res.body.error.details.unitCogsCents).toBe(1450)
    }
    expect(await listPrice()).toBe(2999)
  })

  it('validates input strictly (no strings, floats, missing reason, or no-op)', async () => {
    const bad: Array<Record<string, unknown>> = [
      { listPriceCents: '3299', expectedCurrentPriceCents: 2999, reason: 'String price' },
      { listPriceCents: 32.99, expectedCurrentPriceCents: 2999, reason: 'Float price' },
      { listPriceCents: 3299, expectedCurrentPriceCents: 2999 },
      { listPriceCents: 3299, expectedCurrentPriceCents: 2999, reason: '  x ' },
      { listPriceCents: 3299, reason: 'Missing expected' },
      { listPriceCents: 10_000_001, expectedCurrentPriceCents: 2999, reason: 'Too high' },
      { listPriceCents: 2999, expectedCurrentPriceCents: 2999, reason: 'Same price' }
    ]
    for (const body of bad) {
      const res = await patchPrice(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe('INVALID_INPUT')
    }
    expect(await listPrice()).toBe(2999)
  })

  it('is admin only (provider gets 403) and 404s an unknown SKU', async () => {
    const forbidden = await patchPrice({ listPriceCents: 3299, expectedCurrentPriceCents: 2999, reason: 'Provider tries' }, PROVIDER)
    expect(forbidden.status).toBe(403)
    const missing = await as(ADMIN).patch('/api/admin/products/NOPE/list-price').send({ listPriceCents: 3299, expectedCurrentPriceCents: 2999, reason: 'No such sku' })
    expect(missing.status).toBe(404)
    expect(await listPrice()).toBe(2999)
  })

  it('keeps the history append-only at the database level', async () => {
    await patchPrice({ listPriceCents: 3100, expectedCurrentPriceCents: 2999, reason: 'Append-only check' })
    const row = await db('product_price_changes').where({ sku: SKU }).orderBy('id', 'desc').first()
    await expect(db('product_price_changes').where({ id: row.id }).update({ reason: 'tampered' })).rejects.toThrow(/append-only/)
    await expect(db('product_price_changes').where({ id: row.id }).del()).rejects.toThrow(/append-only/)
  })

  it('counts active recurring schedules that will pick up the new price', async () => {
    const inv = async () => (await as(ADMIN).get('/api/admin/inventory')).body.items.find((i: { sku: string }) => i.sku === SKU)
    const baseline = (await inv()).activeScheduleCount as number

    const user = await db('users').where({ id: PROVIDER }).first()
    const provider = await db('providers').where({ id: user.provider_id }).first()
    const patient = await db('patients').where({ practice_id: provider.practice_id }).first()
    const [schedule] = await db('recurring_schedules')
      .insert({ provider_id: provider.id, practice_id: provider.practice_id, patient_id: patient.id, interval_days: 30, status: 'active' })
      .returning('id')
    await db('schedule_lines').insert({ schedule_id: schedule.id, position: 1, sku: SKU, qty: 1, unit_price_cents: 2999 })

    expect((await inv()).activeScheduleCount).toBe(baseline + 1)
    const res = await patchPrice({ listPriceCents: 3199, expectedCurrentPriceCents: 2999, reason: 'Impact count' })
    expect(res.body.activeScheduleCount).toBe(baseline + 1)

    await db('recurring_schedules').where({ id: schedule.id }).update({ status: 'cancelled' })
    expect((await inv()).activeScheduleCount).toBe(baseline)
  })
})

describe('GET /api/admin/products/:sku/list-price-preview', () => {
  it('reviews a proposed price without changing anything', async () => {
    const before = await historyCount()
    const res = await as(ADMIN).get(`/api/admin/products/${SKU}/list-price-preview?listPriceCents=3299`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ currentPriceCents: 2999, listPriceCents: 3299, currentMarginBps: 5165, listMarginBps: 5604, belowCost: false, differenceCents: 300 })
    const low = await as(ADMIN).get(`/api/admin/products/${SKU}/list-price-preview?listPriceCents=1400`)
    // floor((1400 - 1450) * 10000 / 1400) = floor(-357.14) = -358
    expect(low.body).toMatchObject({ belowCost: true, listMarginBps: -358 })
    expect(await listPrice()).toBe(2999)
    expect(await historyCount()).toBe(before)
    expect((await as(ADMIN).get(`/api/admin/products/${SKU}/list-price-preview?listPriceCents=29.99`)).status).toBe(400)
    expect((await as(PROVIDER).get(`/api/admin/products/${SKU}/list-price-preview?listPriceCents=3299`)).status).toBe(403)
  })
})

describe('GET /api/admin/products/:sku/price-history', () => {
  it('lists changes newest first with who made them', async () => {
    await patchPrice({ listPriceCents: 3001, expectedCurrentPriceCents: 2999, reason: 'First change' })
    await patchPrice({ listPriceCents: 3002, expectedCurrentPriceCents: 3001, reason: 'Second change' })
    const res = await as(ADMIN).get(`/api/admin/products/${SKU}/price-history`)
    expect(res.status).toBe(200)
    expect(res.body.changes[0]).toMatchObject({ oldPriceCents: 3001, newPriceCents: 3002, reason: 'Second change', actorName: 'Cerbo Admin' })
    expect(res.body.changes[1]).toMatchObject({ oldPriceCents: 2999, newPriceCents: 3001 })
    expect((await as(PROVIDER).get(`/api/admin/products/${SKU}/price-history`)).status).toBe(403)
  })
})

describe('provider catalog: listMarginBps and price preview', () => {
  it('GET /api/products includes the margin at list price', async () => {
    const res = await as(PROVIDER).get('/api/products')
    const mag = res.body.products.find((p: { sku: string }) => p.sku === SKU)
    expect(mag).toMatchObject({ listPriceCents: 2999, listMarginBps: 5165 })
  })

  it('previews exactly the price the add-line path stores', async () => {
    const res = await as(PROVIDER).get(`/api/products/${SKU}/price-preview?marginBps=4000`)
    expect(res.status).toBe(200)
    // ceil(1450 * 10000 / 6000) = 2417
    expect(res.body).toEqual({ sku: SKU, marginBps: 4000, unitPriceCents: 2417, listPriceCents: 2999, listMarginBps: 5165, differenceFromListCents: -582 })
  })

  it('rejects bad margins and unknown SKUs', async () => {
    for (const q of ['marginBps=9501', 'marginBps=-1', 'marginBps=40.5', 'marginBps=abc', '']) {
      const res = await as(PROVIDER).get(`/api/products/${SKU}/price-preview?${q}`)
      expect(res.status, q).toBe(400)
    }
    expect((await as(PROVIDER).get('/api/products/NOPE/price-preview?marginBps=4000')).status).toBe(404)
  })
})
