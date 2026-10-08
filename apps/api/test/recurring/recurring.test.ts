// T9 API tests: recurring schedules + cycles (FR-12, ADR-017; EVAL-11/11b/11c/11d; RT-13).
//
// Runs against real Postgres (DATABASE_URL). Migrations applied via the tsx CLI in
// beforeAll (the T2/T3/T4-proven pattern; db.migrate.latest() throws under vitest).
//
// ISOLATION: a DEDICATED practice/provider/patient (not the seed prov-ana/prov-ben that
// orders.test.ts deletes). Cycles PAY and post to the append-only ledger, so paid orders
// cannot be torn down; every test creates a FRESH schedule and we reset only our SKUs'
// stock AND cogs to canonical in beforeEach (EVAL-11d mutates MAG cogs).
//
// REUSE PROOF: the happy-path test asserts the cycle PAYMENT journal has the exact
// per-line, per-account structure T4's postPaymentJournal produces (4 entries/line,
// CASH/COGS/PAYABLE/FEE, journal sums to 0) - demonstrating the cycle routes through
// T4's posting function and does not duplicate posting code.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { db } from '../../src/db/knex'
import { createApp } from '../../src/app'
import { createKnexActorLoader } from '../../src/auth/loadActor'
import { seedCore } from '../../src/db/seeds/01_core'
import { createSeams } from '../../src/seams'
import { runOneSchedule } from '../../src/recurring/service'
import { runDueSchedules } from '../../src/jobs/recurring'
import { markupFor } from '../pricing'

const apiRoot = path.resolve(__dirname, '../..')
function migrateViaCli(): void {
  execFileSync('npm', ['run', 'db:migrate'], { cwd: apiRoot, stdio: 'inherit', shell: process.platform === 'win32' })
}

const app = createApp({ db, loadActor: createKnexActorLoader(db) })
const asUser = (userId: string) => ({
  post: (url: string) => request(app).post(url).set('X-Demo-User', userId),
  get: (url: string) => request(app).get(url).set('X-Demo-User', userId)
})
const anon = {
  post: (url: string) => request(app).post(url),
  get: (url: string) => request(app).get(url)
}

// Dedicated fixtures (NOT the seed prov-ana/prov-ben that orders.test.ts deletes).
const PRACTICE = '99999999-9999-9999-9999-999999999999'
const PROVIDER = 'aaaaaaaa-0000-0000-0000-0000000000f9'
const PATIENT = 'cccccccc-0000-0000-0000-0000000000f9'
const PROV_USER = 't9-prov'
const SKU_MAG = 'MAG-GLY-120'
const SKU_PROBIO = 'PROBIO-50B'
const SKU_VITD = 'VITD3-K2'

// cogs + on_hand are the protected EVALS seed facts. A cycle prices each line from the
// CURRENT cogs + the schedule line's markup at run time (ADR-028).
const CANONICAL: Record<string, { onHand: number; cogs: number }> = {
  [SKU_MAG]: { onHand: 50, cogs: 1450 },
  [SKU_PROBIO]: { onHand: 5, cogs: 2675 },
  [SKU_VITD]: { onHand: 40, cogs: 1125 }
}

async function setupFixtures(): Promise<void> {
  await seedCore(db)
  await db('practices').insert({ id: PRACTICE, name: 'T9 Practice' }).onConflict('id').merge()
  await db('providers')
    .insert({ id: PROVIDER, practice_id: PRACTICE, name: 'Dr. T9', email: 't9@example.com' })
    .onConflict('id')
    .merge()
  await db('patients')
    .insert({ id: PATIENT, practice_id: PRACTICE, name: 'Remy Patient', email: 'remy@example.com', ship_to: '9 T9 St' })
    .onConflict('id')
    .merge()
  await db('users')
    .insert({ id: PROV_USER, role: 'provider', provider_id: PROVIDER, patient_id: null, display_name: 'Dr. T9' })
    .onConflict('id')
    .merge()
}

