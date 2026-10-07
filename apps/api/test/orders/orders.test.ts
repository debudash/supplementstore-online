// T3 API tests: order lifecycle + inventory (FR-1..FR-4).
//
// Runs against real Postgres (DATABASE_URL). Migrations are applied via the tsx CLI
// in beforeAll (the T2-proven pattern): knex's migration loader raw-requires the .ts
// migration files outside vite's transform, so db.migrate.latest() throws under vitest.
//
// Everything in ONE file so the suite runs serially in a single fork: the tests share
// the single inventory pool and reset it in beforeEach, which would race if split
// across parallel test files. The RT-05 concurrency test still spawns two parallel
// transactions internally - that is the behaviour under test.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { db } from '../../src/db/knex'
import { createApp } from '../../src/app'
import { createKnexActorLoader } from '../../src/auth/loadActor'
import { seedCore } from '../../src/db/seeds/01_core'
import { sendOrder, createDraft, RESERVATION_DAYS } from '../../src/orders/service'
import { runExpireReservations } from '../../src/jobs/expire'
import type { Actor } from '../../src/auth/types'
import { markupFor } from '../pricing'

const apiRoot = path.resolve(__dirname, '../..')
function migrateViaCli(): void {
  execFileSync('npm', ['run', 'db:migrate'], {
    cwd: apiRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
}

const app = createApp({ db, loadActor: createKnexActorLoader(db) })
const asUser = (userId: string) => ({
  post: (url: string) => request(app).post(url).set('X-Demo-User', userId),
  patch: (url: string) => request(app).patch(url).set('X-Demo-User', userId),
  delete: (url: string) => request(app).delete(url).set('X-Demo-User', userId),
  get: (url: string) => request(app).get(url).set('X-Demo-User', userId)
})

// Seed ids (deterministic, from the T2 seed).
const PROVIDER_ANA = 'aaaaaaaa-0000-0000-0000-000000000001'
const PROVIDER_BEN = 'aaaaaaaa-0000-0000-0000-000000000002'

async function resetState(): Promise<void> {
  // Only our own (seeded-provider) orders; leave other suites' fixtures untouched.
  const myOrders = db('orders').whereIn('provider_id', [PROVIDER_ANA, PROVIDER_BEN]).select('id')
  await db('inventory_movements').whereIn('order_id', myOrders).del()
  await db('order_events').whereIn('order_id', myOrders).del()
  await db('order_lines').whereIn('order_id', db('orders').whereIn('provider_id', [PROVIDER_ANA, PROVIDER_BEN]).select('id')).del()
  await db('orders').whereIn('provider_id', [PROVIDER_ANA, PROVIDER_BEN]).del()
  await db('products').update({ reserved_qty: 0 })
  await seedCore(db)
}

beforeAll(() => {
  migrateViaCli()
})

beforeEach(async () => {
  await resetState()
})

afterAll(async () => {
  await db.destroy()
})

// Open a fresh draft for prov-ana / pat-cara and return its id.
async function newDraftAna(): Promise<string> {
  const res = await asUser('prov-ana').post('/api/orders').send({ patientId: 'cccccccc-0000-0000-0000-000000000001' })
  expect(res.status).toBe(201)
  return res.body.id as string
}

describe('FR-1 draft assembly', () => {
  it('creates a draft linked to provider, practice, patient', async () => {
    const res = await asUser('prov-ana').post('/api/orders').send({ patientId: 'cccccccc-0000-0000-0000-000000000001' })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('draft')
    expect(res.body.providerId).toBe(PROVIDER_ANA)
    expect(res.body.totals).toBeNull()
  })

  it('rejects a draft for a patient outside the provider practice with 404', async () => {
    // pat-dev belongs to Summit; prov-ana is Riverside.
    const res = await asUser('prov-ana').post('/api/orders').send({ patientId: 'cccccccc-0000-0000-0000-000000000002' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('merges a repeated SKU into one line (qty summed) - FR-1 AC2', async () => {
    const id = await newDraftAna()
    await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'MAG-GLY-120', qty: 2, markupCents: markupFor('MAG-GLY-120', 2999) })
    const res = await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'MAG-GLY-120', qty: 1, markupCents: markupFor('MAG-GLY-120', 2999) })
    expect(res.status).toBe(200)
    expect(res.body.lines).toHaveLength(1)
    expect(res.body.lines[0].qty).toBe(3)
  })
})

describe('EVAL-01 split at API level (quote)', () => {
  it('MAG x2 @2999 + VITD3 x1 @2499 -> subtotal 8497, fee 64, line fees [45,19], margins [3053,1355]', async () => {
    const id = await newDraftAna()
    await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'MAG-GLY-120', qty: 2, markupCents: markupFor('MAG-GLY-120', 2999) })
    await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'VITD3-K2', qty: 1, markupCents: markupFor('VITD3-K2', 2499) })

    const q = await asUser('prov-ana').get(`/api/orders/${id}/quote`)
    expect(q.status).toBe(200)
    expect(q.body.totals).toMatchObject({ subtotalCents: 8497, cogsCents: 4025, feeCents: 64, marginCents: 4408 })
    const mag = q.body.lines.find((l: { sku: string }) => l.sku === 'MAG-GLY-120')
    const vit = q.body.lines.find((l: { sku: string }) => l.sku === 'VITD3-K2')
    expect(mag).toMatchObject({ lineFeeCents: 45, lineMarginCents: 3053, lineCogsCents: 2900 })
    expect(vit).toMatchObject({ lineFeeCents: 19, lineMarginCents: 1355, lineCogsCents: 1125 })
  })
})

