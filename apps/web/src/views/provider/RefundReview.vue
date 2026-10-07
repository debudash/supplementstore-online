<script setup lang="ts">
// Provider refund review page (ADR-027), reached by the request's review link
// (/refund-review/:token), the way a patient reaches a pay page. The API still requires
// the provider who owns the order. Accept runs the standard refund immediately; Decline
// needs a note the patient sees. Nothing is computed here: amounts, the window and
// "shipped" all come from GET /api/refund-review/:token.
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import type { RefundReview } from '@cerbo/contracts'
import { apiRequest, ApiError } from '../../api/client'
import { formatMoney } from '../../utils/money'
import DemoBadge from '../../components/DemoBadge.vue'
import PageHeader from '../../components/ui/PageHeader.vue'
import Card from '../../components/ui/Card.vue'
import Money from '../../components/ui/Money.vue'
import StatusChip from '../../components/ui/StatusChip.vue'
import UiAlert from '../../components/ui/UiAlert.vue'
import UiButton from '../../components/ui/UiButton.vue'
import ConfirmDialog from '../../components/ui/ConfirmDialog.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import { toast } from '../../components/ui/toast'

const REASON_LABEL: Record<string, string> = {
  damaged: 'Damaged or defective',
  wrong_item: 'Wrong item',
  patient_request: 'Patient no longer needs it',
  other: 'Other'
}

const route = useRoute()
const token = computed(() => String(route.params.token))
const review = ref<RefundReview | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)
const dialog = ref<'accept' | 'decline' | null>(null)
const declineNote = ref('')
const fieldError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const busy = ref(false)

const when = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '-'

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    review.value = await apiRequest<RefundReview>(`/refund-review/${encodeURIComponent(token.value)}`)
  } catch (err) {
    loadError.value =
      err instanceof ApiError && err.status === 404
        ? 'This review link is not valid for your account.'
        : 'We could not load this refund request.'
  } finally {
    loading.value = false
  }
}
onMounted(load)

function open(kind: 'accept' | 'decline'): void {
  dialog.value = kind
  declineNote.value = ''
  fieldError.value = null
  actionError.value = null
}

