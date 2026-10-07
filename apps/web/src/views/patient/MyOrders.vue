<script setup lang="ts">
// Patient "My Orders" view (owner request: patients had no navigation, and a sent
// order was unreachable once the pay link was lost). Lists the patient's own orders
// from GET /api/patient/orders, each linking to its pay page.
//
// PRIVACY: this is a patient surface. Every field here comes from the server's patient
// whitelist serializer (PatientOrderListItem) - item name/qty/unit price/line total,
// the order subtotal, status and the pay path. COGS, fee, margin and provider economics
// never appear. Money is integer cents from the server, formatted at display only.
//
// Eligibility to pay is taken from the server's `isPayable`, and the link from
// `payPath` - neither is re-derived in the client.
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { apiRequest, ApiError } from '../../api/client'
import { currentUser } from '../../api/session'
import type { PatientOrdersResponse, PatientOrderListItem, PatientRefundReason } from '@cerbo/contracts'
import ConfirmDialog from '../../components/ui/ConfirmDialog.vue'
import { toast } from '../../components/ui/toast'
import DemoBadge from '../../components/DemoBadge.vue'
import PageHeader from '../../components/ui/PageHeader.vue'
import Card from '../../components/ui/Card.vue'
import Money from '../../components/ui/Money.vue'
import StatusChip from '../../components/ui/StatusChip.vue'
import UiAlert from '../../components/ui/UiAlert.vue'
import UiButton from '../../components/ui/UiButton.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'

type Phase = 'loading' | 'ready' | 'empty' | 'error'

const phase = ref<Phase>('loading')
const orders = ref<PatientOrderListItem[]>([])
const patientName = currentUser()?.displayName ?? ''

function when(value: string | null): string {
  return value ? new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '-'
}

async function load(): Promise<void> {
  phase.value = 'loading'
  try {
    const res = await apiRequest<PatientOrdersResponse>('/patient/orders')
    orders.value = res.orders
    phase.value = res.orders.length === 0 ? 'empty' : 'ready'
  } catch {
    phase.value = 'error'
  }
}

// ---- Refund request (no return; ADR-023) ----
const REASONS: Array<{ code: PatientRefundReason; label: string }> = [
  { code: 'damaged', label: 'Damaged or defective' },
  { code: 'wrong_item', label: 'Wrong item' },
  { code: 'patient_request', label: 'I no longer need it' },
  { code: 'other', label: 'Other' }
]
const requesting = ref<PatientOrderListItem | null>(null)
const reason = ref<PatientRefundReason | ''>('')
const note = ref('')
const reasonError = ref<string | null>(null)
const sendError = ref<string | null>(null)
const sending = ref(false)

function openRequest(o: PatientOrderListItem): void {
  requesting.value = o
  reason.value = ''
  note.value = ''
  reasonError.value = null
  sendError.value = null
}

