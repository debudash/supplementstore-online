// DELETE /api/orders/:id - remove a draft order. A draft never reserves stock (that
// happens at send), so after deleting one the full quantity it held must be available
// to the next order, with no reserve/release movements written. Sent orders cannot be
// deleted (they hold a reservation; cancel releases it), and another provider's order
// is a 404 so existence is not leaked.
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
  post: (url: string) => request(app).post(url).set('X-Demo-User', userId),
  get: (url: string) => request(app).get(url).set('X-Demo-User', userId),
  del: (url: string) => request(app).delete(url).set('X-Demo-User', userId)
})

const SKU = 'PROBIO-50B'

interface World { patientId: string; userId: string }
async function makeWorld(): Promise<World> {
  const practiceId = randomUUID()
  const providerId = randomUUID()
  const patientId = randomUUID()
  const userId = `dd-${randomUUID().slice(0, 12)}`
  await db('practices').insert({ id: practiceId, name: 'Delete Practice' })
  await db('providers').insert({ id: providerId, practice_id: practiceId, name: 'Dr DD', email: `${userId}@dd.example` })
  await db('patients').insert({ id: patientId, practice_id: practiceId, name: 'Pat DD', email: `${patientId}@dd.example`, ship_to: '1 DD St' })
  await db('users').insert({ id: userId, role: 'provider', provider_id: providerId, patient_id: null, display_name: 'Dr DD' })
  return { patientId, userId }
}

async function draftWithAllStock(w: World): Promise<string> {
  const draft = await asUser(w.userId).post('/api/orders').send({ patientId: w.patientId })
  expect(draft.status).toBe(201)
  const orderId = draft.body.id as string
  const line = await asUser(w.userId).post(`/api/orders/${orderId}/lines`).send({ sku: SKU, qty: 5, marginBps: 3000 })
  expect(line.status).toBe(200)
  return orderId
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

describe('DELETE /api/orders/:id (draft)', () => {
  it('removes the draft, its lines and events, and leaves its stock fully available', async () => {
    const w = await makeWorld()
    const orderId = await draftWithAllStock(w)

    const res = await asUser(w.userId).del(`/api/orders/${orderId}`)
    expect(res.status).toBe(204)

    expect(await db('orders').where({ id: orderId }).first()).toBeUndefined()
    expect(await db('order_lines').where({ order_id: orderId })).toHaveLength(0)
    expect(await db('order_events').where({ order_id: orderId })).toHaveLength(0)
    expect(await db('inventory_movements').where({ order_id: orderId })).toHaveLength(0)

    const product = await db('products').where({ sku: SKU }).first()
    expect(product.on_hand_qty - product.reserved_qty).toBe(5)

    // The next order can take all 5 and send them.
    const next = await draftWithAllStock(w)
    const sent = await asUser(w.userId).post(`/api/orders/${next}/send`)
    expect(sent.status).toBe(200)

    const list = await asUser(w.userId).get('/api/orders')
    expect(list.body.orders.map((o: { id: string }) => o.id)).not.toContain(orderId)
  })

  it('refuses to delete a sent order (409) and keeps its reservation', async () => {
    const w = await makeWorld()
    const orderId = await draftWithAllStock(w)
    expect((await asUser(w.userId).post(`/api/orders/${orderId}/send`)).status).toBe(200)

    const res = await asUser(w.userId).del(`/api/orders/${orderId}`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('ORDER_NOT_EDITABLE')

    const product = await db('products').where({ sku: SKU }).first()
    expect(product.reserved_qty).toBe(5)
    expect(await db('orders').where({ id: orderId }).first()).toBeDefined()
  })

  it("returns 404 for another provider's draft and does not delete it", async () => {
    const owner = await makeWorld()
    const other = await makeWorld()
    const orderId = await draftWithAllStock(owner)

    const res = await asUser(other.userId).del(`/api/orders/${orderId}`)
    expect(res.status).toBe(404)
    expect(await db('orders').where({ id: orderId }).first()).toBeDefined()
  })
})
