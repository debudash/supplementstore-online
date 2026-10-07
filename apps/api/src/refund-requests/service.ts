// Refund requests (ADR-026, ADR-027): a patient asks, the provider decides.
//
// Eligibility (ADR-027), enforced here:
//  - the patient's OWN paid, real (non-synthetic) order;
//  - within REFUND_WINDOW_DAYS (30) of payment;
//  - the patient confirms the product is UNOPENED (the system cannot verify it; the
//    confirmation is stored and shown to the provider, who decides);
//  - one pending request per order (DB partial unique index backs the pre-check).
// Return-shipping logistics are out of scope.
//
// Deciding: in-app (GET/approve/decline on /api/orders/:id/refund-request) or through the
// request's REVIEW LINK (/refund-review/:token, like a pay link; the API still requires the
// provider who owns the order). Accept runs the EXISTING refund path immediately
// (refundOrder: one locked transaction, REFUND journal, restock if unshipped or write-off
// if shipped per ADR-013, patient notice) and only then closes the request, so a failed
// refund leaves it pending. An order already refunded elsewhere closes the request.
//
// Privacy: the PATIENT view never carries the review token or any economics.
import { randomBytes } from 'node:crypto'
import type { Knex } from 'knex'
import type { Actor } from '../auth/types'
import type { Seams } from '../seams/types'
import { createSeams } from '../seams'
import { refundOrder, RefundError } from '../refunds'
import { ApiError, invalidInput, notFound } from '../orders/errors'

export const PATIENT_REFUND_REASONS = ['damaged', 'wrong_item', 'patient_request', 'other'] as const
export type PatientRefundReason = (typeof PATIENT_REFUND_REASONS)[number]
export const REFUND_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const NOTE_MAX = 500

interface RequestRow {
  id: string
  order_id: string
  patient_id: string
  reason_code: PatientRefundReason
  note: string | null
  status: 'pending' | 'approved' | 'declined'
  decision_note: string | null
  decided_by: string | null
  decided_at: Date | null
  created_at: Date
  unopened_confirmed: boolean
  review_token: string
}

/** What the patient sees (no review token, no economics). */
export interface RefundRequestView {
  id: string
  orderId: string
  reasonCode: PatientRefundReason
  note: string | null
  status: 'pending' | 'approved' | 'declined'
  decisionNote: string | null
  decidedAt: string | null
  createdAt: string
  unopenedConfirmed: boolean
}

/** What the provider sees: the patient view plus the review link. */
export interface ProviderRefundRequestView extends RefundRequestView {
  reviewPath: string
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null)

export function toView(r: RequestRow): RefundRequestView {
  return {
    id: r.id,
    orderId: r.order_id,
    reasonCode: r.reason_code,
    note: r.note,
    status: r.status,
    decisionNote: r.decision_note,
    decidedAt: iso(r.decided_at),
    createdAt: new Date(r.created_at).toISOString(),
    unopenedConfirmed: r.unopened_confirmed
  }
}

function toProviderView(r: RequestRow): ProviderRefundRequestView {
  return { ...toView(r), reviewPath: `/refund-review/${r.review_token}` }
}

/** The last moment a refund can be requested for an order paid at `paidAt`. */
export function refundWindowEndsAt(paidAt: Date | string | null): Date | null {
  return paidAt ? new Date(new Date(paidAt).getTime() + REFUND_WINDOW_DAYS * DAY_MS) : null
}

function optionalNote(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw invalidInput(`${field} must be text`, { field })
  const t = value.trim()
  if (t.length > NOTE_MAX) throw invalidInput(`${field} must be at most ${NOTE_MAX} characters`, { field })
  return t || null
}

async function latestRows(db: Knex, orderIds: string[]): Promise<Map<string, RequestRow>> {
  if (orderIds.length === 0) return new Map()
  const rows: RequestRow[] = await db('refund_requests')
    .whereIn('order_id', orderIds)
    .orderBy([{ column: 'order_id' }, { column: 'created_at', order: 'desc' }])
  const out = new Map<string, RequestRow>()
  for (const r of rows) if (!out.has(r.order_id)) out.set(r.order_id, r)
  return out
}

