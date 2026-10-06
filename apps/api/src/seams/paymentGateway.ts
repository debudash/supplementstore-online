import { randomUUID } from 'node:crypto'
import type { ChargeResult, PaymentGateway, RefundResult } from './types'

/** Amount (in cents) that deterministically forces a decline for the demo. */
export const DECLINE_AMOUNT_CENTS = 1313

/**
 * Stub gateway. Returns `stub_ch_<uuid>` refs. A charge for exactly
 * DECLINE_AMOUNT_CENTS is declined so the demo can show the decline path.
 * A real gateway (Stripe PaymentIntent + webhook) replaces this without the
 * business layer changing.
 */
export class StubPaymentGateway implements PaymentGateway {
  async charge(amountCents: number, _idempotencyKey: string, _method?: string): Promise<ChargeResult> {
    const gatewayRef = `stub_ch_${randomUUID()}`
    if (amountCents === DECLINE_AMOUNT_CENTS) {
      return { status: 'declined', gatewayRef }
    }
    return { status: 'succeeded', gatewayRef }
  }

  async refund(_gatewayRef: string, _amountCents: number): Promise<RefundResult> {
    return { gatewayRef: `stub_rf_${randomUUID()}` }
  }
}
