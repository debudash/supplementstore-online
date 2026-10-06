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
// StubNotifier is exported (like SystemClock) so tests can inject an observable
// instance via createSeams({ notifier }) and assert on its recorded calls.
export { StubNotifier } from './notifier'
export type { SentPayLink, SentRefundNotice } from './notifier'

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