async function resetStock(): Promise<void> {
  for (const [sku, { onHand, cogs }] of Object.entries(CANONICAL)) {
    await db('products')
      .where({ sku })
      .update({ on_hand_qty: onHand, reserved_qty: 0, unit_cogs_cents: cogs })
  }
}

beforeAll(async () => {
  migrateViaCli()
  await setupFixtures()
})
beforeEach(async () => {
  await resetStock()
})
afterAll(async () => {
  await db.destroy()
})

// A schedule line carries product + quantity + the provider's per-unit markup (ADR-028).
// markupFor(sku, price) picks the markup that prices the line at the EVALS price at seed COGS.
interface Line {
  sku: string
  qty: number
  markupCents: number
}

/** Create a schedule for the T9 patient; return its id + authorize token. */
async function createSchedule(lines: Line[], intervalDays = 30): Promise<{ id: string; token: string }> {
  const res = await asUser(PROV_USER).post('/api/schedules').send({ patientId: PATIENT, intervalDays, lines })
  expect(res.status).toBe(201)
  const id = res.body.id as string
  const token = (res.body.payUrl as string).replace('/pay/schedule/', '')
  return { id, token }
}

async function authorize(token: string): Promise<void> {
  const res = await anon.post(`/api/pay/schedule/${token}/authorize`).send({})
  expect(res.status).toBe(200)
  expect(res.body.authorized).toBe(true)
}

const MAG_SCHEDULE: Line[] = [{ sku: SKU_MAG, qty: 1, markupCents: markupFor(SKU_MAG, 2999) }]

describe('EVAL-11 happy path: authorized cycle pays, price from fresh COGS + markup', () => {
  it('produces a recurring_cycle child order, paid, fee 23, margin 1526 (the markup), MAG on_hand -1', async () => {
    const { id, token } = await createSchedule(MAG_SCHEDULE)
    await authorize(token)

    const run = await asUser(PROV_USER).post(`/api/schedules/${id}/run`).send({})
    expect(run.status).toBe(200)
    expect(run.body.created).toBe(true)
    expect(run.body.cycle.status).toBe('paid')
    expect(run.body.cycle.cycleNumber).toBe(1)

    const order = await db('orders').where({ schedule_id: id }).first()
    expect(order.kind).toBe('recurring_cycle')
    expect(order.status).toBe('paid')
    expect(order.subtotal_cents).toBe(2999)
    // ADR-028: 2999 x 0.75% = 22.49 -> 23 (fee rounded up); the provider nets exactly 1526.
    expect(order.fee_cents).toBe(23)
    expect(order.margin_cents).toBe(1526)
    expect(order.cogs_cents).toBe(1450)

    // Stock: recurring sale decrements on_hand only (reserved untouched).
    const mag = await db('products').where({ sku: SKU_MAG }).first()
    expect(mag.on_hand_qty).toBe(49)
    expect(mag.reserved_qty).toBe(0)
    const sales = await db('inventory_movements').where({ order_id: order.id, reason: 'sale' })
    expect(sales).toHaveLength(1)
    expect(sales[0].delta_on_hand).toBe(-1)
    expect(sales[0].delta_reserved).toBe(0)

    // Exactly one payment at the subtotal.
    const payments = await db('payments').where({ order_id: order.id })
    expect(payments).toHaveLength(1)
    expect(payments[0].amount_cents).toBe(2999)

    // REUSE: the PAYMENT journal is the one postPaymentJournal builds - 1 line x 4 accounts,
    // balanced, line_id set, provider/practice attributed.
    const journals = await db('journals').where({ order_id: order.id, type: 'PAYMENT' })
    expect(journals).toHaveLength(1)
    const entries = await db('ledger_entries').where({ journal_id: journals[0].id })
    expect(entries).toHaveLength(4)
    for (const e of entries) {
      expect(e.line_id).toBeTruthy()
      expect(e.provider_id).toBe(PROVIDER)
      expect(e.practice_id).toBe(PRACTICE)
    }
    const sumBy = (a: string) => entries.filter((e) => e.account === a).reduce((s, e) => s + e.amount_cents, 0)
    expect(sumBy('CASH_CLEARING')).toBe(2999)
    expect(sumBy('COGS_RECOVERY')).toBe(-1450)
    expect(sumBy('PROVIDER_PAYABLE')).toBe(-1526)
    expect(sumBy('PLATFORM_FEE_REVENUE')).toBe(-23)
    expect(entries.reduce((s, e) => s + e.amount_cents, 0)).toBe(0)
  })
})

