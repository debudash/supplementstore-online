// @cerbo/contracts - Cerbo Admin inventory request/response types (T11).
//
// FR-15 and the inventory half of FR-9: the demo-only restock console under Cerbo
// Admin. Cerbo owns ONE shared inventory pool (ADR-009); restock lives here, labelled
// "Demo only", and a provider must never restock (RT-09 - enforced by the cerbo_admin
// role guard on /api/admin/*). These shapes back GET /api/admin/inventory and
// POST /api/admin/inventory/:sku/restock in docs/ARCHITECTURE.md section 8.
//
// All money fields are integer cents and are DISPLAY-only in the UI (AGENTS.md money
// rule 2): the web console only renders them, it never computes with them.

/** One catalog row as Cerbo Admin sees it, with the full on-hand / reserved breakdown. */
export interface AdminInventoryItem {
  sku: string
  name: string
  unitCogsCents: number
  /** Catalog list price (ADR-025: editable by Cerbo Admin only). */
  listPriceCents: number
  /** Gross margin at the list price, basis points, rounded down. */
  listMarginBps: number
  /** Active recurring schedules containing this SKU; they reprice on their next cycle. */
  activeScheduleCount: number
  onHandQty: number
  reservedQty: number
  /** available = on_hand - reserved for the shared pool (docs/ARCHITECTURE.md section 6). */
  available: number
  active: boolean
}

/** GET /api/admin/inventory response: the whole shared pool, ordered by sku. */
export interface AdminInventoryResponse {
  items: AdminInventoryItem[]
}

/** POST /api/admin/inventory/:sku/restock request body (demo only, FR-15). */
export interface RestockRequest {
  /** Units to add to on_hand. Positive safe integer, 1..10000. */
  qty: number
}

/**
 * Restock result (FR-15). Echoes the SKU's new pool counts after adding `qtyAdded`
 * units to on_hand and recording one `restock` inventory movement attributed to the
 * acting Cerbo Admin. Reserved is unchanged (docs/ARCHITECTURE.md section 6).
 */
export interface RestockResult {
  sku: string
  qtyAdded: number
  onHandQty: number
  reservedQty: number
  available: number
  /** The inventory_movements row id written for this restock. */
  movementId: number
}

/** PATCH /api/admin/products/:sku/list-price request (ADR-025). */
export interface UpdateListPriceRequest {
  /** New list price, integer cents, above the unit cost, at most 10,000,000. */
  listPriceCents: number
  /** The price the admin saw; a mismatch returns 409 PRICE_CONFLICT (no lost update). */
  expectedCurrentPriceCents: number
  /** Why the price changed (3 to 500 characters); stored in the price history. */
  reason: string
}

/** One append-only price history row. */
export interface PriceChange {
  id: number
  sku: string
  oldPriceCents: number
  newPriceCents: number
  reason: string
  actorUserId: string
  actorName: string | null
  changedAt: string
}

/** PATCH /api/admin/products/:sku/list-price response. */
export interface UpdateListPriceResult {
  sku: string
  name: string
  unitCogsCents: number
  previousPriceCents: number
  listPriceCents: number
  previousMarginBps: number
  listMarginBps: number
  activeScheduleCount: number
  change: PriceChange
}

/** GET /api/admin/products/:sku/list-price-preview?listPriceCents= (read-only review). */
export interface ListPricePreview {
  sku: string
  name: string
  unitCogsCents: number
  currentPriceCents: number
  listPriceCents: number
  currentMarginBps: number
  listMarginBps: number
  /** True when the proposed price is at or below cost; saving would be refused. */
  belowCost: boolean
  /** listPriceCents minus currentPriceCents, server-computed. */
  differenceCents: number
  activeScheduleCount: number
}

/** GET /api/admin/products/:sku/price-history response (newest first, last 50). */
export interface PriceHistoryResponse {
  sku: string
  changes: PriceChange[]
}