async function confirm(): Promise<void> {
  if (dialog.value === 'decline' && declineNote.value.trim().length < 3) {
    fieldError.value = 'Tell the patient why (at least 3 characters).'
    return
  }
  busy.value = true
  actionError.value = null
  try {
    const path = `/refund-review/${encodeURIComponent(token.value)}/${dialog.value}`
    if (dialog.value === 'accept') {
      await apiRequest(path, { method: 'POST', body: {} })
      toast('Refund accepted. The patient has been refunded.', 'success')
    } else {
      await apiRequest(path, { method: 'POST', body: { note: declineNote.value.trim() } })
      toast('Refund request declined. The patient will see your note.', 'success')
    }
    dialog.value = null
    await load()
  } catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="refund-review">
    <PageHeader title="Refund request" subtitle="Review the patient's request and decide.">
      <template #actions>
        <DemoBadge reason="Demo affordance - in production the provider is emailed this review link. Accepting refunds the patient immediately through the standard refund path." />
      </template>
    </PageHeader>

    <Card v-if="loading"><Skeleton :lines="5" label="Loading the refund request" /></Card>

    <UiAlert v-else-if="loadError" tone="danger" title="Refund request unavailable" data-testid="review-error">
      {{ loadError }}
    </UiAlert>

    <template v-else-if="review">
      <UiAlert v-if="review.request.status === 'approved'" tone="success" title="Refunded" data-testid="review-approved">
        Accepted {{ when(review.request.decidedAt) }}. The patient was refunded {{ formatMoney(review.order.subtotalCents) }}.
      </UiAlert>
      <UiAlert v-else-if="review.request.status === 'declined'" tone="warning" title="Declined" data-testid="review-declined">
        Declined {{ when(review.request.decidedAt) }}: "{{ review.request.decisionNote }}"
      </UiAlert>

      <Card :title="review.order.patientName ?? 'Patient'" data-testid="review-card">
        <template #actions>
          <RouterLink class="subtle" :to="`/orders/${review.order.id}/audit`">Open order audit</RouterLink>
        </template>
        <dl class="facts">
          <div><dt>Order</dt><dd><StatusChip :status="review.order.status" /></dd></div>
          <div><dt>Total</dt><dd><Money :cents="review.order.subtotalCents ?? 0" /></dd></div>
          <div><dt>Paid</dt><dd>{{ when(review.order.paidAt) }}</dd></div>
          <div><dt>Refund window ends</dt><dd data-testid="review-window">{{ when(review.order.refundWindowEndsAt) }}</dd></div>
          <div><dt>Reason</dt><dd>{{ REASON_LABEL[review.request.reasonCode] ?? review.request.reasonCode }}</dd></div>
          <div>
            <dt>Unopened</dt>
            <dd data-testid="review-unopened">{{ review.request.unopenedConfirmed ? 'Confirmed by the patient' : 'Not confirmed' }}</dd>
          </div>
        </dl>
        <p v-if="review.request.note" class="note"><span class="subtle">Patient's note:</span> {{ review.request.note }}</p>

        <ul class="items" aria-label="Items in this order">
          <li v-for="item in review.order.items" :key="item.sku">
            <span>{{ item.name }} <span class="subtle">x{{ item.qty }}</span></span>
            <Money :cents="item.lineTotalCents ?? 0" />
          </li>
        </ul>

        <div v-if="review.request.status === 'pending'" class="actions">
          <UiButton variant="danger" :disabled="busy" data-testid="review-accept" @click="open('accept')">Accept and refund now</UiButton>
          <UiButton :disabled="busy" data-testid="review-decline" @click="open('decline')">Decline</UiButton>
        </div>
      </Card>

      <ConfirmDialog
        :open="dialog !== null"
        :title="dialog === 'decline' ? 'Decline this refund request?' : `Refund ${formatMoney(review.order.subtotalCents)} now?`"
        :confirm-label="dialog === 'decline' ? 'Decline request' : 'Accept and refund'"
        :tone="dialog === 'decline' ? 'primary' : 'danger'"
        :busy="busy"
        @confirm="confirm"
        @cancel="dialog = null"
      >
        <template v-if="dialog === 'decline'">
          <p>The patient will see your note on their order.</p>
          <label for="review-decline-note" class="lbl">Note to the patient</label>
          <textarea id="review-decline-note" v-model="declineNote" rows="3" maxlength="500" data-testid="review-decline-note" />
        </template>
        <ul v-else class="effects">
          <li>The patient is refunded {{ formatMoney(review.order.subtotalCents) }} in full, immediately.</li>
          <li>Your margin on this order is reversed and the 0.75% platform fee is kept (ADR-012).</li>
          <li v-if="review.order.shipped">The order has shipped, so Cerbo writes off the returned stock (ADR-013).</li>
          <li v-else>Not yet shipped, so the stock goes back to inventory.</li>
          <li>Return shipping is outside this demo. This cannot be undone.</li>
        </ul>
        <p v-if="fieldError" class="field-error">{{ fieldError }}</p>
        <UiAlert v-if="actionError" tone="danger">{{ actionError }}</UiAlert>
      </ConfirmDialog>
    </template>
  </section>
</template>

<style scoped>
.refund-review {
  max-width: 48rem;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--space-3) var(--space-6);
  margin: 0 0 var(--space-4);
}
.facts dt {
  font-size: var(--text-xs);
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--muted);
}
.facts dd {
  margin: 0;
  font-weight: 600;
}
.note {
  margin: 0 0 var(--space-3);
}
.items {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--border);
}
.items li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
.effects {
  padding-left: var(--space-5);
  margin: 0 0 var(--space-3);
}
.lbl {
  display: block;
  font-size: var(--text-sm);
  font-weight: 600;
  margin: var(--space-3) 0 var(--space-1);
}
textarea {
  width: 100%;
}
.field-error {
  color: var(--danger);
  font-size: var(--text-sm);
  font-weight: 550;
  margin: var(--space-2) 0 0;
}
</style>
