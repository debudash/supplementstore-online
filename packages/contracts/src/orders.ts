// @cerbo/contracts - order lifecycle request/response types (T3).
//
// Shared shapes for FR-1..FR-4: draft assembly, per-line pricing, stock check,
// quote preview, send (snapshot + reservation), cancel. These mirror the provider
// order routes in docs/ARCHITECTURE.md section 8 (refund and audit belong to T4/T5
// and are intentionally absent here). All money fields are integer cents.
//
// This file is the canonical contract for the order endpoints. The API shapes its
// responses to match these types; the web client (T6) consumes them.

/** Order lifecycle status (docs/ARCHITECTURE.md section 3 / section 6). */
export type OrderStatus =
  | 'draft'
  | 'sent'
  | 'paid'
  | 'cancelled'
  | 'expired'
  | 'refunded'
  | 'on_hold'

/** POST /api/orders - open a draft for one of the provider's patients (FR-1). */
export interface CreateOrderRequest {
  patientId: string
}

/**
 * POST /api/orders/:id/lines - add a SKU (FR-1, FR-2, FR-3).
 * Exactly one of `unitPriceCents` or `marginBps` sets the price; `unitPriceCents`
 * is canonical and wins if both are present (ADR-005).
 */
export interface AddLineRequest {
  sku: string
  qty: number
  unitPriceCents?: number
  marginBps?: number
}

/** PATCH /api/orders/:id/lines/:lineId - edit qty and/or price while draft (FR-1 AC4). */
export interface UpdateLineRequest {
  qty?: number
  unitPriceCents?: number
  marginBps?: number
}

/** A product as the provider sees it in the catalog (GET /api/products). */
export interface ProductView {
  sku: string
  name: string
  unitCogsCents: number
  /** Seeded catalog list price in integer cents; the price the New Order screen shows
   *  and the provider does not type (owner decision). Always set for catalog rows. */
  listPriceCents: number
  /** Gross margin the list price represents over COGS, in basis points, rounded down
   *  (ADR-025). Display context only; before the platform fee. */
  listMarginBps: number
  /** on_hand - reserved for the single shared pool (ADR-009). */
  available: number
  active: boolean
}

/** GET /api/products/:sku/price-preview?marginBps= (ADR-025). All server-computed. */
export interface PricePreview {
  sku: string
  /** The margin asked for, or null when previewing the list price. */
  marginBps: number | null
  /** The unit price an order line would get at this margin. */
  unitPriceCents: number
  listPriceCents: number
  listMarginBps: number
  /** unitPriceCents minus listPriceCents; negative means cheaper than list. */
  differenceFromListCents: number
  /** Quantity simulated (default 1) and that line's split, from the server. */
  qty: number
  lineTotalCents: number
  lineCogsCents: number
  /** Null when the margin cannot cover the platform fee (coversFee false). */
  lineFeeCents: number | null
  lineMarginCents: number | null
  coversFee: boolean
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
  /** Computed split for the line (null fields until the order is sent). */
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
  totals: OrderTotals
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
  /** Totals are null until the order is sent (snapshot time). */
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
  /** Relative patient pay URL built from the unguessable token (FR-4 AC4). */
  payUrl: string
}

/** A row in GET /api/orders (list) - a compact order summary. */
export interface OrderSummary {
  id: string
  status: OrderStatus
  patientId: string
  subtotalCents: number | null
  createdAt: string
  sentAt: string | null
  /** The patient pay token for this order so the provider can recover the link after
   * send (null for drafts). Safe on this provider-owned, ownership-scoped list. */
  payToken: string | null
  /** Ready-made pay path, e.g. "/pay/<token>", or null when there is no token. */
  payPath: string | null
}
