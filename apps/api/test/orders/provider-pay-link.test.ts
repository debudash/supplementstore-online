// API tests: the provider can recover a patient pay link after send.
//
// GET /api/orders (list) and GET /api/orders/:id/audit now carry payToken + payPath so the
// provider UI can render a copy control after the one-time send response is gone. These
// assert the SECURITY shape the orchestrator required:
//  - a provider sees the token on their OWN sent order (information they already received);
//  - the list is provider-scoped, so another provider's order + token never appear;
//  - cross-provider audit stays 404 (ownership), so a token cannot be harvested that way.
//
// Uses the seed providers prov-ana (Riverside) and prov-ben (Summit) - two providers in
// two different practices - and resets their deletable orders in beforeEach (the T3
// pattern). Runs against real Postgres; migrations via the tsx CLI in beforeAll.
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

const PROVIDER_ANA = 'aaaaaaaa-0000-0000-0000-000000000001'
const PROVIDER_BEN = 'aaaaaaaa-0000-0000-0000-000000000002'
const PAT_CARA = 'cccccccc-0000-0000-0000-000000000001' // Riverside (prov-ana)
const SKU_MAG = 'MAG-GLY-120'

async function resetState(): Promise<void> {
  const deletable = db('orders').whereIn('provider_id', [PROVIDER_ANA, PROVIDER_BEN]).whereNot('status', 'paid').select('id')
  await db('inventory_movements').whereIn('order_id', deletable).del()
  await db('order_events').whereIn('order_id', deletable).del()
  await db('order_lines')
    .whereIn('order_id', db('orders').whereIn('provider_id', [PROVIDER_ANA, PROVIDER_BEN]).whereNot('status', 'paid').select('id'))
    .del()
  await db('orders').whereIn('provider_id', [PROVIDER_ANA, PROVIDER_BEN]).whereNot('status', 'paid').del()
  await db('products').update({ reserved_qty: 0 })
  await seedCore(db)
}

async function sendAnaOrder(): Promise<{ orderId: string; payToken: string }> {
  const draft = await asUser('prov-ana').post('/api/orders').send({ patientId: PAT_CARA })
  expect(draft.status).toBe(201)
  const orderId = draft.body.id as string
  const line = await asUser('prov-ana').post(`/api/orders/${orderId}/lines`).send({ sku: SKU_MAG, qty: 1, markupCents: markupFor(SKU_MAG, 2999) })
  expect(line.status).toBe(200)
  const sent = await asUser('prov-ana').post(`/api/orders/${orderId}/send`)
  expect(sent.status).toBe(200)
  return { orderId, payToken: sent.body.order.payToken as string }
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

describe('provider recovers the pay link from GET /api/orders', () => {
  it('a sent order carries payToken + payPath; a draft carries nulls', async () => {
    const { orderId, payToken } = await sendAnaOrder()
    const draft = await asUser('prov-ana').post('/api/orders').send({ patientId: PAT_CARA })
    const draftId = draft.body.id as string

    const res = await asUser('prov-ana').get('/api/orders')
    expect(res.status).toBe(200)
    const sent = res.body.orders.find((o: { id: string }) => o.id === orderId)
    expect(sent.payToken).toBe(payToken)
    expect(sent.payPath).toBe(`/pay/${payToken}`)

    const draftRow = res.body.orders.find((o: { id: string }) => o.id === draftId)
    expect(draftRow.payToken).toBeNull()
    expect(draftRow.payPath).toBeNull()
  })

  it('the list is provider-scoped: another provider never sees the order or its token', async () => {
    const { orderId, payToken } = await sendAnaOrder()
    const res = await asUser('prov-ben').get('/api/orders')
    expect(res.status).toBe(200)
    const ids = res.body.orders.map((o: { id: string }) => o.id)
    const tokens = res.body.orders.map((o: { payToken: string | null }) => o.payToken)
    expect(ids).not.toContain(orderId)
    expect(tokens).not.toContain(payToken)
  })
})

describe('provider recovers the pay link from the audit view', () => {
  it('the owner audit carries payToken + payPath', async () => {
    const { orderId, payToken } = await sendAnaOrder()
    const res = await asUser('prov-ana').get(`/api/orders/${orderId}/audit`)
    expect(res.status).toBe(200)
    expect(res.body.order.payToken).toBe(payToken)
    expect(res.body.order.payPath).toBe(`/pay/${payToken}`)
  })

  it('a non-owner provider gets 404 and cannot harvest the token via audit', async () => {
    const { orderId } = await sendAnaOrder()
    const res = await asUser('prov-ben').get(`/api/orders/${orderId}/audit`)
    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain('payToken')
  })
})
