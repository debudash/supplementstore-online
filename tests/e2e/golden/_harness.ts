// T13 e2e harness: one shared Express app wired to REAL Postgres (DATABASE_URL),
// exercised through the HTTP surface exactly as a browser would. No mocks, no stubbed
// db - the point of these golden evals is to prove the whole system, so money, ledger,
// and inventory all run against the real schema and triggers (AGENTS.md section 10,
// RT-A / AI-08).
//
// Isolation: `npm run test:e2e` is its own vitest invocation (separate from `npm test`),
// so this suite is the sole writer of its database. Spec files still run SERIALLY
// (fileParallelism:false in vitest.config.ts) because they share one Postgres and one
// inventory pool; each spec restores canonical stock in beforeEach. Paid orders cannot
// be torn down (payments/journals are append-only), so every scenario creates FRESH
// order ids and we never rely on deleting them.
import request from 'supertest'
import { expect, it } from 'vitest'

import { db } from '../../../apps/api/src/db/knex'
import { createApp } from '../../../apps/api/src/app'
import { createKnexActorLoader } from '../../../apps/api/src/auth/loadActor'
import { recordResult, type Status } from './reporter'

export { db }
export const app = createApp({ db, loadActor: createKnexActorLoader(db) })

// Provider/admin callers use the demo-user header; patient callers use the token only.
export const asUser = (userId: string) => ({
  post: (url: string) => request(app).post(url).set('X-Demo-User', userId),
  patch: (url: string) => request(app).patch(url).set('X-Demo-User', userId),
  delete: (url: string) => request(app).delete(url).set('X-Demo-User', userId),
  get: (url: string) => request(app).get(url).set('X-Demo-User', userId)
})
export const anon = {
  post: (url: string) => request(app).post(url),
  get: (url: string) => request(app).get(url)
}

// Canonical seed identities and SKUs (docs/EVALS.md seed table). The evals are written
// against the real seed subjects (prov-ana / pat-cara) for authenticity.
export const PROV_ANA = 'prov-ana'
export const PROV_BEN = 'prov-ben'
export const ADMIN = 'admin-cerbo'
export const PROVIDER_ANA_ID = 'aaaaaaaa-0000-0000-0000-000000000001'
export const PAT_CARA = 'cccccccc-0000-0000-0000-000000000001'
export const PAT_DEV = 'cccccccc-0000-0000-0000-000000000002'

export const SKU = {
  MAG: 'MAG-GLY-120',
  VITD: 'VITD3-K2',
  OMEGA: 'OMEGA3-1000',
  PROBIO: 'PROBIO-50B',
  ZINC: 'ZINC-30'
} as const

/** Canonical on-hand stock from the seed table; restored before every scenario. */
export const CANONICAL_STOCK: Record<string, number> = {
  [SKU.MAG]: 50,
  [SKU.VITD]: 40,
  [SKU.OMEGA]: 30,
  [SKU.PROBIO]: 5,
  [SKU.ZINC]: 0
}

/** Canonical unit COGS from the seed table. Restored each scenario because EVAL-11d
 *  mutates MAG's COGS to force a MARGIN_NEGATIVE cycle hold. */
export const CANONICAL_COGS: Record<string, number> = {
  [SKU.MAG]: 1450,
  [SKU.VITD]: 1125,
  [SKU.OMEGA]: 2280,
  [SKU.PROBIO]: 2675,
  [SKU.ZINC]: 690
}

/** Restore every SKU to its canonical on-hand (reserved 0) and canonical unit COGS. */
export async function resetStock(): Promise<void> {
  for (const sku of Object.keys(CANONICAL_STOCK)) {
    await db('products')
      .where({ sku })
      .update({ on_hand_qty: CANONICAL_STOCK[sku], reserved_qty: 0, unit_cogs_cents: CANONICAL_COGS[sku] })
  }
}