describe('EVAL-04 margin floor (FR-2 AC3) under markup pricing (ADR-028)', () => {
  // The split still rejects a negative line margin (packages/money EVAL-04), but a markup
  // price always covers the fee and a $0 markup is priced as 1 cent of rounding headroom,
  // so no line can go negative: markup 0 sells at cost + fee and nets 0 or 1 cent.
  it('VITD markup 0 -> unit price 1135 (cost + fee + 1 cent headroom), net margin 1', async () => {
    const id = await newDraftAna()
    const r = await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'VITD3-K2', qty: 1, markupCents: 0 })
    expect(r.status).toBe(200)
    expect(r.body.lines[0]).toMatchObject({ unitPriceCents: 1135, unitMarkupCents: 0 })
    const q = await asUser('prov-ana').get(`/api/orders/${id}/quote`)
    expect(q.body.lines[0]).toMatchObject({ lineFeeCents: 9, lineMarginCents: 1 })
  })

  it('EVAL-04b markup mode: MAG markup 1000 -> unit price 2469, fee 19, margin 1000', async () => {
    const id = await newDraftAna()
    const r = await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'MAG-GLY-120', qty: 1, markupCents: 1000 })
    expect(r.status).toBe(200)
    expect(r.body.lines[0]).toMatchObject({ unitPriceCents: 2469, unitMarkupCents: 1000 })
    const q = await asUser('prov-ana').get(`/api/orders/${id}/quote`)
    expect(q.body.lines[0]).toMatchObject({ lineFeeCents: 19, lineMarginCents: 1000 })
  })

  it('a draft re-prices from current COGS + markup, and send snapshots that price', async () => {
    const id = await newDraftAna()
    await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'MAG-GLY-120', qty: 1, markupCents: 1000 })
    await db('products').where({ sku: 'MAG-GLY-120' }).update({ unit_cogs_cents: 1550 })
    try {
      const q = await asUser('prov-ana').get(`/api/orders/${id}/quote`)
      // (1550 + 1000) * 10000 / 9925 = 2569.27 -> 2570; fee 19; margin 2570 - 1550 - 19 = 1001
      // (rounding the price up never leaves the provider below the 1000 markup).
      expect(q.body.lines[0]).toMatchObject({ unitPriceCents: 2570, lineMarginCents: 1001 })
      const sent = await asUser('prov-ana').post(`/api/orders/${id}/send`).send({})
      expect(sent.status).toBe(200)
      expect(sent.body.order.lines[0]).toMatchObject({ unitPriceCents: 2570, unitCogsCents: 1550, unitMarkupCents: 1000, lineMarginCents: 1001 })
    } finally {
      await db('products').where({ sku: 'MAG-GLY-120' }).update({ unit_cogs_cents: 1450 })
    }
  })

  it('changing the markup on a line re-derives its price', async () => {
    const id = await newDraftAna()
    const add = await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'MAG-GLY-120', qty: 2, markupCents: 1000 })
    const lineId = add.body.lines[0].id as string
    const r = await asUser('prov-ana').patch(`/api/orders/${id}/lines/${lineId}`).send({ markupCents: markupFor('MAG-GLY-120', 2999) })
    expect(r.status).toBe(200)
    expect(r.body.lines[0]).toMatchObject({ qty: 2, unitPriceCents: 2999, unitMarkupCents: 1526 })
  })
})

