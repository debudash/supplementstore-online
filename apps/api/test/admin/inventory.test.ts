// T11 API tests: Cerbo Admin inventory (demo restock) + the demo job endpoints.
//
// Covers FR-15 (restock writes a 'restock' movement with the admin actor and bumps the
// shared pool), FR-9 (expire-reservations job button), and RT-09 (a PROVIDER is refused
// 403 on every admin route). Money is not computed here; restock is pure unit counting.
//
// Runs against real Postgres (DATABASE_URL). Migrations applied via the tsx CLI in
// beforeAll (the T2/T3/T4/T5-proven pattern: knex raw-requires .ts migrations outside
// vite's transform, so db.migrate.latest() throws under vitest). Everything in ONE file
// so the suite stays serial over the single shared inventory pool.
//
// ISOLATION: a DEDICATED practice/provider/patient (not the seed prov-ana/prov-ben that
// orders.test.ts tears down) plus the seed admin-cerbo user and the seed SKUs. beforeEach
// restores canonical stock via seedCore, zeroes reservations, and clears the demo restock
// movements this suite writes (inventory_movements is NOT an append-only table).
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { db } from '../../src/db/knex'
import { createApp } from '../../src/app'
import { createKnexActorLoader } from '../../src/auth/loadActor'
import { seedCore } from '../../src/db/seeds/01_core'
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
  get: (url: string) => request(app).get(url).set('X-Demo-User', userId)
})

// Dedicated T11 fixtures (NOT the seed prov-ana/prov-ben).
const PRACTICE = '77777777-7777-7777-7777-777777777777'
const PROVIDER = 'aaaaaaaa-0000-0000-0000-0000000000a1'
const PATIENT = 'cccccccc-0000-0000-0000-0000000000a1'
const PROV_USER = 't11-prov'
const ADMIN_USER = 'admin-cerbo' // seeded cerbo_admin

const SKU_MAG = 'MAG-GLY-120' // seed on_hand 50
const SKU_ZINC = 'ZINC-30' // seed on_hand 0 (a sold-out SKU to refill)

async function setupFixtures(): Promise<void> {
  await seedCore(db)
  await db('practices').insert({ id: PRACTICE, name: 'T11 Practice' }).onConflict('id').merge()
  await db('providers')
    .insert({ id: PROVIDER, practice_id: PRACTICE, name: 'Dr. T11', email: 't11@example.com' })
    .onConflict('id')
    .merge()
  await db('patients')
    .insert({ id: PATIENT, practice_id: PRACTICE, name: 'Pat T11', email: 'pat.t11@example.com', ship_to: '1 T11 St' })
    .onConflict('id')
    .merge()
  await db('users')
    .insert({ id: PROV_USER, role: 'provider', provider_id: PROVIDER, patient_id: null, display_name: 'Dr. T11' })
    .onConflict('id')
    .merge()
}

async function resetState(): Promise<void> {
  const myOrders = db('orders').where('provider_id', PROVIDER).select('id')
  await db('inventory_movements').whereIn('order_id', myOrders).del()
  await db('order_events').whereIn('order_id', myOrders).del()
  await db('order_lines').whereIn('order_id', db('orders').where('provider_id', PROVIDER).select('id')).del()
  await db('orders').where('provider_id', PROVIDER).del()
  // Clear the demo restock movements this suite writes (order_id null, admin actor).
  await db('inventory_movements').where({ reason: 'restock', actor_user_id: ADMIN_USER }).del()
  // Canonical stock: seedCore merges on_hand back; zero all reservations.
  await db('products').update({ reserved_qty: 0 })
  await seedCore(db)
}

beforeAll(() => {
  migrateViaCli()
})

beforeEach(async () => {
  await setupFixtures()
  await resetState()
})

afterAll(async () => {
  await db.destroy()
})

describe('RT-09: providers are forbidden from every admin route (403)', () => {
  const adminRoutes: Array<{ method: 'get' | 'post'; url: string }> = [
    { method: 'get', url: '/api/admin/inventory' },
    { method: 'post', url: `/api/admin/inventory/${SKU_MAG}/restock` },
    { method: 'post', url: '/api/admin/jobs/expire-reservations' },
    { method: 'post', url: '/api/admin/jobs/run-due-schedules' },
    { method: 'post', url: '/api/admin/orders/00000000-0000-0000-0000-000000000000/fulfill' },
    { method: 'post', url: '/api/admin/orders/00000000-0000-0000-0000-000000000000/refund' }
  ]

  for (const route of adminRoutes) {
    it(`${route.method.toUpperCase()} ${route.url} -> 403 FORBIDDEN for a provider`, async () => {
      const res =
        route.method === 'get'
          ? await asUser(PROV_USER).get(route.url)
          : await asUser(PROV_USER).post(route.url).send({ qty: 5, reasonCode: 'other' })
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
    })
  }

  it('also refuses an unknown user with 401 before reaching the handler', async () => {
    const res = await asUser('no-such-user').get('/api/admin/inventory')
    expect(res.status).toBe(401)
  })
})

