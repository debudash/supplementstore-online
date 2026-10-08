// API tests: patient "My Orders" listing (GET /api/patient/orders).
//
// Proves the two security properties the orchestrator required:
//  - ownership: patient A can never see patient B's orders (cross-patient leak test),
//    even for two patients in the SAME practice behind the SAME provider.
//  - privacy: the response is built through the T4 whitelist serializer, so COGS / fee /
//    margin never appear (blob check, as RT-10 does).
// Plus role guarding (provider/admin 403, unknown user 401), the pay-link surfacing that
// is the whole point, drafts excluded, and the paid-order transition (isPayable false).
//
// Runs against real Postgres (DATABASE_URL). Migrations applied via the tsx CLI in
// beforeAll (the proven pattern: knex raw-requires .ts migrations outside vite's
// transform, so db.migrate.latest() throws under vitest). DEDICATED fixtures (not the
// seed prov-ana/prov-ben) so paid orders - which cannot be torn down - never collide with
// other suites; non-paid orders are cleared in beforeEach.
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
  get: (url: string) => request(app).get(url).set('X-Demo-User', userId),
  post: (url: string) => request(app).post(url).set('X-Demo-User', userId)
})

// Dedicated fixtures. Two patients in ONE practice behind ONE provider is the strongest
// isolation test: nothing but patient_id separates them.
const PRACTICE = '88888888-8888-8888-8888-888888888888'
const PROVIDER = 'aaaaaaaa-0000-0000-0000-0000000000b1'
const PATIENT_A = 'cccccccc-0000-0000-0000-0000000000ba'
const PATIENT_B = 'cccccccc-0000-0000-0000-0000000000bb'
const PROV_USER = 'po-prov'
const PAT_A = 'po-pat-a'
const PAT_B = 'po-pat-b'

const SKU_MAG = 'MAG-GLY-120'

async function setupFixtures(): Promise<void> {
  await seedCore(db)
  await db('practices').insert({ id: PRACTICE, name: 'PO Practice' }).onConflict('id').merge()
  await db('providers')
    .insert({ id: PROVIDER, practice_id: PRACTICE, name: 'Dr. PO', email: 'po@example.com' })
    .onConflict('id')
    .merge()
  await db('patients')
    .insert({ id: PATIENT_A, practice_id: PRACTICE, name: 'Alice Avon', email: 'alice@example.com', ship_to: '1 A St' })
    .onConflict('id')
    .merge()
  await db('patients')
    .insert({ id: PATIENT_B, practice_id: PRACTICE, name: 'Bob Byrne', email: 'bob@example.com', ship_to: '2 B St' })
    .onConflict('id')
    .merge()
  await db('users')
    .insert({ id: PROV_USER, role: 'provider', provider_id: PROVIDER, patient_id: null, display_name: 'Dr. PO' })
    .onConflict('id')
    .merge()
  await db('users')
    .insert({ id: PAT_A, role: 'patient', provider_id: null, patient_id: PATIENT_A, display_name: 'Alice Avon' })
    .onConflict('id')
    .merge()
  await db('users')
    .insert({ id: PAT_B, role: 'patient', provider_id: null, patient_id: PATIENT_B, display_name: 'Bob Byrne' })
    .onConflict('id')
    .merge()
}

async function clearOrders(): Promise<void> {
  // All of this provider's orders. These tests never run a REAL payment (the paid-order
  // case sets status directly - see below), so no order has an append-only payment /
  // refund / journal row and every one is safe to delete. Keeping the ledger free of this
  // suite's orders also avoids polluting the ledger-based reports suite.
  // Exclude any order that has an append-only payment row (those cannot be deleted).
  // This suite never creates real payments, so in a clean DB this deletes every one of
  // its orders; the predicate just keeps beforeEach from crashing on a stray paid order.
  const deletableIds = () =>
    db('orders').where('provider_id', PROVIDER).whereNotIn('id', db('payments').select('order_id')).select('id')
  await db('inventory_movements').whereIn('order_id', deletableIds()).del()
  await db('order_events').whereIn('order_id', deletableIds()).del()
  await db('order_lines').whereIn('order_id', deletableIds()).del()
  await db('orders').where('provider_id', PROVIDER).whereNotIn('id', db('payments').select('order_id')).del()
  await db('products').update({ reserved_qty: 0 })
  await seedCore(db)
}

beforeAll(() => {
  migrateViaCli()
})

beforeEach(async () => {
  await setupFixtures()
  await clearOrders()
})

afterAll(async () => {
  await db.destroy()
})

// Send a MAG x2 @2999 order from PROVIDER to the given patient; return { orderId, payToken }.
async function sendOrderTo(patientId: string): Promise<{ orderId: string; payToken: string }> {
  const draft = await asUser(PROV_USER).post('/api/orders').send({ patientId })
  expect(draft.status).toBe(201)
  const orderId = draft.body.id as string
  const line = await asUser(PROV_USER)
    .post(`/api/orders/${orderId}/lines`)
    .send({ sku: SKU_MAG, qty: 2, markupCents: markupFor(SKU_MAG, 2999) })
  expect(line.status).toBe(200)
  const sent = await asUser(PROV_USER).post(`/api/orders/${orderId}/send`)
  expect(sent.status).toBe(200)
  return { orderId, payToken: sent.body.order.payToken as string }
}