describe('FR-3 stock check at add-to-cart', () => {
  it('EVAL-05 PROBIO x6 -> 409 available 5; x5 succeeds', async () => {
    const id = await newDraftAna()
    const over = await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'PROBIO-50B', qty: 6, markupCents: markupFor('PROBIO-50B', 4000) })
    expect(over.status).toBe(409)
    expect(over.body.error.code).toBe('INSUFFICIENT_STOCK')
    expect(over.body.error.details.available).toBe(5)

    const ok = await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'PROBIO-50B', qty: 5, markupCents: markupFor('PROBIO-50B', 4000) })
    expect(ok.status).toBe(200)
  })

  it('EVAL-05b ZINC x1 -> 409 available 0', async () => {
    const id = await newDraftAna()
    const res = await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'ZINC-30', qty: 1, markupCents: markupFor('ZINC-30', 1500) })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK')
    expect(res.body.error.details.available).toBe(0)
  })
})

describe('FR-4 send: snapshot, reserve, persist', () => {
  it('persists totals, sets status sent, reserves stock, and returns a pay link', async () => {
    const id = await newDraftAna()
    await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'MAG-GLY-120', qty: 2, markupCents: markupFor('MAG-GLY-120', 2999) })
    await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'VITD3-K2', qty: 1, markupCents: markupFor('VITD3-K2', 2499) })

    const res = await asUser('prov-ana').post(`/api/orders/${id}/send`).send({})
    expect(res.status).toBe(200)
    expect(res.body.order.status).toBe('sent')
    expect(res.body.order.totals).toMatchObject({ subtotalCents: 8497, feeCents: 64, marginCents: 4408 })
    expect(res.body.order.payToken).toBeTruthy()
    expect(res.body.payUrl).toBe(`/pay/${res.body.order.payToken}`)

    const mag = await db('products').where({ sku: 'MAG-GLY-120' }).first()
    const vit = await db('products').where({ sku: 'VITD3-K2' }).first()
    expect(mag.reserved_qty).toBe(2)
    expect(vit.reserved_qty).toBe(1)

    const moves = await db('inventory_movements').where({ order_id: id, reason: 'reserve' })
    expect(moves).toHaveLength(2)
  })

  it('ignores any client-sent totals and recomputes from DB snapshots (money rule 9)', async () => {
    const id = await newDraftAna()
    await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'MAG-GLY-120', qty: 2, markupCents: markupFor('MAG-GLY-120', 2999) })
    await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'VITD3-K2', qty: 1, markupCents: markupFor('VITD3-K2', 2499) })
    const res = await asUser('prov-ana')
      .post(`/api/orders/${id}/send`)
      .send({ subtotalCents: 1, feeCents: 1, marginCents: 999999 })
    expect(res.status).toBe(200)
    expect(res.body.order.totals.subtotalCents).toBe(8497)
    expect(res.body.order.totals.feeCents).toBe(64)
  })

  it('refuses to send an empty order', async () => {
    const id = await newDraftAna()
    const res = await asUser('prov-ana').post(`/api/orders/${id}/send`).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_INPUT')
  })

  it('snapshots COGS at send even if the catalog COGS later changes (ADR-006)', async () => {
    const id = await newDraftAna()
    await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'MAG-GLY-120', qty: 1, markupCents: markupFor('MAG-GLY-120', 2999) })
    await asUser('prov-ana').post(`/api/orders/${id}/send`).send({})
    // Catalog COGS rises after send; the snapshot on the line must not move.
    await db('products').where({ sku: 'MAG-GLY-120' }).update({ unit_cogs_cents: 9999 })
    const line = await db('order_lines').where({ order_id: id }).first()
    expect(line.unit_cogs_cents).toBe(1450)
    expect(line.line_cogs_cents).toBe(1450)
  })
})

