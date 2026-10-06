import type { Notifier, PayLinkRecipient, RefundNotice } from './types'

/** A recorded sendPayLink call (observable for tests). */
export interface SentPayLink {
  recipient: PayLinkRecipient
  url: string
}

/** A recorded sendRefundNotice call (observable for tests). */
export interface SentRefundNotice {
  recipient: PayLinkRecipient
  notice: RefundNotice
}

/**
 * Stub notifier: logs instead of sending email/SMS, and records every call on public
 * arrays so tests can assert a notice was sent. No real email, no network, no deps
 * (AGENTS.md section 10). T5's refund tests inject a StubNotifier via createSeams and
 * read `refundNotices` to assert the patient was notified.
 */
export class StubNotifier implements Notifier {
  readonly payLinks: SentPayLink[] = []
  readonly refundNotices: SentRefundNotice[] = []

  async sendPayLink(recipient: PayLinkRecipient, url: string): Promise<void> {
    this.payLinks.push({ recipient, url })
    console.log(`[notifier:stub] pay link for ${recipient.id}: ${url}`)
  }

  async sendRefundNotice(recipient: PayLinkRecipient, notice: RefundNotice): Promise<void> {
    this.refundNotices.push({ recipient, notice })
    const instruction = notice.keepOrDispose
      ? 'keep or safely dispose, do not return'
      : 'nothing to return'
    console.log(
      `[notifier:stub] refund notice for ${recipient.id}: refunded ${notice.refundedAmountCents} cents (${instruction})`
    )
  }
}