/**
 * Delete every NON-terminal order (draft/sent/expired/cancelled/on_hold) and its
 * children. Paid and refunded orders are left in place - their payments/journals are
 * append-only and cannot be torn down, and each scenario uses fresh ids anyway.
 *
 * Why this matters: `resetStock` zeroes reserved_qty, but a leftover `sent` order from a
 * prior scenario still logically holds a reservation. The reservation-expiry sweep
 * (EVAL-14) scans ALL sent orders globally, so without this cleanup it would try to
 * release a reservation we already zeroed and underflow the reserved_qty >= 0 constraint.
 * Clearing open orders keeps each scenario hermetic.
 */
export async function cleanupOpenOrders(): Promise<void> {
  const open = db('orders')
    .whereIn('status', ['draft', 'sent', 'expired', 'cancelled', 'on_hold'])
    .select('id')
  await db('inventory_movements').whereIn('order_id', open).del()
  await db('order_events').whereIn('order_id', open).del()
  await db('order_lines').whereIn('order_id', open).del()
  await db('orders').whereIn('status', ['draft', 'sent', 'expired', 'cancelled', 'on_hold']).del()
}

/** Standard per-scenario reset: clear open orders, then restore canonical stock. */
export async function resetState(): Promise<void> {
  await cleanupOpenOrders()
  await resetStock()
}

export interface Line {
  sku: string
  qty: number
  price: number
}

/** The canonical EVAL-01 basket. */
export const EVAL01_LINES: Line[] = [
  { sku: SKU.MAG, qty: 2, price: 2999 },
  { sku: SKU.VITD, qty: 1, price: 2499 }
]

/** Open a draft for prov-ana / pat-cara and return its id. */
export async function newDraft(patientId: string = PAT_CARA, user: string = PROV_ANA): Promise<string> {
  const res = await asUser(user).post('/api/orders').send({ patientId })
  expect(res.status).toBe(201)
  return res.body.id as string
}

/** Create a draft, add lines, and send it. Returns order id + patient pay token. */
export async function sendOrderHttp(
  lines: Line[],
  patientId: string = PAT_CARA,
  user: string = PROV_ANA
): Promise<{ orderId: string; token: string }> {
  const orderId = await newDraft(patientId, user)
  for (const l of lines) {
    const r = await asUser(user)
      .post(`/api/orders/${orderId}/lines`)
      .send({ sku: l.sku, qty: l.qty, unitPriceCents: l.price })
    expect(r.status).toBe(200)
  }
  const send = await asUser(user).post(`/api/orders/${orderId}/send`).send({})
  expect(send.status).toBe(200)
  return { orderId, token: send.body.order.payToken as string }
}

/** Pay an order through the patient token with a fresh idempotency key. */
export async function payHttp(token: string, idempotencyKey: string) {
  return anon.post(`/api/pay/${token}`).send({ idempotencyKey })
}

/** True when a pre-registered route is still a 501 stub (behaviour not yet merged). */
export function isStub(res: { status: number }): boolean {
  return res.status === 501
}

/**
 * Register an eval/red-team case. On success the id is recorded `pass`; on a thrown
 * assertion it is recorded `fail` (a real product finding) and rethrown so vitest also
 * fails. A case may return the string 'pending' to record itself as pending (used when
 * a probed route is still a 501 stub for a not-yet-merged task), which keeps the spec in
 * place so it auto-enables - and auto-asserts - the moment the behaviour lands.
 */
export function evalCase(id: string, name: string, fn: () => Promise<void | Status>, timeoutMs?: number): void {
  it(
    `${id} ${name}`,
    async () => {
      let outcome: Status = 'pass'
      try {
        const r = await fn()
        if (r === 'pending') outcome = 'pending'
      } catch (err) {
        recordResult(id, 'fail', err instanceof Error ? err.message : String(err))
        throw err
      }
      recordResult(id, outcome)
    },
    timeoutMs
  )
}