describe('FR-4 AC5 cancel', () => {
  it('cancels a draft', async () => {
    const id = await newDraftAna()
    const res = await asUser('prov-ana').post(`/api/orders/${id}/cancel`).send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('cancelled')
  })

  it('cancelling a sent order releases the reservation', async () => {
    const id = await newDraftAna()
    await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'MAG-GLY-120', qty: 3, markupCents: markupFor('MAG-GLY-120', 2999) })
    await asUser('prov-ana').post(`/api/orders/${id}/send`).send({})
    expect((await db('products').where({ sku: 'MAG-GLY-120' }).first()).reserved_qty).toBe(3)

    const res = await asUser('prov-ana').post(`/api/orders/${id}/cancel`).send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('cancelled')
    expect((await db('products').where({ sku: 'MAG-GLY-120' }).first()).reserved_qty).toBe(0)
    const release = await db('inventory_movements').where({ order_id: id, reason: 'release' })
    expect(release).toHaveLength(1)
  })
})

describe('EVAL-05c cross-order reservation', () => {
  it('prov-ana sends PROBIO x5; prov-ben add x1 -> 409 available 0; after cancel available 5', async () => {
    const anaDraft = await newDraftAna()
    await asUser('prov-ana').post(`/api/orders/${anaDraft}/lines`).send({ sku: 'PROBIO-50B', qty: 5, markupCents: markupFor('PROBIO-50B', 4000) })
    await asUser('prov-ana').post(`/api/orders/${anaDraft}/send`).send({})

    const benRes = await asUser('prov-ben').post('/api/orders').send({ patientId: 'cccccccc-0000-0000-0000-000000000002' })
    const benDraft = benRes.body.id
    const benAdd = await asUser('prov-ben').post(`/api/orders/${benDraft}/lines`).send({ sku: 'PROBIO-50B', qty: 1, markupCents: markupFor('PROBIO-50B', 4000) })
    expect(benAdd.status).toBe(409)
    expect(benAdd.body.error.details.available).toBe(0)

    await asUser('prov-ana').post(`/api/orders/${anaDraft}/cancel`).send({})

    const products = await asUser('prov-ben').get('/api/products')
    const probio = products.body.products.find((p: { sku: string }) => p.sku === 'PROBIO-50B')
    expect(probio.available).toBe(5)
    const benAdd2 = await asUser('prov-ben').post(`/api/orders/${benDraft}/lines`).send({ sku: 'PROBIO-50B', qty: 1, markupCents: markupFor('PROBIO-50B', 4000) })
    expect(benAdd2.status).toBe(200)
  })
})

describe('EVAL-14 reservation expiry', () => {
  it('expire job after 7 days + 1 min sets status expired and releases stock', async () => {
    const id = await newDraftAna()
    await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'MAG-GLY-120', qty: 2, markupCents: markupFor('MAG-GLY-120', 2999) })
    await asUser('prov-ana').post(`/api/orders/${id}/send`).send({})
    expect((await db('products').where({ sku: 'MAG-GLY-120' }).first()).reserved_qty).toBe(2)

    const future = new Date(Date.now() + RESERVATION_DAYS * 24 * 60 * 60 * 1000 + 60 * 1000)
    const result = await runExpireReservations(db, { now: () => future })
    expect(result.expired).toContain(id)

    const order = await db('orders').where({ id }).first()
    expect(order.status).toBe('expired')
    expect(order.expired_at).toBeTruthy()
    expect((await db('products').where({ sku: 'MAG-GLY-120' }).first()).reserved_qty).toBe(0)
  })

  it('does not expire an order whose reservation has not yet lapsed', async () => {
    const id = await newDraftAna()
    await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'MAG-GLY-120', qty: 1, markupCents: markupFor('MAG-GLY-120', 2999) })
    await asUser('prov-ana').post(`/api/orders/${id}/send`).send({})
    const result = await runExpireReservations(db, { now: () => new Date() })
    expect(result.expired).not.toContain(id)
    expect((await db('orders').where({ id }).first()).status).toBe('sent')
  })
})

describe('RT-01 ownership (IDOR) -> 404', () => {
  it('prov-ben cannot read or edit prov-ana order', async () => {
    const anaDraft = await newDraftAna()
    const q = await asUser('prov-ben').get(`/api/orders/${anaDraft}/quote`)
    expect(q.status).toBe(404)
    const add = await asUser('prov-ben').post(`/api/orders/${anaDraft}/lines`).send({ sku: 'MAG-GLY-120', qty: 1, markupCents: markupFor('MAG-GLY-120', 2999) })
    expect(add.status).toBe(404)
  })
})