describe('role + auth guarding', () => {
  it('a provider is refused 403 FORBIDDEN', async () => {
    const res = await asUser(PROV_USER).get('/api/patient/orders')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('a Cerbo Admin is refused 403 FORBIDDEN', async () => {
    const res = await asUser('admin-cerbo').get('/api/patient/orders')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('an unknown user is refused 401 before the handler runs', async () => {
    const res = await asUser('no-such-user').get('/api/patient/orders')
    expect(res.status).toBe(401)
  })

  it('there is NO by-id lookup surface: a patient cannot fetch any single order by id', async () => {
    // The listing is the only patient surface; there is deliberately no
    // GET /api/patient/orders/:id to guess against. A such URL matches no route and 404s,
    // so another patient's order id cannot be reached even if guessed. (Paying still
    // happens only at /api/pay/:token, which needs the unguessable token itself.)
    const { orderId } = await sendOrderTo(PATIENT_B)
    const res = await asUser(PAT_A).get(`/api/patient/orders/${orderId}`)
    expect(res.status).toBe(404)
  })
})

describe('listing the caller\'s own orders with the pay link', () => {
  it('returns the sent order with pay token, pay path, sent date, amount and status', async () => {
    const { orderId, payToken } = await sendOrderTo(PATIENT_A)

    const res = await asUser(PAT_A).get('/api/patient/orders')
    expect(res.status).toBe(200)
    const order = res.body.orders.find((o: { orderId: string }) => o.orderId === orderId)
    expect(order).toBeDefined()
    expect(order).toMatchObject({
      status: 'sent',
      amountCents: 5997, // MAG x2 at markup 1526, rounded once (ADR-028); the fee is internal
      payToken,
      payPath: `/pay/${payToken}`,
      isPayable: true
    })
    expect(order.sentAt).toBeTruthy()
    expect(order.paidAt).toBeNull()
    expect(order.items).toHaveLength(1)
    expect(order.items[0]).toMatchObject({ qty: 2, unitPriceCents: 2999, lineTotalCents: 5997 }) // 2999 is the average of 5997 / 2 (ADR-028)
  })
})

describe('OWNERSHIP: a patient can never see another patient\'s orders', () => {
  it('patient A sees only A\'s order; patient B sees only B\'s order', async () => {
    const a = await sendOrderTo(PATIENT_A)
    const b = await sendOrderTo(PATIENT_B)

    const aList = await asUser(PAT_A).get('/api/patient/orders')
    expect(aList.status).toBe(200)
    const aIds = aList.body.orders.map((o: { orderId: string }) => o.orderId)
    expect(aIds).toContain(a.orderId)
    expect(aIds).not.toContain(b.orderId)
    // And A can never see B's pay token through this surface.
    const aTokens = aList.body.orders.map((o: { payToken: string | null }) => o.payToken)
    expect(aTokens).not.toContain(b.payToken)

    const bList = await asUser(PAT_B).get('/api/patient/orders')
    const bIds = bList.body.orders.map((o: { orderId: string }) => o.orderId)
    expect(bIds).toContain(b.orderId)
    expect(bIds).not.toContain(a.orderId)
  })
})

describe('PRIVACY: no COGS / fee / margin ever leaks', () => {
  it('the response body contains no economics for any order', async () => {
    await sendOrderTo(PATIENT_A)
    const res = await asUser(PAT_A).get('/api/patient/orders')
    expect(res.status).toBe(200)
    const blob = JSON.stringify(res.body).toLowerCase()
    for (const leak of ['cogs', 'margin', 'fee']) {
      expect(blob).not.toContain(leak)
    }
  })
})

describe('drafts are never listed', () => {
  it('an un-sent draft does not appear in the patient list', async () => {
    const draft = await asUser(PROV_USER).post('/api/orders').send({ patientId: PATIENT_A })
    expect(draft.status).toBe(201)
    const draftId = draft.body.id as string

    const res = await asUser(PAT_A).get('/api/patient/orders')
    const ids = res.body.orders.map((o: { orderId: string }) => o.orderId)
    expect(ids).not.toContain(draftId)
  })
})

describe('paid orders show as paid and no longer payable', () => {
  it('after paying, the order is status paid, isPayable false, paidAt set', async () => {
    const { orderId } = await sendOrderTo(PATIENT_A)
    // Mark the order paid directly rather than running the real pay flow: this suite only
    // exercises how the LISTING renders a paid order (status / paidAt / isPayable), and a
    // real payment would post ledger entries that pollute the ledger-based reports suite.
    // The pay flow itself is covered by the T4 payments tests.
    await db('orders').where({ id: orderId }).update({ status: 'paid', paid_at: new Date() })

    const res = await asUser(PAT_A).get('/api/patient/orders')
    const order = res.body.orders.find((o: { orderId: string }) => o.orderId === orderId)
    expect(order).toBeDefined()
    expect(order.status).toBe('paid')
    expect(order.isPayable).toBe(false)
    expect(order.paidAt).toBeTruthy()
    expect(order.amountCents).toBe(5997)
  })
})
