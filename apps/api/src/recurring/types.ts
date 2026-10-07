// API-side recurring types (T9), mirroring packages/contracts/src/recurring.ts.
// apps/api does not depend on @cerbo/contracts (it exports only its index barrel), so
// these shapes are declared locally and kept in sync with the contract - the same
// pattern T3/T4 use for their views.
//
// PRIVACY: ScheduleAuthorizeView / ScheduleAuthorizeItem are the ONLY shapes sent to a
// patient. Neither carries COGS, fee, margin, or provider economics (NFR-5, RT-10).

export type ScheduleStatus = 'active' | 'paused' | 'cancelled'

export type HoldReason = 'INSUFFICIENT_STOCK' | 'MARGIN_NEGATIVE' | 'NOT_AUTHORIZED' | 'PAYMENT_DECLINED'

export interface ScheduleLineView {
  id: string
  position: number
  sku: string
  name: string
  qty: number
  unitPriceCents: number
  unitMarkupCents: number
}

export interface ScheduleCycleView {
  orderId: string
  cycleNumber: number
  status: 'paid' | 'on_hold' | 'cancelled'
  holdReason: HoldReason | null
  subtotalCents: number | null
  createdAt: string
}

export interface ScheduleView {
  id: string
  patientId: string
  status: ScheduleStatus
  intervalDays: number
  nextRunAt: string | null
  authorized: boolean
  authorizedAt: string | null
  payUrl: string
  perCycleSubtotalCents: number
  lines: ScheduleLineView[]
  cycles: ScheduleCycleView[]
  createdAt: string
}

export interface RunCycleResult {
  scheduleId: string
  cycle: ScheduleCycleView | null
  created: boolean
  note: string
}

// ---- Patient surface (strict whitelist) ----

export interface ScheduleAuthorizeItem {
  name: string
  qty: number
  unitPriceCents: number
}

export interface ScheduleAuthorizeView {
  patientFirstName: string
  intervalDays: number
  items: ScheduleAuthorizeItem[]
  perCycleTotalCents: number
  authorized: boolean
}

export interface ScheduleAuthorizeResult {
  authorized: boolean
}