/** Latest request per order, patient-safe view (for list views). */
export async function latestRequestsByOrder(db: Knex, orderIds: string[]): Promise<Map<string, RefundRequestView>> {
  const rows = await latestRows(db, orderIds)
  return new Map([...rows].map(([id, r]) => [id, toView(r)]))
}

/** Patient creates a request on their own paid order (ADR-027 eligibility). */
export async function createRefundRequest(
  db: Knex,
  actor: Actor,
  orderId: string,
  body: unknown,
  now: Date = new Date()
): Promise<RefundRequestView> {
  if (actor.role !== 'patient' || !actor.patientId) throw notFound('No such order', { orderId })
  const patientId: string = actor.patientId
  const b = (body ?? {}) as Record<string, unknown>
  const reasonCode = b.reasonCode
  if (typeof reasonCode !== 'string' || !PATIENT_REFUND_REASONS.includes(reasonCode as PatientRefundReason)) {
    throw invalidInput('A valid reasonCode is required', { allowed: PATIENT_REFUND_REASONS })
  }
  if (b.unopened !== true) {
    throw invalidInput('Refunds are only for unopened products. Please confirm the product is unopened.', { field: 'unopened' })
  }
  const note = optionalNote(b.note, 'note')

  return db.transaction(async (trx) => {
    const order = await trx('orders')
      .where({ id: orderId })
      .forUpdate()
      .first('id', 'patient_id', 'status', 'is_synthetic', 'paid_at')
    if (!order || order.patient_id !== patientId) throw notFound('No such order', { orderId })
    if (order.is_synthetic || order.status !== 'paid') {
      throw new ApiError('NOT_REFUNDABLE', 'A refund can only be requested for a paid order', { status: order.status })
    }
    const endsAt = refundWindowEndsAt(order.paid_at)
    if (!endsAt || endsAt.getTime() < now.getTime()) {
      throw new ApiError('REFUND_WINDOW_CLOSED', `Refunds can be requested within ${REFUND_WINDOW_DAYS} days of payment`, {
        windowEndsAt: endsAt ? endsAt.toISOString() : null
      })
    }
    const pending = await trx('refund_requests').where({ order_id: orderId, status: 'pending' }).first('id')
    if (pending) throw new ApiError('REFUND_REQUEST_EXISTS', 'A refund request for this order is already waiting for your provider')
    const [row] = await trx<RequestRow>('refund_requests')
      .insert({
        order_id: orderId,
        patient_id: patientId,
        reason_code: reasonCode as PatientRefundReason,
        note,
        unopened_confirmed: true,
        review_token: randomBytes(24).toString('base64url')
      })
      .returning('*')
    return toView(row)
  })
}

/** Provider ownership check (404 when not theirs, so existence is not leaked). */
async function assertProviderOwns(db: Knex, actor: Actor, orderId: string): Promise<void> {
  const order = await db('orders').where({ id: orderId }).first('provider_id')
  if (!order || order.provider_id !== actor.providerId) throw notFound('No such order', { orderId })
}

/** Provider: the latest request for one of their orders (with its review link), or null. */
export async function getRefundRequest(db: Knex, actor: Actor, orderId: string): Promise<ProviderRefundRequestView | null> {
  await assertProviderOwns(db, actor, orderId)
  const row = (await latestRows(db, [orderId])).get(orderId)
  return row ? toProviderView(row) : null
}

async function pendingRequest(db: Knex, orderId: string): Promise<RequestRow> {
  const row: RequestRow | undefined = await db('refund_requests').where({ order_id: orderId, status: 'pending' }).first()
  if (!row) throw new ApiError('NO_PENDING_REQUEST', 'There is no open refund request for this order')
  return row
}

