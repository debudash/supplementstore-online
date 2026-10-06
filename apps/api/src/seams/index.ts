// Seam container. Business modules receive `Seams` and never import a stub
// directly (AGENTS.md section 6). Tests and the demo generator pass overrides
// (e.g. a fixed Clock, a gateway that declines).
import { SystemClock } from './clock'
import { StubFulfillmentService } from './fulfillment'
import { StubNotifier } from './notifier'
import { StubPaymentGateway } from './paymentGateway'
import { StubPayoutService } from './payout'
import type { Seams } from './types'

export * from './types'
export { DECLINE_AMOUNT_CENTS } from './paymentGateway'
export { SystemClock } from './clock'

/** Build the default seam container (all stubs), with optional overrides. */
export function createSeams(overrides: Partial<Seams> = {}): Seams {
  return {
    paymentGateway: overrides.paymentGateway ?? new StubPaymentGateway(),
    fulfillment: overrides.fulfillment ?? new StubFulfillmentService(),
    notifier: overrides.notifier ?? new StubNotifier(),
    payout: overrides.payout ?? new StubPayoutService(),
    clock: overrides.clock ?? new SystemClock()
  }
}
