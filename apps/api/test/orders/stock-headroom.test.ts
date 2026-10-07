// Proves the INSUFFICIENT_STOCK error on add-to-cart carries the REMAINING headroom for
// this order, not just the raw catalog availability (owner UX fix). Because adding a SKU
// already on the order SUMS the quantities (FR-1 AC2), the honest "how many more can I
// add" number is `available - already on the order`; the server computes it so the UI
// never does stock arithmetic in the browser.
//
// Tightly scoped: this only asserts the error DETAIL. The stock check logic, the
// reservation path, and every other error are unchanged.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
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
const asUser = (userId: string) => ({
  post: (url: string) => request(app).post(url).set('X-Demo-User', userId)
})

const SKU = 'PROBIO-50B' // seed on_hand 5

interface World { providerId: string; practiceId: string; patientId: string; userId: string }
async function makeWorld(): Promise<World> {
  const practiceId = randomUUID()
  const providerId = randomUUID()
  const patientId = randomUUID()
  const userId = `hr-${randomUUID().slice(0, 12)}`
  await db('practices').insert({ id: practiceId, name: 'Headroom Practice' })
  await db('providers').insert({ id: providerId, practice_id: practiceId, name: 'Dr HR', email: `${userId}@hr.example` })
  await db('patients').insert({ id: patientId, practice_id: practiceId, name: 'Pat HR', email: `${patientId}@hr.example`, ship_to: '1 HR St' })
  await db('users').insert({ id: userId, role: 'provider', provider_id: providerId, patient_id: null, display_name: 'Dr HR' })
  return { providerId, practiceId, patientId, userId }
}

beforeAll(async () => {
  migrateViaCli()
  await seedCore(db)
})
beforeEach(async () => {
  // Fresh PROBIO stock: on_hand 5, nothing reserved -> available 5.
  await db('products').where({ sku: SKU }).update({ on_hand_qty: 5, reserved_qty: 0 })
})
afterAll(async () => {
  await db.destroy()
})

describe('INSUFFICIENT_STOCK add-to-cart detail carries remaining headroom', () => {
  it('reports remaining = available - already-on-order, clamped at 0', async () => {
    const w = await makeWorld()
    const draft = await asUser(w.userId).post('/api/orders').send({ patientId: w.patientId })
    expect(draft.status).toBe(201)
    const orderId = draft.body.id as string

    // 3 of 5 available already on the order (priced by a markup).
    const first = await asUser(w.userId).post(`/api/orders/${orderId}/lines`).send({ sku: SKU, qty: 3, markupCents: 1000 })
    expect(first.status).toBe(200)

    // Adding 3 more would be 6 vs 5 available -> refused. available stays 5, but the
    // remaining headroom to add is 5 - 3 = 2.
    const second = await asUser(w.userId).post(`/api/orders/${orderId}/lines`).send({ sku: SKU, qty: 3, markupCents: 1000 })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('INSUFFICIENT_STOCK')
    expect(second.body.error.details.available).toBe(5)
    expect(second.body.error.details.remaining).toBe(2)
  })

  it('remaining is 0 when the order already holds all available stock', async () => {
    const w = await makeWorld()
    const draft = await asUser(w.userId).post('/api/orders').send({ patientId: w.patientId })
    const orderId = draft.body.id as string
    // Fill the order to exactly the 5 available.
    const first = await asUser(w.userId).post(`/api/orders/${orderId}/lines`).send({ sku: SKU, qty: 5, markupCents: 1000 })
    expect(first.status).toBe(200)
    // Any further add is refused with remaining 0 (no headroom left).
    const second = await asUser(w.userId).post(`/api/orders/${orderId}/lines`).send({ sku: SKU, qty: 1, markupCents: 1000 })
    expect(second.status).toBe(409)
    expect(second.body.error.details.remaining).toBe(0)
  })
})