describe('ADR-028: a cycle prices from the CURRENT COGS + the schedule markup at run time', () => {
  it('a COGS change before the run flows into the price; the provider keeps the markup', async () => {
    const { id, token } = await createSchedule(MAG_SCHEDULE) // 2999 at creation (markup 1526)
    await authorize(token)
    // COGS rises AFTER creation; the cycle must price from the current value.
    await db('products').where({ sku: SKU_MAG }).update({ unit_cogs_cents: 1550 })

    const run = await asUser(PROV_USER).post(`/api/schedules/${id}/run`).send({})
    expect(run.body.cycle.status).toBe('paid')
    const order = await db('orders').where({ schedule_id: id }).first()
    // (1550 + 1526) * 10000 / 9925 = 3099.24 -> 3100; fee 0.75% = 23.25 -> 24 (rounded up);
    // margin 3100 - 1550 - 24 = 1526: exactly the markup, unchanged by the cost rise.
    expect(order.subtotal_cents).toBe(3100)
    expect(order.fee_cents).toBe(24)
    expect(order.margin_cents).toBe(1526)
    expect(order.cogs_cents).toBe(1550)
    const line = await db('order_lines').where({ order_id: order.id }).first()
    expect(line.unit_markup_cents).toBe(1526)
  })
})

describe('EVAL-11b: insufficient stock parks the cycle on_hold with no money moved', () => {
  it('PROBIO x6 (only 5 on hand) -> on_hold INSUFFICIENT_STOCK, no journal, no payment, stock untouched', async () => {
    const { id, token } = await createSchedule([{ sku: SKU_PROBIO, qty: 6, markupCents: markupFor(SKU_PROBIO, 4000) }])
    await authorize(token)

    const run = await asUser(PROV_USER).post(`/api/schedules/${id}/run`).send({})
    expect(run.status).toBe(200)
    expect(run.body.cycle.status).toBe('on_hold')
    expect(run.body.cycle.holdReason).toBe('INSUFFICIENT_STOCK')

    const order = await db('orders').where({ schedule_id: id }).first()
    expect(order.status).toBe('on_hold')
    expect(order.hold_reason).toBe('INSUFFICIENT_STOCK')
    expect(order.subtotal_cents).toBeNull()
    expect(await db('journals').where({ order_id: order.id }).then((r) => r.length)).toBe(0)
    expect(await db('payments').where({ order_id: order.id }).then((r) => r.length)).toBe(0)
    const probio = await db('products').where({ sku: SKU_PROBIO }).first()
    expect(probio.on_hand_qty).toBe(5)
  })
})

describe('EVAL-11c: an unauthorized schedule parks the cycle on_hold', () => {
  it('run without authorization -> on_hold NOT_AUTHORIZED, no journal', async () => {
    const { id } = await createSchedule(MAG_SCHEDULE) // deliberately NOT authorized
    const run = await asUser(PROV_USER).post(`/api/schedules/${id}/run`).send({})
    expect(run.status).toBe(200)
    expect(run.body.cycle.status).toBe('on_hold')
    expect(run.body.cycle.holdReason).toBe('NOT_AUTHORIZED')

    const order = await db('orders').where({ schedule_id: id }).first()
    expect(order.hold_reason).toBe('NOT_AUTHORIZED')
    expect(await db('journals').where({ order_id: order.id }).then((r) => r.length)).toBe(0)
  })
})

