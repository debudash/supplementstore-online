import { randomUUID } from 'node:crypto'
import type { PayoutService } from './types'

/** Stub payout. Not called in this slice (FR-11 AC4); present behind the seam. */
export class StubPayoutService implements PayoutService {
  async payout(statement: {
    id: string
    providerId: string
    amountCents: number
  }): Promise<{ payoutRef: string }> {
    console.log(`[payout:stub] would pay ${statement.amountCents} for statement ${statement.id}`)
    return { payoutRef: `stub_po_${randomUUID()}` }
  }
}
