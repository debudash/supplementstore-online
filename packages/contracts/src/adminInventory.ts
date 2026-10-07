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