/** Provider approves: run the standard refund immediately, then close the request. */
export async function approveRefundRequest(
  db: Knex,
  actor: Actor,
  orderId: string,
  body: unknown,
  seams: Seams = createSeams()
): Promise<{ request: ProviderRefundRequestView; refund: unknown }> {
  await assertProviderOwns(db, actor, orderId)
  const req = await pendingRequest(db, orderId)
  const decisionNote = optionalNote(((body ?? {}) as Record<string, unknown>).note, 'note')

  let refund: unknown = null
  let note = decisionNote
  try {
    refund = await refundOrder(db, actor, orderId, { reasonCode: req.reason_code }, seams)
  } catch (err) {
    if (err instanceof RefundError && err.code === 'ALREADY_REFUNDED') {
      note = note ?? 'This order had already been refunded.'
    } else {
      throw err // request stays pending; nothing changed
    }
  }
  const [row] = await db<RequestRow>('refund_requests')
    .where({ id: req.id, status: 'pending' })
    .update({ status: 'approved', decision_note: note, decided_by: actor.id, decided_at: db.fn.now() })
    .returning('*')
  return { request: toProviderView(row ?? { ...req, status: 'approved', decision_note: note }), refund }
}

/** Provider declines with a required note the patient will see. */
export async function declineRefundRequest(db: Knex, actor: Actor, orderId: string, body: unknown): Promise<ProviderRefundRequestView> {
  await assertProviderOwns(db, actor, orderId)
  const note = optionalNote(((body ?? {}) as Record<string, unknown>).note, 'note')
  if (!note || note.length < 3) throw invalidInput('Give the patient a short reason (at least 3 characters)', { field: 'note' })
  const req = await pendingRequest(db, orderId)
  const [row] = await db<RequestRow>('refund_requests')
    .where({ id: req.id, status: 'pending' })
    .update({ status: 'declined', decision_note: note, decided_by: actor.id, decided_at: db.fn.now() })
    .returning('*')
  if (!row) throw new ApiError('NO_PENDING_REQUEST', 'There is no open refund request for this order')
  return toProviderView(row)
}

// ---- Review link (/refund-review/:token) ----

/** Resolve a review token to its order; 404 unless the caller is the owning provider. */
async function orderForToken(db: Knex, actor: Actor, token: string): Promise<string> {
  const row = await db('refund_requests as r')
    .join('orders as o', 'o.id', 'r.order_id')
    .where('r.review_token', token)
    .first('r.order_id', 'o.provider_id')
  if (!row || row.provider_id !== actor.providerId) throw notFound('No such refund request')
  return row.order_id
}

/** GET /api/refund-review/:token - the request plus the order the provider is deciding on. */
export async function getReview(db: Knex, actor: Actor, token: string) {
  const orderId = await orderForToken(db, actor, token)
  const row: RequestRow = await db('refund_requests').where({ review_token: token }).first()
  const order = await db('orders as o')
    .leftJoin('patients as p', 'p.id', 'o.patient_id')
    .where('o.id', orderId)
    .first('o.id', 'o.status', 'o.subtotal_cents', 'o.paid_at', 'o.fulfilled_at', 'p.name as patient_name')
  const lines = await db('order_lines as l')
    .leftJoin('products as pr', 'pr.sku', 'l.sku')
    .where('l.order_id', orderId)
    .orderBy('l.position')
    .select('l.sku', 'pr.name', 'l.qty', 'l.line_total_cents')
  const endsAt = refundWindowEndsAt(order.paid_at)
  return {
    request: toProviderView(row),
    order: {
      id: order.id,
      status: order.status,
      patientName: order.patient_name ?? null,
      subtotalCents: order.subtotal_cents,
      paidAt: iso(order.paid_at),
      shipped: !!order.fulfilled_at,
      refundWindowEndsAt: endsAt ? endsAt.toISOString() : null,
      items: lines.map((l: { sku: string; name: string | null; qty: number; line_total_cents: number | null }) => ({
        sku: l.sku,
        name: l.name ?? l.sku,
        qty: l.qty,
        lineTotalCents: l.line_total_cents
      }))
    }
  }
}

export async function acceptReview(db: Knex, actor: Actor, token: string, body: unknown, seams: Seams = createSeams()) {
  return approveRefundRequest(db, actor, await orderForToken(db, actor, token), body, seams)
}

export async function declineReview(db: Knex, actor: Actor, token: string, body: unknown) {
  return declineRefundRequest(db, actor, await orderForToken(db, actor, token), body)
}
