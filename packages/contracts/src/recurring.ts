// @cerbo/contracts - recurring schedule request/response types (T9, FR-12, ADR-017).
//
// A recurring schedule generates one CHILD ORDER per cycle. The patient authorizes
// ONCE (token route); each cycle locks the schedule's prices but snapshots FRESH COGS,
// and goes `on_hold` with a reason when stock is short, margin would go negative, or the
// schedule is not authorized (ADR-017) rather than silently absorbing a cost increase.
//
// PRIVACY (NFR-5, RT-10): the patient-facing schedule view is a STRICT whitelist, the
// same discipline as the pay view - it never carries COGS, fee, margin, or any provider
// economics. The provider-facing views DO carry economics (provider surface).
import type { OrderStatus } from './orders'

/** Schedule lifecycle (docs/ARCHITECTURE.md section 3). */
export type ScheduleStatus = 'active' | 'paused' | 'cancelled'

/** Why a cycle could not complete and went on_hold (ADR-017, EVAL-11b/c/d). */
export type HoldReason =
  | 'INSUFFICIENT_STOCK'
  | 'MARGIN_NEGATIVE'
  | 'NOT_AUTHORIZED'
  | 'PAYMENT_DECLINED'

// ---- Provider surface ----

/** One schedule line as the provider defines it: SKU, quantity, locked unit price. */
export interface ScheduleLineView {
  id: string
  position: number
  sku: string
  name: string
  qty: number
  unitPriceCents: number
  /** The provider's per-unit markup (ADR-028). */
  unitMarkupCents: number
}

/** A child order produced by a cycle, summarised for the provider's schedule view. */
export interface ScheduleCycleView {
  orderId: string
  cycleNumber: number
  status: Extract<OrderStatus, 'paid' | 'on_hold' | 'cancelled'>
  holdReason: HoldReason | null
  subtotalCents: number | null
  createdAt: string
}

/** Provider-facing schedule, with lines and recent cycles. */
export interface ScheduleView {
  id: string
  patientId: string
  status: ScheduleStatus
  intervalDays: number
  nextRunAt: string | null
  authorized: boolean
  authorizedAt: string | null
  /** Patient authorization link (unguessable token), shown for the demo. */
  payUrl: string
  perCycleSubtotalCents: number
  lines: ScheduleLineView[]
  cycles: ScheduleCycleView[]
  createdAt: string
}

/** POST /api/schedules request: open a recurring schedule for the provider's patient. */
export interface CreateScheduleRequest {
  patientId: string
  /** Cycle cadence in days, 7..90 (default 30). */
  intervalDays?: number
  lines: Array<{
    sku: string
    qty: number
    /** Per-unit dollar markup, 0..100000; each cycle charges current COGS + markup + fee (ADR-028). */
    markupCents: number
  }>
}

/** Result of running one cycle (provider "Run cycle now", or the run-due job). */
export interface RunCycleResult {
  scheduleId: string
  /** The cycle order touched this run, or null when nothing was due and nothing retried. */
  cycle: ScheduleCycleView | null
  /** True when a new cycle order was created this run; false on retry or no-op. */
  created: boolean
  note: string
}

// ---- Patient surface (token route) - STRICT whitelist, no economics ----

/** One schedule item as the patient authorizes it: name, qty, unit price only. */
export interface ScheduleAuthorizeItem {
  name: string
  qty: number
  unitPriceCents: number
}

/**
 * GET /api/pay/schedule/:token - the patient-safe schedule view (FR-12 AC2).
 * Exhaustive key set: patientFirstName, intervalDays, items, perCycleTotalCents,
 * authorized. Never COGS, fee, margin, or provider identity (matches the shape
 * apps/web/src/views/patient/ScheduleAuthorize.vue consumes).
 */
export interface ScheduleAuthorizeView {
  patientFirstName: string
  intervalDays: number
  items: ScheduleAuthorizeItem[]
  perCycleTotalCents: number
  authorized: boolean
}

/** POST /api/pay/schedule/:token/authorize result. Patient-safe; idempotent. */
export interface ScheduleAuthorizeResult {
  authorized: boolean
}