describe('FR-15 / ADR-009: admin inventory list', () => {
  it('lists the shared pool with on_hand, reserved and available = on_hand - reserved', async () => {
    const res = await asUser(ADMIN_USER).get('/api/admin/inventory')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.items)).toBe(true)
    const mag = res.body.items.find((i: { sku: string }) => i.sku === SKU_MAG)
    expect(mag).toMatchObject({ sku: SKU_MAG, onHandQty: 50, reservedQty: 0, available: 50 })
    for (const item of res.body.items) {
      expect(item.available).toBe(item.onHandQty - item.reservedQty)
    }
  })
})

describe('FR-15 / ADR-009: restock (demo only)', () => {
  it('adds units to on_hand, records one "restock" movement with the admin actor, leaves reserved', async () => {
    const res = await asUser(ADMIN_USER).post(`/api/admin/inventory/${SKU_ZINC}/restock`).send({ qty: 25 })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ sku: SKU_ZINC, qtyAdded: 25, onHandQty: 25, reservedQty: 0, available: 25 })

    const product = await db('products').where({ sku: SKU_ZINC }).first()
    expect(product.on_hand_qty).toBe(25)
    expect(product.reserved_qty).toBe(0)

    const movements = await db('inventory_movements')
      .where({ sku: SKU_ZINC, reason: 'restock', actor_user_id: ADMIN_USER })
      .select('*')
    expect(movements).toHaveLength(1)
    expect(movements[0]).toMatchObject({ delta_on_hand: 25, delta_reserved: 0, order_id: null })
    expect(res.body.movementId).toBe(Number(movements[0].id))
  })

  it('accumulates across restocks on the same SKU', async () => {
    await asUser(ADMIN_USER).post(`/api/admin/inventory/${SKU_MAG}/restock`).send({ qty: 10 })
    const res = await asUser(ADMIN_USER).post(`/api/admin/inventory/${SKU_MAG}/restock`).send({ qty: 5 })
    expect(res.status).toBe(200)
    expect(res.body.onHandQty).toBe(65) // 50 seed + 10 + 5
  })

  it('rejects a non-positive, fractional, or missing qty with 400 INVALID_INPUT', async () => {
    for (const body of [{ qty: 0 }, { qty: -5 }, { qty: 1.5 }, {}, { qty: 'ten' }]) {
      const res = await asUser(ADMIN_USER).post(`/api/admin/inventory/${SKU_MAG}/restock`).send(body)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('INVALID_INPUT')
    }
    // No movement was written for any rejected attempt.
    const movements = await db('inventory_movements').where({ reason: 'restock', actor_user_id: ADMIN_USER })
    expect(movements).toHaveLength(0)
  })

  it('returns 404 NOT_FOUND for an unknown SKU', async () => {
    const res = await asUser(ADMIN_USER).post('/api/admin/inventory/NO-SUCH-SKU/restock').send({ qty: 5 })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })
})

describe('FR-9 demo jobs: expire-reservations and run-due-schedules', () => {
  // Build a sent order (reserves stock), force its reservation into the past, then run the
  // admin expire job and assert it expired the order and released the reserved units.
  async function createSentOrderWithLapsedReservation(): Promise<string> {
    const draft = await asUser(PROV_USER).post('/api/orders').send({ patientId: PATIENT })
    expect(draft.status).toBe(201)
    const orderId = draft.body.id as string
    const line = await asUser(PROV_USER)
      .post(`/api/orders/${orderId}/lines`)
      .send({ sku: SKU_MAG, qty: 3, markupCents: markupFor(SKU_MAG, 2999) })
    expect(line.status).toBe(200)
    const sent = await asUser(PROV_USER).post(`/api/orders/${orderId}/send`)
    expect(sent.status).toBe(200)
    // Force the reservation to have lapsed.
    await db('orders')
      .where({ id: orderId })
      .update({ reservation_expires_at: new Date(Date.now() - 60_000) })
    return orderId
  }

  it('expire-reservations expires a lapsed sent order and releases its stock', async () => {
    const orderId = await createSentOrderWithLapsedReservation()
    const before = await db('products').where({ sku: SKU_MAG }).first()
    expect(before.reserved_qty).toBe(3)

    const res = await asUser(ADMIN_USER).post('/api/admin/jobs/expire-reservations')
    expect(res.status).toBe(200)
    expect(res.body.expired).toContain(orderId)

    const order = await db('orders').where({ id: orderId }).first()
    expect(order.status).toBe('expired')
    const after = await db('products').where({ sku: SKU_MAG }).first()
    expect(after.reserved_qty).toBe(0)
  })

  it('expire-reservations is a no-op when nothing is due', async () => {
    const res = await asUser(ADMIN_USER).post('/api/admin/jobs/expire-reservations')
    expect(res.status).toBe(200)
    expect(res.body.expired).toEqual([])
  })

  // run-due-schedules is not wired to the recurring sweep (FR-12 AC6); cycles run per
  // schedule. The endpoint honestly reports 501 rather than faking a run.
  it('run-due-schedules reports NOT_IMPLEMENTED (sweep not wired to the route)', async () => {
    const res = await asUser(ADMIN_USER).post('/api/admin/jobs/run-due-schedules')
    expect(res.status).toBe(501)
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED')
  })
})