async function sendRequest(): Promise<void> {
  const o = requesting.value
  if (!o) return
  if (!reason.value) {
    reasonError.value = 'Choose a reason.'
    return
  }
  sending.value = true
  sendError.value = null
  try {
    await apiRequest(`/patient/orders/${encodeURIComponent(o.orderId)}/refund-request`, {
      method: 'POST',
      body: { reasonCode: reason.value, note: note.value.trim() || undefined }
    })
    requesting.value = null
    toast('Refund requested. Your provider will review it.', 'success')
    await load()
  } catch (err) {
    sendError.value = err instanceof ApiError ? err.message : 'We could not send your request. Please try again.'
  } finally {
    sending.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="my-orders">
    <PageHeader title="My orders" :subtitle="patientName ? `Signed in as ${patientName}` : undefined">
      <template #actions>
        <DemoBadge reason="Demo affordance - in production a patient reaches their order from an emailed or texted pay link, not by browsing a list." />
      </template>
    </PageHeader>

    <Card v-if="phase === 'loading'">
      <Skeleton :lines="4" label="Loading your orders" />
    </Card>

    <UiAlert v-else-if="phase === 'error'" tone="danger" title="We could not load your orders" data-testid="orders-error">
      Please try again in a moment.
      <template #actions>
        <UiButton size="sm" data-testid="retry" @click="load">Retry</UiButton>
      </template>
    </UiAlert>

    <EmptyState
      v-else-if="phase === 'empty'"
      title="No orders yet"
      message="When your provider sends you an order, it will appear here."
    />

    <ul v-else class="order-list" aria-label="Your orders">
      <li v-for="o in orders" :key="o.orderId">
        <Card class="order-card" :data-order-id="o.orderId">
          <template #header>
            <div class="order-head">
              <StatusChip :status="o.status" />
              <h2 class="order-title">Order sent {{ when(o.sentAt) }}</h2>
            </div>
          </template>
          <template v-if="o.isPayable && o.payPath" #actions>
            <RouterLink class="btn btn-primary" :to="o.payPath" data-testid="pay-order">Review and pay</RouterLink>
          </template>

          <dl class="order-facts">
            <div>
              <dt>Total</dt>
              <dd><Money class="order-total" :cents="o.amountCents" /></dd>
            </div>
            <div>
              <dt>Sent</dt>
              <dd>{{ when(o.sentAt) }}</dd>
            </div>
            <div v-if="o.paidAt">
              <dt>Paid</dt>
              <dd>{{ when(o.paidAt) }}</dd>
            </div>
          </dl>

          <ul class="item-list" aria-label="Items in this order">
            <li v-for="(item, i) in o.items" :key="i" class="item">
              <span class="item-main">
                <span class="item-name">{{ item.name }}</span>
                <span class="item-meta">Qty {{ item.qty }} · <Money :cents="item.unitPriceCents" /> each</span>
              </span>
              <Money :cents="item.lineTotalCents" class="item-total" />
            </li>
          </ul>

          <div class="refund-area" :data-testid="`refund-area-${o.orderId}`">
            <UiAlert v-if="o.refundRequest?.status === 'pending'" tone="info" title="Refund requested">
              Sent {{ when(o.refundRequest.createdAt) }}. Your provider will review it.
            </UiAlert>
            <UiAlert v-else-if="o.refundRequest?.status === 'declined'" tone="warning" title="Refund request declined">
              {{ o.refundRequest.decisionNote || 'Your provider declined this request.' }}
            </UiAlert>
            <UiAlert v-else-if="o.refundRequest?.status === 'approved' || o.status === 'refunded'" tone="success" title="Refunded">
              <Money :cents="o.amountCents" /> is on its way back to you. There is no need to send anything back.
            </UiAlert>
            <UiButton
              v-if="o.canRequestRefund"
              size="sm"
              variant="danger-quiet"
              :data-testid="`request-refund-${o.orderId}`"
              @click="openRequest(o)"
            >{{ o.refundRequest?.status === 'declined' ? 'Request again' : 'Request a refund' }}</UiButton>
          </div>
        </Card>
      </li>
    </ul>

    <ConfirmDialog
      :open="requesting !== null"
      title="Request a refund"
      confirm-label="Send request"
      :busy="sending"
      @confirm="sendRequest"
      @cancel="requesting = null"
    >
      <p>
        Tell your provider what went wrong. <strong>You do not need to send anything back</strong> -
        please keep or safely dispose of the product.
      </p>
      <div class="req-field">
        <label for="refund-reason">Reason</label>
        <select id="refund-reason" v-model="reason" :aria-invalid="reasonError ? 'true' : undefined" data-testid="refund-reason">
          <option value="" disabled>Choose a reason</option>
          <option v-for="r in REASONS" :key="r.code" :value="r.code">{{ r.label }}</option>
        </select>
        <span v-if="reasonError" class="req-error">{{ reasonError }}</span>
      </div>
      <div class="req-field">
        <label for="refund-note">Details <span class="subtle">(optional)</span></label>
        <textarea id="refund-note" v-model="note" rows="3" maxlength="500" data-testid="refund-note" />
      </div>
      <UiAlert v-if="sendError" tone="danger">{{ sendError }}</UiAlert>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.my-orders {
  max-width: 48rem;
  margin: 0 auto;
}
.order-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.order-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}
.order-title {
  font-size: var(--text-lg);
  margin: 0;
}
.order-facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-8);
  margin: 0 0 var(--space-4);
}
.order-facts dt {
  color: var(--muted);
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.order-facts dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.order-total {
  font-size: var(--text-xl);
  font-weight: 700;
}
.item-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--border);
}
.item {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
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
}
.item-meta {
  color: var(--muted);
  font-size: var(--text-sm);
}
.item-total {
  font-weight: 650;
}
.refund-area {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
  margin-top: var(--space-4);
}
.refund-area:empty {
  display: none;
}
.refund-area > :deep(.alert) {
  align-self: stretch;
}
.req-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-4);
}
.req-field label {
  font-size: var(--text-sm);
  font-weight: 600;
}
.req-field textarea {
  width: 100%;
  resize: vertical;
}
.req-error {
  color: var(--danger);
  font-size: var(--text-sm);
  font-weight: 550;
}
</style>
