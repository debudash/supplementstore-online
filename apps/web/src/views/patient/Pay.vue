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
// formatCents. Nothing here computes an amount.
import { onMounted, ref, computed } from 'vue'
import { useRoute } from 'vue-router'
import { apiRequest, ApiError } from '../../api/client'
import type { PatientPayView, PayResult, PayRequest } from '@cerbo/contracts'
import { formatCents } from './format'
import {
  phaseForStatus,
  phaseForPayError,
  titleForPhase,
  messageForPhase,
  DECLINE_NOTICE,
  type PayPhase
} from './payState'

const route = useRoute()
const token = String(route.params.token)

const phase = ref<PayPhase>('loading')
const view = ref<PatientPayView | null>(null)
const receipt = ref<PayResult | null>(null)
const submitting = ref(false)
const declined = ref(false)

// IDEMPOTENCY KEY: generated ONCE per page load and reused for every retry of this
// payment (AGENTS / FR-5 AC2). A fresh key per click is exactly what would let a
// double-click double-charge; the server enforces idempotency on this key.
const idempotencyKey = crypto.randomUUID()

const title = computed(() => titleForPhase(phase.value))
const message = computed(() => messageForPhase(phase.value))

async function load(): Promise<void> {
  phase.value = 'loading'
  try {
    view.value = await apiRequest<PatientPayView>(`/pay/${token}`, { auth: false })
    phase.value = phaseForStatus(view.value.status)
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
  <main class="pay">
    <h1>{{ title }}</h1>

    <p v-if="phase === 'loading'" class="notice">Loading...</p>

    <!-- Payable: the order summary and the pay button. -->
    <template v-else-if="phase === 'payable' && view">
      <p v-if="view.patientFirstName" class="greeting">Hi {{ view.patientFirstName }},</p>
      <p class="lead">Please review your order and complete payment.</p>

      <table class="items">
        <thead>
          <tr>
            <th>Item</th>
            <th class="num">Qty</th>
            <th class="num">Unit price</th>
            <th class="num">Line total</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, i) in view.items" :key="i">
            <td>{{ item.name }}</td>
            <td class="num">{{ item.qty }}</td>
            <td class="num">{{ formatCents(item.unitPriceCents) }}</td>
            <td class="num">{{ formatCents(item.lineTotalCents) }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th colspan="3" class="num">Total</th>
            <td class="num total">{{ formatCents(view.totalCents) }}</td>
          </tr>
        </tfoot>
      </table>

      <p v-if="declined" class="page-error" role="alert">{{ DECLINE_NOTICE }}</p>

      <button type="button" class="pay-button btn-primary" :disabled="submitting" @click="pay">
        {{ submitting ? 'Processing...' : declined ? `Try again - pay ${formatCents(view.totalCents)}` : `Pay ${formatCents(view.totalCents)}` }}
      </button>
    </template>

    <!-- Paid this session: a short receipt. -->
    <template v-else-if="phase === 'paid'">
      <p class="success" role="status">{{ message }}</p>
      <p v-if="receipt" class="amount">Amount paid: {{ formatCents(receipt.totalCents) }}</p>
      <p v-if="receipt" class="ref">Confirmation: {{ receipt.paymentId }}</p>
    </template>

    <!-- Every other terminal state: a single clear message, no order economics. -->
    <p v-else class="notice" role="status">{{ message }}</p>
  </main>
</template>

<style scoped>
.pay {
  max-width: 560px;
  margin: 2.5rem auto;
  padding: 1.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}
.pay h1 {
  font-size: 1.4rem;
}
.greeting {
  font-weight: 600;
}
.lead {
  color: var(--muted);
}
.items {
  border-collapse: collapse;
  width: 100%;
  margin: 1.25rem 0;
}
.items th,
.items td {
  border-bottom: 1px solid var(--border);
  padding: 0.5rem 0.6rem;
  text-align: left;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.items tfoot .total {
  font-weight: 700;
  font-size: 1.05rem;
  border-top: 2px solid var(--border-strong);
}
.pay-button {
  width: 100%;
  font-size: 1.05rem;
  padding: 0.7rem 1.2rem;
  margin-top: 0.5rem;
}
.notice {
  color: var(--muted);
}
.success {
  color: var(--success);
  font-weight: 600;
}
.amount {
  font-weight: 600;
}
.ref {
  color: var(--subtle);
  font-size: 0.9em;
}
</style>
