// Ledger posting (T4) - GATE G3 reviews this function.
//
// Posts the per-line PAYMENT journal for an order (FR-6 AC4, ARCHITECTURE section 5,
// ADR-007). This module does NO split math: fees, allocations and margins are computed
// once by @cerbo/money at send time and persisted on order_lines. Here we only MAP
// those already-computed, snapshotted amounts to accounts with the right sign
// (debit positive, credit negative). Every cent is tied to a SKU via line_id.
//
// The function runs inside the caller's transaction (money rule 8): it never opens or
// commits its own. The deferred balance trigger T2 installed verifies each journal sums
// to zero at COMMIT, so an unbalanced posting aborts the whole pay transaction.
//
// T9 (recurring) reuses THIS function for its cycle PAYMENT journals - there is no
// duplicate posting code anywhere else.
import type { Knex } from 'knex'
import { assertSafeInteger } from '../db/types'
import { ACCOUNTS } from './accounts'

/** An order line's persisted split snapshot - the inputs the posting maps to accounts. */
export interface PostingLine {
  id: string
  lineTotalCents: number
  lineCogsCents: number
  lineFeeCents: number
  lineMarginCents: number
}

/** The order context a journal needs: who to attribute and whether it is synthetic. */
export interface PostingOrder {
  id: string
  providerId: string
  practiceId: string
  isSynthetic: boolean
}

export interface PostPaymentJournalInput {
  order: PostingOrder
  lines: PostingLine[]
  /** The payments row this journal records (journals.ref_id). */
  paymentId: string
}

interface LedgerEntryInsert {
  journal_id: string
  order_id: string
  line_id: string
  account: string
  provider_id: string
  practice_id: string
  amount_cents: number
  memo: string | null
  is_synthetic: boolean
}

/**
 * Post the PAYMENT journal for an order, one balanced set of entries per line:
 *   CASH_CLEARING        +line total   (debit:  patient cash in)
 *   COGS_RECOVERY        -line cogs     (credit: Cerbo recovers its cost)
 *   PROVIDER_PAYABLE     -line margin   (credit: owed to the provider)
 *   PLATFORM_FEE_REVENUE -line fee      (credit: Cerbo's platform fee)
 *
 * Each line's four entries sum to total - cogs - margin - fee = 0 (because the split
 * guarantees total = cogs + fee + margin), so the whole journal sums to zero.
 *
 * Returns the new journal id. Must be called inside a transaction.
 */
export async function postPaymentJournal(
  trx: Knex.Transaction,
  input: PostPaymentJournalInput
): Promise<string> {
  const { order, lines, paymentId } = input
  if (lines.length === 0) {
    throw new Error('postPaymentJournal: an order must have at least one line to post')
  }

  const [{ id: journalId }] = await trx('journals')
    .insert({
      order_id: order.id,
      type: 'PAYMENT',
      ref_id: paymentId,
      is_synthetic: order.isSynthetic
    })
    .returning<{ id: string }[]>('id')

  const entries: LedgerEntryInsert[] = []
  for (const line of lines) {
    const { lineTotalCents: total, lineCogsCents: cogs, lineFeeCents: fee, lineMarginCents: margin } = line
    // Snapshot amounts are integer cents; guard against any bigint/precision surprise.
    assertSafeInteger(total)
    assertSafeInteger(cogs)
    assertSafeInteger(fee)
    assertSafeInteger(margin)
    // Defensive invariant (money rule 5): the persisted split must balance per line.
    // The DB check constraint already enforces this; failing here means corrupt input,
    // not a user error, so we abort rather than post a journal that cannot balance.
    if (total !== cogs + fee + margin) {
      throw new Error(
        `postPaymentJournal: line ${line.id} does not balance: total ${total} != cogs ${cogs} + fee ${fee} + margin ${margin}`
      )
    }
    const base = {
      journal_id: journalId,
      order_id: order.id,
      line_id: line.id,
      provider_id: order.providerId,
      practice_id: order.practiceId,
      memo: null,
      is_synthetic: order.isSynthetic
    }
    entries.push(
      { ...base, account: ACCOUNTS.CASH_CLEARING, amount_cents: total },
      { ...base, account: ACCOUNTS.COGS_RECOVERY, amount_cents: -cogs },
      { ...base, account: ACCOUNTS.PROVIDER_PAYABLE, amount_cents: -margin },
      { ...base, account: ACCOUNTS.PLATFORM_FEE_REVENUE, amount_cents: -fee }
    )
  }

  await trx('ledger_entries').insert(entries)
  return journalId
}
