import type { Notifier, PayLinkRecipient } from './types'

/** Stub notifier: logs the pay link. The provider UI shows a copyable link. */
export class StubNotifier implements Notifier {
  async sendPayLink(recipient: PayLinkRecipient, url: string): Promise<void> {
    console.log(`[notifier:stub] pay link for ${recipient.id}: ${url}`)
  }
}
