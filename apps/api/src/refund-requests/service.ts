// Refund requests: a patient asks, the provider decides (ADR-023 compatible - no return).
//
// - Patient: POST /api/patient/orders/:id/refund-request { reasonCode, note? } on their OWN
//   paid, real (non-synthetic) order. One pending request per order (DB partial unique
//   index backs the pre-check against a double tap).
// - Provider: GET /api/orders/:id/refund-request (latest), POST .../approve, POST .../decline
//   { note }. Approve runs the EXISTING refund path (refundOrder: one locked transaction,
//   REFUND journal, restock or write-off, patient notice) and only then marks the request
//   approved, so a failed refund leaves the request pending. If the order was already
//   refunded (e.g. by Cerbo Admin), the request is closed as approved with a note.
//
// Privacy: the patient-facing view carries status, reason, dates and the decision note -
// never amounts beyond what the patient already sees, never economics.
import type { Knex } from 'knex'
import type { Actor } from '../auth/types'
import type { Seams } from '../seams/types'
import { createSeams } from '../seams'
import { refundOrder, RefundError } from '../refunds'
import { ApiError, invalidInput, notFound } from '../orders/errors'

export const PATIENT_REFUND_REASONS = ['damaged', 'wrong_item', 'patient_request', 'other'] as const
export type PatientRefundReason = (typeof PATIENT_REFUND_REASONS)[number]
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
}

export interface RefundRequestView {
  id: string
  orderId: string
  reasonCode: PatientRefundReason
  note: string | null
  status: 'pending' | 'approved' | 'declined'
  decisionNote: string | null
  decidedAt: string | null
  createdAt: string
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
    createdAt: new Date(r.created_at).toISOString()
  }
}

function optionalNote(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw invalidInput(`${field} must be text`, { field })
  const t = value.trim()
  if (t.length > NOTE_MAX) throw invalidInput(`${field} must be at most ${NOTE_MAX} characters`, { field })
  return t || null
}

/** Latest request per order (for list views). */
export async function latestRequestsByOrder(db: Knex, orderIds: string[]): Promise<Map<string, RefundRequestView>> {
  if (orderIds.length === 0) return new Map()
  const rows: RequestRow[] = await db('refund_requests')
    .whereIn('order_id', orderIds)
    .orderBy([{ column: 'order_id' }, { column: 'created_at', order: 'desc' }])
  const out = new Map<string, RefundRequestView>()
  for (const r of rows) if (!out.has(r.order_id)) out.set(r.order_id, toView(r))
  return out
}

/** Patient creates a request on their own paid order. */
export async function createRefundRequest(db: Knex, actor: Actor, orderId: string, body: unknown): Promise<RefundRequestView> {
  if (actor.role !== 'patient' || !actor.patientId) throw notFound('No such order', { orderId })
  const patientId: string = actor.patientId
  const b = (body ?? {}) as Record<string, unknown>
  const reasonCode = b.reasonCode
  if (typeof reasonCode !== 'string' || !PATIENT_REFUND_REASONS.includes(reasonCode as PatientRefundReason)) {
    throw invalidInput('A valid reasonCode is required', { allowed: PATIENT_REFUND_REASONS })
  }
  const note = optionalNote(b.note, 'note')

  return db.transaction(async (trx) => {
    const order = await trx('orders').where({ id: orderId }).forUpdate().first('id', 'patient_id', 'status', 'is_synthetic')
    if (!order || order.patient_id !== patientId) throw notFound('No such order', { orderId })
    if (order.is_synthetic || order.status !== 'paid') {
      throw new ApiError('NOT_REFUNDABLE', 'A refund can only be requested for a paid order', { status: order.status })
    }
    const pending = await trx('refund_requests').where({ order_id: orderId, status: 'pending' }).first('id')
    if (pending) throw new ApiError('REFUND_REQUEST_EXISTS', 'A refund request for this order is already waiting for your provider')
    const [row] = await trx<RequestRow>('refund_requests')
      .insert({ order_id: orderId, patient_id: patientId, reason_code: reasonCode as PatientRefundReason, note })
      .returning('*')
    return toView(row)
  })
}

/** Provider ownership check (404 when not theirs, so existence is not leaked). */
async function assertProviderOwns(db: Knex, actor: Actor, orderId: string): Promise<void> {
  const order = await db('orders').where({ id: orderId }).first('provider_id')
  if (!order || order.provider_id !== actor.providerId) throw notFound('No such order', { orderId })
}

/** Provider: the latest request for one of their orders, or null. */
export async function getRefundRequest(db: Knex, actor: Actor, orderId: string): Promise<RefundRequestView | null> {
  await assertProviderOwns(db, actor, orderId)
  return (await latestRequestsByOrder(db, [orderId])).get(orderId) ?? null
}

async function pendingRequest(db: Knex, orderId: string): Promise<RequestRow> {
  const row: RequestRow | undefined = await db('refund_requests').where({ order_id: orderId, status: 'pending' }).first()
  if (!row) throw new ApiError('NO_PENDING_REQUEST', 'There is no open refund request for this order')
  return row
}

/** Provider approves: run the standard refund, then close the request. */
export async function approveRefundRequest(
  db: Knex,
  actor: Actor,
  orderId: string,
  body: unknown,
  seams: Seams = createSeams()
): Promise<{ request: RefundRequestView; refund: unknown }> {
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
  return { request: toView(row ?? { ...req, status: 'approved', decision_note: note }), refund }
}

/** Provider declines with a required note the patient will see. */
export async function declineRefundRequest(db: Knex, actor: Actor, orderId: string, body: unknown): Promise<RefundRequestView> {
  await assertProviderOwns(db, actor, orderId)
  const note = optionalNote(((body ?? {}) as Record<string, unknown>).note, 'note')
  if (!note || note.length < 3) throw invalidInput('Give the patient a short reason (at least 3 characters)', { field: 'note' })
  const req = await pendingRequest(db, orderId)
  const [row] = await db<RequestRow>('refund_requests')
    .where({ id: req.id, status: 'pending' })
    .update({ status: 'declined', decision_note: note, decided_by: actor.id, decided_at: db.fn.now() })
    .returning('*')
  if (!row) throw new ApiError('NO_PENDING_REQUEST', 'There is no open refund request for this order')
  return toView(row)
}