describe('EVAL-11d: a COGS increase passes through to the patient, never into a loss (ADR-028)', () => {
  it('raise MAG cogs to 3000 -> the cycle pays at 4561 and the provider still nets the 1526 markup', async () => {
    const { id, token } = await createSchedule(MAG_SCHEDULE)
    await authorize(token)

    // Fresh COGS per cycle: the price is re-derived from COGS + markup, so the margin holds.
    await db('products').where({ sku: SKU_MAG }).update({ unit_cogs_cents: 3000 })
    const run = await asUser(PROV_USER).post(`/api/schedules/${id}/run`).send({})
    expect(run.body.cycle.status).toBe('paid')

    const order = await db('orders').where({ schedule_id: id }).first()
    // (3000 + 1526) * 10000 / 9925 = 4560.20 -> 4561; fee 0.75% = 34.21 -> 35; margin
    // 4561 - 3000 - 35 = 1526: exactly the markup.
    expect(order.subtotal_cents).toBe(4561)
    expect(order.fee_cents).toBe(35)
    expect(order.margin_cents).toBe(1526)
    expect(await db('journals').where({ order_id: order.id, type: 'PAYMENT' }).then((r) => r.length)).toBe(1)
  })
})

describe('a declined saved method parks the cycle on_hold (not a silent failure)', () => {
  it('derived subtotal 1313 (stub decline) -> on_hold PAYMENT_DECLINED, no journal', async () => {
    // Pick the markup that prices VITD at the stub gateway's decline trigger (1313).
    const { id, token } = await createSchedule([{ sku: SKU_VITD, qty: 1, markupCents: markupFor(SKU_VITD, 1313) }])
    await authorize(token)
    const run = await asUser(PROV_USER).post(`/api/schedules/${id}/run`).send({})
    expect(run.body.cycle.status).toBe('on_hold')
    expect(run.body.cycle.holdReason).toBe('PAYMENT_DECLINED')
    const order = await db('orders').where({ schedule_id: id }).first()
    expect(await db('journals').where({ order_id: order.id }).then((r) => r.length)).toBe(0)
  })
})