describe('RT-06 edit after send -> 409 ORDER_NOT_EDITABLE', () => {
  it('rejects add/patch/delete on a sent order', async () => {
    const id = await newDraftAna()
    const addRes = await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'MAG-GLY-120', qty: 1, markupCents: markupFor('MAG-GLY-120', 2999) })
    const lineId = addRes.body.lines[0].id
    await asUser('prov-ana').post(`/api/orders/${id}/send`).send({})

    const add = await asUser('prov-ana').post(`/api/orders/${id}/lines`).send({ sku: 'VITD3-K2', qty: 1, markupCents: markupFor('VITD3-K2', 2499) })
    expect(add.status).toBe(409)
    expect(add.body.error.code).toBe('ORDER_NOT_EDITABLE')

    const patch = await asUser('prov-ana').patch(`/api/orders/${id}/lines/${lineId}`).send({ qty: 2 })
    expect(patch.status).toBe(409)

    const del = await asUser('prov-ana').delete(`/api/orders/${id}/lines/${lineId}`)
    expect(del.status).toBe(409)
  })
})

describe('RT-07 input validation -> 400 (no float reaches money)', () => {
  const cases: Array<[string, unknown]> = [
    ['qty zero', { sku: 'MAG-GLY-120', qty: 0, markupCents: markupFor('MAG-GLY-120', 2999) }],
    ['qty decimal', { sku: 'MAG-GLY-120', qty: 1.5, markupCents: 1000 }],
    ['qty string', { sku: 'MAG-GLY-120', qty: '5', markupCents: 1000 }],
    ['qty over 100', { sku: 'MAG-GLY-120', qty: 101, markupCents: markupFor('MAG-GLY-120', 2999) }],
    ['markup string "10.00"', { sku: 'MAG-GLY-120', qty: 1, markupCents: '10.00' }],
    ['markup negative', { sku: 'MAG-GLY-120', qty: 1, markupCents: -5 }],
    ['markup decimal', { sku: 'MAG-GLY-120', qty: 1, markupCents: 10.5 }],
    ['markup over $1,000', { sku: 'MAG-GLY-120', qty: 1, markupCents: 100001 }],
    ['markup huge (unsafe int)', { sku: 'MAG-GLY-120', qty: 1, markupCents: Number.MAX_SAFE_INTEGER + 2 }],
    ['retired raw price', { sku: 'MAG-GLY-120', qty: 1, unitPriceCents: 2999 }],
    ['retired margin %', { sku: 'MAG-GLY-120', qty: 1, marginBps: 4000 }],
    ['no markup', { sku: 'MAG-GLY-120', qty: 1 }]
  ]
  it.each(cases)('rejects %s', async (_label, body) => {
    const id = await newDraftAna()
    const res = await asUser('prov-ana').post(`/api/orders/${id}/lines`).send(body as object)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_INPUT')
  })
})

describe('RT-05 concurrency: two simultaneous sends cannot oversell', () => {
  it('only one of two concurrent sends for the last 5 PROBIO units succeeds', async () => {
    const loadActor = createKnexActorLoader(db)
    const ana = (await loadActor('prov-ana')) as Actor
    const ben = (await loadActor('prov-ben')) as Actor

    // Both providers build a draft for all 5 PROBIO units (add is only a UX gate).
    const anaDraft = (await createDraft(db, ana, { patientId: 'cccccccc-0000-0000-0000-000000000001' })).id
    const benDraft = (await createDraft(db, ben, { patientId: 'cccccccc-0000-0000-0000-000000000002' })).id
    await asUser('prov-ana').post(`/api/orders/${anaDraft}/lines`).send({ sku: 'PROBIO-50B', qty: 5, markupCents: markupFor('PROBIO-50B', 4000) })
    await asUser('prov-ben').post(`/api/orders/${benDraft}/lines`).send({ sku: 'PROBIO-50B', qty: 5, markupCents: markupFor('PROBIO-50B', 4000) })

    const results = await Promise.allSettled([
      sendOrder(db, ana, anaDraft),
      sendOrder(db, ben, benDraft)
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason.code).toBe('INSUFFICIENT_STOCK')

    // The invariant reserved <= on_hand holds; exactly 5 units reserved by the winner.
    const probio = await db('products').where({ sku: 'PROBIO-50B' }).first()
    expect(probio.reserved_qty).toBe(5)
    expect(probio.reserved_qty).toBeLessThanOrEqual(probio.on_hand_qty)

    const sent = await db('orders').whereIn('id', [anaDraft, benDraft]).andWhere('status', 'sent')
    expect(sent).toHaveLength(1)
  })
})
