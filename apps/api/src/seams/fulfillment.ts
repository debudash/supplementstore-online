import { randomUUID } from 'node:crypto'
import type { FulfillmentService } from './types'

/** Stub fulfillment: confirms immediately. The business layer records fulfilled_at. */
export class StubFulfillmentService implements FulfillmentService {
  async markFulfilled(orderId: string): Promise<{ shipmentRef: string }> {
    console.log(`[fulfillment:stub] marked order ${orderId} fulfilled`)
    return { shipmentRef: `stub_ship_${randomUUID()}` }
  }
}