describe('RT-13: a cycle triggered twice for the same period yields exactly ONE child order', () => {
  it('two parallel runs (row lock + next_run_at due-gate) -> 1 order, 1 journal, 1 payment', async () => {
    const { id, token } = await createSchedule(MAG_SCHEDULE)
    await authorize(token)
    const seams = createSeams()
    const now = new Date(Date.now() + 1000) // safely at/after next_run_at

    const results = await Promise.allSettled([
      runOneSchedule(db, id, now, seams),
      runOneSchedule(db, id, now, seams)
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ created: boolean }>[]
    expect(fulfilled).toHaveLength(2) // neither throws
    // Exactly one of the two actually created the cycle.
    expect(fulfilled.filter((r) => r.value.created)).toHaveLength(1)

    const orders = await db('orders').where({ schedule_id: id })
    expect(orders).toHaveLength(1)
    expect(orders[0].cycle_number).toBe(1)
    expect(await db('payments').where({ order_id: orders[0].id }).then((r) => r.length)).toBe(1)
    expect(await db('journals').where({ order_id: orders[0].id, type: 'PAYMENT' }).then((r) => r.length)).toBe(1)

    // MAG sold exactly once.
    const mag = await db('products').where({ sku: SKU_MAG }).first()
    expect(mag.on_hand_qty).toBe(49)
  })

  it('the run-due job is idempotent: running it twice does not create a second cycle', async () => {
    const { id, token } = await createSchedule(MAG_SCHEDULE)
    await authorize(token)
    await runDueSchedules(db)
    await runDueSchedules(db) // second sweep: schedule no longer due
    const orders = await db('orders').where({ schedule_id: id })
    expect(orders).toHaveLength(1)
    expect(orders[0].status).toBe('paid')
  })
})

describe('FR-12 AC2 patient token view (strict whitelist, no economics)', () => {
  it('GET /api/pay/schedule/:token returns only patient-safe keys; POST authorize flips it', async () => {
    const { token } = await createSchedule(MAG_SCHEDULE)

    const before = await anon.get(`/api/pay/schedule/${token}`)
    expect(before.status).toBe(200)
    expect(Object.keys(before.body).sort()).toEqual([
      'authorized',
      'intervalDays',
      'items',
      'patientFirstName',
      'perCycleTotalCents'
    ])
    expect(before.body.authorized).toBe(false)
    expect(before.body.intervalDays).toBe(30)
    expect(before.body.perCycleTotalCents).toBe(2999)
    expect(before.body.patientFirstName).toBe('Remy')
    for (const item of before.body.items) {
      expect(Object.keys(item).sort()).toEqual(['name', 'qty', 'unitPriceCents'])
    }
    // No economics anywhere in the patient payload.
    const blob = JSON.stringify(before.body).toLowerCase()
    for (const leak of ['cogs', 'margin', 'fee', 'provider', 'practice']) {
      expect(blob).not.toContain(leak)
    }

    await authorize(token)
    const after = await anon.get(`/api/pay/schedule/${token}`)
    expect(after.body.authorized).toBe(true)
  })

  it('unknown token returns 404 and leaks nothing', async () => {
    const res = await anon.get(`/api/pay/schedule/${'z'.repeat(32)}`)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('authorize is idempotent', async () => {
    const { token } = await createSchedule(MAG_SCHEDULE)
    await authorize(token)
    await authorize(token) // second call must not error or change the result
    const view = await anon.get(`/api/pay/schedule/${token}`)
    expect(view.body.authorized).toBe(true)
  })
})

describe('FR-12 AC5 lifecycle + ownership', () => {
  it('pause stops cycles; resume restores them; cancel is terminal', async () => {
    const { id, token } = await createSchedule(MAG_SCHEDULE)
    await authorize(token)

    const paused = await asUser(PROV_USER).post(`/api/schedules/${id}/pause`).send({})
    expect(paused.body.status).toBe('paused')
    // A paused schedule does not run a cycle.
    const runPaused = await asUser(PROV_USER).post(`/api/schedules/${id}/run`).send({})
    expect(runPaused.body.created).toBe(false)
    expect(await db('orders').where({ schedule_id: id }).then((r) => r.length)).toBe(0)

    const resumed = await asUser(PROV_USER).post(`/api/schedules/${id}/resume`).send({})
    expect(resumed.body.status).toBe('active')

    const cancelled = await asUser(PROV_USER).post(`/api/schedules/${id}/cancel`).send({})
    expect(cancelled.body.status).toBe('cancelled')
    const pauseCancelled = await asUser(PROV_USER).post(`/api/schedules/${id}/pause`).send({})
    expect(pauseCancelled.status).toBe(409)
    expect(pauseCancelled.body.error.code).toBe('SCHEDULE_NOT_ACTIONABLE')
  })

  it("another provider cannot see or run this schedule (404, no leak)", async () => {
    const { id } = await createSchedule(MAG_SCHEDULE)
    const res = await asUser('prov-ben').post(`/api/schedules/${id}/run`).send({})
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it.each([
    ['no markup', { sku: SKU_MAG, qty: 1 }],
    ['markup over $1,000', { sku: SKU_MAG, qty: 1, markupCents: 100001 }],
    ['negative markup', { sku: SKU_MAG, qty: 1, markupCents: -1 }]
  ])('rejects a schedule line with %s (400, ADR-028)', async (_label, line) => {
    const res = await asUser(PROV_USER).post('/api/schedules').send({ patientId: PATIENT, lines: [line] })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_INPUT')
  })
})
