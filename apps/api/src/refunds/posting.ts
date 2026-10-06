// REFUND journal posting (T5) - GATE G4 reviews this function.
//
// Posts the per-line REFUND journal for an order (FR-8 AC3, docs/ARCHITECTURE.md
// section 5, ADR-007, ADR-012). Like the T4 PAYMENT posting, this module does NO split
// math: fees, allocations and margins were computed once by @cerbo/money at send time
// and persisted on order_lines. Here we only MAP those snapshotted amounts to accounts
// with the REFUND sign convention (debit positive, credit negative). Every cent is tied
// to a SKU via line_id. It reuses T4's ACCOUNTS constants - no account strings duplicated.
//
// A refund is a NEW journal (type REFUND). It NEVER updates or deletes the original
// PAYMENT journal or its entries (money rule 6, ADR-007). The ledger is append-only.
//
// REFUND is the exact mirror of PAYMENT, except the platform fee is NOT reversed: the
// fee the provider paid is RETAINED by Cerbo and the provider is debited for it
// (memo `fee_retention`, ADR-012). PLATFORM_FEE_REVENUE is intentionally untouched.
//
//   CASH_CLEARING    -line total   (credit: cash goes back to the patient)
//   COGS_RECOVERY    +line cogs     (debit:  Cerbo's cost recovery is unwound)
//   PROVIDER_PAYABLE +line margin   (debit:  provider gives back the margin; memo margin_reversal)
//   PROVIDER_PAYABLE +line fee      (debit:  provider also eats the retained fee; memo fee_retention)
//
// Each line's four entries sum to -total + cogs + margin + fee = 0 (because the split
// guarantees total = cogs + fee + margin), so the whole journal sums to zero (money
// rule 7). The deferred balance trigger T2 installed verifies this at COMMIT; an
// unbalanced posting aborts the whole refund transaction.
//
// The function runs inside the caller's transaction (money rule 8): it never opens or
// commits its own.
import type { Knex } from 'knex'
import { assertSafeInteger } from '../db/types'
import { ACCOUNTS } from '../ledger'

/** An order line's persisted split snapshot - the inputs the posting maps to accounts. */
export interface RefundPostingLine {
  id: string
  lineTotalCents: number
  lineCogsCents: number
  lineFeeCents: number
  lineMarginCents: number
}

/** The order context a journal needs: who to attribute and whether it is synthetic. */
export interface RefundPostingOrder {
  id: string
  providerId: string
  practiceId: string
  isSynthetic: boolean
}

export interface PostRefundJournalInput {
  order: RefundPostingOrder
  lines: RefundPostingLine[]
  /** The refunds row this journal records (journals.ref_id). */
  refundId: string
}

/** Memo on the PROVIDER_PAYABLE debit that reverses the provider's margin (ADR-012). */
export const MEMO_MARGIN_REVERSAL = 'margin_reversal'
/** Memo on the PROVIDER_PAYABLE debit that charges the retained platform fee (ADR-012). */
export const MEMO_FEE_RETENTION = 'fee_retention'

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
 * Post the REFUND journal for an order, one balanced set of entries per line.
 * Returns the new journal id. Must be called inside a transaction.
 */
export async function postRefundJournal(
  trx: Knex.Transaction,
  input: PostRefundJournalInput
): Promise<string> {
  const { order, lines, refundId } = input
  if (lines.length === 0) {
    throw new Error('postRefundJournal: an order must have at least one line to post')
  }

  const [{ id: journalId }] = await trx('journals')
    .insert({
      order_id: order.id,
      type: 'REFUND',
      ref_id: refundId,
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
        `postRefundJournal: line ${line.id} does not balance: total ${total} != cogs ${cogs} + fee ${fee} + margin ${margin}`
      )
    }
    const base = {
      journal_id: journalId,
      order_id: order.id,
      line_id: line.id,
      provider_id: order.providerId,
      practice_id: order.practiceId,
      is_synthetic: order.isSynthetic
    }
    entries.push(
      { ...base, account: ACCOUNTS.CASH_CLEARING, amount_cents: -total, memo: null },
      { ...base, account: ACCOUNTS.COGS_RECOVERY, amount_cents: cogs, memo: null },
      { ...base, account: ACCOUNTS.PROVIDER_PAYABLE, amount_cents: margin, memo: MEMO_MARGIN_REVERSAL },
      { ...base, account: ACCOUNTS.PROVIDER_PAYABLE, amount_cents: fee, memo: MEMO_FEE_RETENTION }
    )
  }

  await trx('ledger_entries').insert(entries)
  return journalId
}
