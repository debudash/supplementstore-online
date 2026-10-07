<script setup lang="ts">
// Patient pay page (T7, FR-5). Reached by an unguessable pay token in the URL - NO
// X-Demo-User header and no role switcher (AGENTS.md section 7). The API client's
// `{ auth: false }` option keeps the identity header off these requests.
//
// WHITELIST (NFR-5, RT-10, EVAL-12): the page renders ONLY the fields the server's
// patient serializer returns - item name/qty/unitPrice/lineTotal, order total, status,
// first name. There is no fee line (ADR-002: the provider bears the fee). COGS, margin,
// and fee never appear here, in the happy path or any error state.
//
// Money is DISPLAY ONLY: integer cents from the server, formatted at the last moment by
// <Money> / formatCents. Nothing here computes an amount.
//
// LAYOUT: mobile-first single centered column. One card whose tone follows the phase,
// one h1 (focused on every phase change so screen readers hear the new state), one
// large total and one full-width pay button.
import { onMounted, ref, computed, watch, watchEffect, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { apiRequest, ApiError } from '../../api/client'
import type { PatientPayView, PayResult, PayRequest, PatientPracticeView } from '@cerbo/contracts'
import { formatCents } from './format'
import {
  phaseForStatus,
  phaseForPayError,
  titleForPhase,
  messageForPhase,
  DECLINE_NOTICE,
  type PayPhase
} from './payState'
import Card from '../../components/ui/Card.vue'
import Money from '../../components/ui/Money.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import UiAlert from '../../components/ui/UiAlert.vue'
import UiButton from '../../components/ui/UiButton.vue'

const route = useRoute()
const token = String(route.params.token)

const phase = ref<PayPhase>('loading')
const view = ref<PatientPayView | null>(null)
const receipt = ref<PayResult | null>(null)
const paidOn = ref('')
// Who the patient is paying (separate token endpoint; the pay view's whitelist is unchanged).
const practice = ref<PatientPracticeView | null>(null)
const payeeLine = computed(() => {
  const p = practice.value
  if (!p || (!p.providerName && !p.practiceName)) return ''
  return [p.providerName, p.practiceName].filter(Boolean).join(' · ')
})
const submitting = ref(false)
const declined = ref(false)
const heading = ref<HTMLHeadingElement | null>(null)

// IDEMPOTENCY KEY: generated ONCE per page load and reused for every retry of this
// payment (AGENTS / FR-5 AC2). A fresh key per click is exactly what would let a
// double-click double-charge; the server enforces idempotency on this key.
const idempotencyKey = crypto.randomUUID()

const title = computed(() => titleForPhase(phase.value))
const message = computed(() => messageForPhase(phase.value))

/** Card tone per phase: success for paid, warning for expired/refunded, danger for error. */
const tone = computed<'default' | 'success' | 'warning' | 'danger'>(() => {
  switch (phase.value) {
    case 'paid':
    case 'alreadyPaid':
      return 'success'
    case 'expired':
    case 'refunded':
      return 'warning'
    case 'error':
      return 'danger'
    default:
      return 'default'
  }
})

/** Decorative glyph shown above the title on terminal states (hidden from AT). */
const icon = computed(() => {
  switch (tone.value) {
    case 'success':
      return '✓'
    case 'warning':
    case 'danger':
      return '!'
    default:
      return phase.value === 'notFound' ? '?' : 'i'
  }
})
const isTerminal = computed(() => phase.value !== 'loading' && phase.value !== 'payable')

watchEffect(() => {
  if (typeof document !== 'undefined') document.title = `${title.value} - Cerbo`
})

// Move focus to the heading on every phase change so the new state is announced.
watch(phase, async () => {
  await nextTick()
  heading.value?.focus()
})

/** Best-effort: the page works without it, so a failure is silent. */
async function loadPractice(): Promise<void> {
  try {
    const p = await apiRequest<PatientPracticeView>(`/pay/${token}/practice`, { auth: false })
    practice.value = p && typeof p === 'object' && ('practiceName' in p || 'providerName' in p) ? p : null
  } catch {
    practice.value = null
  }
}

async function load(): Promise<void> {
  phase.value = 'loading'
  try {
    view.value = await apiRequest<PatientPayView>(`/pay/${token}`, { auth: false })
    phase.value = phaseForStatus(view.value.status)
    void loadPractice() // only once the link is known to be valid
  } catch (err) {
    phase.value = err instanceof ApiError && err.code === 'NOT_FOUND' ? 'notFound' : 'error'
  }
}

async function pay(): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  declined.value = false
  try {
    const body: PayRequest = { idempotencyKey }
    receipt.value = await apiRequest<PayResult>(`/pay/${token}`, { method: 'POST', body, auth: false })
    // The server's payment time (exact, and the same on a retried request).
    const paidAt = receipt.value?.paidAt ? new Date(receipt.value.paidAt) : new Date()
    paidOn.value = paidAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    phase.value = 'paid'
  } catch (err) {
    if (err instanceof ApiError && err.code === 'PAYMENT_DECLINED') {
      // Stay payable so the patient can retry with the SAME idempotency key.
      declined.value = true
    } else if (err instanceof ApiError) {
      phase.value = phaseForPayError(err.code)
    } else {
      phase.value = 'error'
    }
  } finally {
    submitting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="pay-page">
    <!-- Polite live region for the in-flight payment (the button itself is aria-busy). -->
    <p class="sr-only" role="status" aria-live="polite" data-testid="pay-live">
      {{ submitting ? 'Processing your payment' : '' }}
    </p>

    <Card :tone="tone" class="pay-card" :data-phase="phase">
      <span v-if="isTerminal" class="state-icon" :class="`state-icon-${tone}`" aria-hidden="true">{{ icon }}</span>

      <p v-if="payeeLine && (phase === 'payable' || phase === 'paid')" class="payee" data-testid="payee">{{ payeeLine }}</p>
      <p v-if="phase === 'payable' && view?.patientFirstName" class="greeting">Hi {{ view.patientFirstName }},</p>
      <h1 ref="heading" tabindex="-1" class="pay-title" :class="{ centered: isTerminal }">{{ title }}</h1>

      <!-- Loading -->
      <Skeleton v-if="phase === 'loading'" :lines="4" height="1.25rem" label="Loading your order" />

      <!-- Payable: the order summary and the pay button. -->
      <template v-else-if="phase === 'payable' && view">
        <p class="lead">Please review your order and complete payment.</p>

        <ul class="items" aria-label="Items in your order" data-testid="pay-items">
          <li v-for="(item, i) in view.items" :key="i" class="item">
            <div class="item-main">
              <span class="item-name">{{ item.name }}</span>
              <span class="item-meta">Qty {{ item.qty }} · <Money :cents="item.unitPriceCents" /> each</span>
            </div>
            <Money class="item-total" :cents="item.lineTotalCents" />
          </li>
        </ul>

        <div class="total-row" data-testid="pay-total">
          <span class="total-label">Total</span>
          <Money class="total-amount" :cents="view.totalCents" />
        </div>

        <UiAlert v-if="declined" tone="danger" class="decline" data-testid="decline-notice">{{ DECLINE_NOTICE }}</UiAlert>

        <UiButton
          variant="primary"
          block
          class="pay-button"
          data-testid="pay-button"
          :busy="submitting"
          busy-label="Processing..."
          @click="pay"
        >
          {{ declined ? `Try again - pay ${formatCents(view.totalCents)}` : `Pay ${formatCents(view.totalCents)}` }}
        </UiButton>
      </template>

      <!-- Paid this session: a receipt-style confirmation. -->
      <template v-else-if="phase === 'paid'">
        <p class="message centered">{{ message }}</p>

        <dl v-if="receipt" class="receipt" data-testid="receipt">
          <div class="receipt-row">
            <dt>Amount paid</dt>
            <dd><Money :cents="receipt.totalCents" strong /></dd>
          </div>
          <div class="receipt-row">
            <dt>Confirmation number</dt>
            <dd class="confirmation" data-testid="confirmation">{{ receipt.paymentId }}</dd>
          </div>
          <div class="receipt-row">
            <dt>Date paid</dt>
            <dd>{{ paidOn }}</dd>
          </div>
        </dl>

        <ul v-if="view" class="items" aria-label="Items paid for">
          <li v-for="(item, i) in view.items" :key="i" class="item">
            <div class="item-main">
              <span class="item-name">{{ item.name }}</span>
              <span class="item-meta">Qty {{ item.qty }} · <Money :cents="item.unitPriceCents" /> each</span>
            </div>
            <Money class="item-total" :cents="item.lineTotalCents" />
          </li>
        </ul>
      </template>

      <!-- Every other terminal state: one clear message, no order economics. -->
      <template v-else>
        <p class="message centered" data-testid="pay-message">{{ message }}</p>
        <div v-if="phase === 'error'" class="retry">
          <UiButton variant="primary" data-testid="retry" @click="load">Retry</UiButton>
        </div>
      </template>
    </Card>
  </div>
</template>

<style scoped>
.pay-page {
  max-width: 30rem;
  margin: 0 auto;
}
.pay-card {
  padding: var(--space-6);
}
.payee {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--brand-strong);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-bottom: var(--space-3);
}
.greeting {
  font-weight: 600;
  margin-bottom: var(--space-1);
}
.pay-title {
  margin-bottom: var(--space-2);
}
/* Focus is moved here programmatically for screen readers; a heading is not
   interactive, so no visible ring. */
.pay-title:focus,
.pay-title:focus-visible {
  outline: none;
  box-shadow: none;
}
.centered {
  text-align: center;
}
.lead {
  color: var(--muted);
}
.state-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 3rem;
  height: 3rem;
  margin: 0 auto var(--space-3);
  border-radius: 50%;
  font-size: var(--text-xl);
  font-weight: 800;
  color: var(--brand-strong);
  background: var(--info-tint);
  border: 2px solid var(--info-border);
}
.state-icon-success {
  color: var(--success);
  background: var(--success-tint);
  border-color: var(--success-border);
}
.state-icon-warning {
  color: var(--warning);
  background: var(--warning-tint);
  border-color: var(--warning-border);
}
.state-icon-danger {
  color: var(--danger);
  background: var(--danger-tint);
  border-color: var(--danger-border);
}
.message {
  color: var(--text);
}
.items {
  list-style: none;
  padding: 0;
  margin: var(--space-4) 0 0;
  border-top: 1px solid var(--border);
}
.item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border);
}
.item-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.item-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.item-meta {
  color: var(--muted);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}
.item-total {
  text-align: right;
  font-weight: 600;
}
.total-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-4) 0;
}
.total-label {
  font-size: var(--text-lg);
  font-weight: 650;
}
.total-amount {
  font-size: var(--text-3xl);
  font-weight: 750;
}
.decline {
  margin-bottom: var(--space-4);
}
.pay-button {
  min-height: 3rem;
  font-size: var(--text-lg);
}
.receipt {
  margin: var(--space-4) 0 0;
  padding: var(--space-4);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.receipt-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-1) 0;
}
.receipt dt {
  color: var(--muted);
}
.receipt dd {
  margin: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.confirmation {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.retry {
  display: flex;
  justify-content: center;
  margin-top: var(--space-2);
}
@media (max-width: 640px) {
  .pay-card {
    padding: var(--space-5) var(--space-4);
  }
}
</style>
