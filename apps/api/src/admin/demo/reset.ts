// Demo reset: the SINGLE guarded purge path (FR-14 AC4, ADR-019, AGENTS.md money rule 6).
//
// THIS IS THE ONLY PLACE IN THE ENTIRE PROJECT THAT DELETES FROM THE APPEND-ONLY LEDGER.
// It must remove ONLY rows where is_synthetic = true, and ONLY through the DB-enforced
// gate: T2's triggers reject every DELETE on journals/ledger_entries/payments/refunds
// unless the row is synthetic AND the transaction-local setting app.allow_synthetic_purge
// = 'on'. payable_statements are NEVER deletable (a separate trigger), even if synthetic.
//
// This code works WITH those triggers, never around them:
//   1. every DELETE below is scoped to is_synthetic = true (or baseline source
//      'synthetic'), so a real row is never even targeted;
//   2. the setting is set LOCAL to this transaction, so it cannot leak to any other
//      request or connection;
//   3. if any targeted row were somehow not synthetic, the trigger raises and the whole
//      transaction rolls back - no partial purge, no real row lost.
//
// The purge runs in ONE transaction so either all synthetic rows go or none do.
import type { Knex } from 'knex'
import type { DemoResetResult } from '@cerbo/contracts'

/** Select synthetic order ids as a subquery (for the unprotected child tables). */
function syntheticOrderIds(trx: Knex.Transaction) {
  return trx('orders').where('is_synthetic', true).select('id')
}

/**
 * Purge all synthetic demo data. Returns the row counts removed per table so a caller
 * can assert synthetic rows are back to zero (EVAL-13). Deletes are ordered to respect
 * foreign keys: ledger entries before journals, child order tables before orders,
 * baseline orders before their import batch.
 */
export async function resetDemoData(db: Knex): Promise<DemoResetResult> {
  return db.transaction(async (trx) => {
    // Open the guarded gate for THIS transaction only. The triggers still require each
    // deleted ledger row to be synthetic; this flag just unlocks the synthetic case.
    await trx.raw("set local app.allow_synthetic_purge = 'on'")

    // 1-4. Append-only ledger tables: synthetic-only, gated by the setting above.
    const ledgerEntries = await trx('ledger_entries').where('is_synthetic', true).del()
    const journals = await trx('journals').where('is_synthetic', true).del()
    const payments = await trx('payments').where('is_synthetic', true).del()
    const refunds = await trx('refunds').where('is_synthetic', true).del()

    // 5-7. Child tables of synthetic orders (not append-only; plain deletes). Scoped by
    // the synthetic-order subquery so nothing attached to a real order is touched.
    const inventoryMovements = await trx('inventory_movements')
      .whereIn('order_id', syntheticOrderIds(trx))
      .del()
    const orderEvents = await trx('order_events').whereIn('order_id', syntheticOrderIds(trx)).del()
    const orderLines = await trx('order_lines').whereIn('order_id', syntheticOrderIds(trx)).del()

    // 8. The synthetic orders themselves.
    const orders = await trx('orders').where('is_synthetic', true).del()

    // 9-10. Synthetic baseline demo data (ADR-018/019): baseline_orders flagged synthetic,
    // then their synthetic import batches.
    const baselineOrders = await trx('baseline_orders').where('is_synthetic', true).del()
    const baselineImports = await trx('baseline_imports').where('source', 'synthetic').del()

    return {
      purged: {
        ledgerEntries,
        journals,
        payments,
        refunds,
        orderEvents,
        orderLines,
        orders,
        baselineOrders,
        baselineImports,
        inventoryMovements
      }
    }
  })
}
