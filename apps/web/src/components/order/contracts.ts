// Local mirror of the provider order contract shapes (T6).
//
// These mirror packages/contracts/src/orders.ts. Ideally the UI would import them
// straight from `@cerbo/contracts`, but that package's index.ts does not yet
// re-export its per-module files (orders.ts etc.), so the types are not reachable
// through the package entry point. The API service mirrors them locally for the same
// reason. When @cerbo/contracts re-exports its modules, delete this file and import
// from the package instead. All money fields are integer cents.

export type OrderStatus =
  | 'draft'
  | 'sent'
  | 'paid'
  | 'cancelled'
  | 'expired'
  | 'refunded'
  | 'on_hold'

/** A product as the provider sees it in the catalog (GET /api/products). */
export interface ProductView {
  sku: string
  name: string
  unitCogsCents: number
  /** on_hand - reserved for the single shared pool (ADR-009). */
  available: number
  active: boolean
}

/** One line in a quote/order response, with the full provider-facing economics. */
export interface OrderLineView {
  id: string
  position: number
  sku: string
  name: string
  qty: number
  unitPriceCents: number
  unitCogsCents: number
  lineTotalCents: number
  lineCogsCents: number
  lineFeeCents: number
  lineMarginCents: number
}

/** Order-level totals from the money split (provider-facing). */
export interface OrderTotals {
  feeBps: number
  subtotalCents: number
  cogsCents: number
  feeCents: number
  marginCents: number
}

/** The live split preview for a draft (GET /api/orders/:id/quote). */
export interface QuoteResponse {
  orderId: string
  status: OrderStatus
  totals: OrderTotals | null
  lines: OrderLineView[]
}

/** A full order as returned by create/add/update/delete/cancel/get endpoints. */
export interface OrderView {
  id: string
  status: OrderStatus
  providerId: string
  practiceId: string
  patientId: string
  feeBps: number
  totals: OrderTotals | null
  lines: OrderLineView[]
  payToken: string | null
  reservationExpiresAt: string | null
  sentAt: string | null
  createdAt: string
}

/** POST /api/orders/:id/send response: the sent order plus the copyable pay link. */
export interface SendResponse {
  order: OrderView
  payUrl: string
}

/** A row in GET /api/orders (list). */
export interface OrderSummary {
  id: string
  status: OrderStatus
  patientId: string
  subtotalCents: number | null
  createdAt: string
  sentAt: string | null
}

/**
 * A patient as returned by GET /api/patients. Shape confirmed by the orchestrator:
 * { patients: [{ id, name }] }, mirroring GET /api/products. email/ship_to may also
 * be present; they are optional and the UI does not depend on them.
 */
export interface PatientView {
  id: string
  name: string
  email?: string
  shipTo?: string
}
