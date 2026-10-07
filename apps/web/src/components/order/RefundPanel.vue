<script setup lang="ts">
// Provider refund controls on the order audit page.
//  - A pending patient refund request: reason, note, date; Approve (runs the standard
//    refund: patient paid back in full, margin reversed, platform fee kept, ADR-012; stock
//    restocked unless already shipped, ADR-013) or Decline with a note the patient sees.
//  - A paid order without a pending request: a direct "Refund order" with a required reason.
// No money is computed here; the amount shown is the order subtotal from the server.
import { computed, onMounted, ref, watch } from 'vue'
import type { RefundRequestView, RefundReasonCode } from '@cerbo/contracts'
import { apiRequest, ApiError } from '../../api/client'
import { formatMoney } from '../../utils/money'
import Card from '../ui/Card.vue'
import UiAlert from '../ui/UiAlert.vue'
import UiButton from '../ui/UiButton.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import { toast } from '../ui/toast'

const props = defineProps<{ orderId: string; status: string; subtotalCents: number | null; fulfilled: boolean }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const REASON_LABEL: Record<string, string> = {
  damaged: 'Damaged or defective',
  wrong_item: 'Wrong item',
  patient_request: 'Patient no longer needs it',
  provider_error: 'Provider error',
  other: 'Other'
}
const DIRECT_REASONS: RefundReasonCode[] = ['damaged', 'wrong_item', 'patient_request', 'provider_error', 'other']

const request = ref<RefundRequestView | null>(null)
const hasPending = computed(() => request.value?.status === 'pending')
const loadError = ref<string | null>(null)
const busy = ref(false)
const actionError = ref<string | null>(null)
const dialog = ref<'approve' | 'decline' | 'direct' | null>(null)
const declineNote = ref('')
const directReason = ref<RefundReasonCode | ''>('')
const fieldError = ref<string | null>(null)

const when = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-'

async function load(): Promise<void> {
  loadError.value = null
  try {
    const res = await apiRequest<{ request: RefundRequestView | null }>(`/orders/${encodeURIComponent(props.orderId)}/refund-request`)
    request.value = res && 'request' in res ? res.request : null
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : 'Could not load refund requests.'
  }
}
onMounted(load)
watch(() => [props.orderId, props.status], load)

function open(kind: 'approve' | 'decline' | 'direct'): void {
  actionError.value = null
  fieldError.value = null
  declineNote.value = ''
  directReason.value = ''
  dialog.value = kind
}

async function confirm(): Promise<void> {
  const id = encodeURIComponent(props.orderId)
  fieldError.value = null
  if (dialog.value === 'decline' && declineNote.value.trim().length < 3) {
    fieldError.value = 'Tell the patient why (at least 3 characters).'
    return
  }
  if (dialog.value === 'direct' && !directReason.value) {
    fieldError.value = 'Choose a reason.'
    return
  }
  busy.value = true
  actionError.value = null
  try {
    if (dialog.value === 'approve') {
      await apiRequest(`/orders/${id}/refund-request/approve`, { method: 'POST', body: {} })
      toast('Refund approved. The patient has been refunded.', 'success')
    } else if (dialog.value === 'decline') {
      await apiRequest(`/orders/${id}/refund-request/decline`, { method: 'POST', body: { note: declineNote.value.trim() } })
      toast('Refund request declined. The patient will see your note.', 'success')
    } else if (dialog.value === 'direct') {
      await apiRequest(`/orders/${id}/refund`, { method: 'POST', body: { reasonCode: directReason.value } })
      toast('Order refunded.', 'success')
    }
    dialog.value = null
    await load()
    emit('changed')
  } catch (err) {
    actionError.value = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="refund-panel">
    <UiAlert v-if="loadError" tone="danger">{{ loadError }}</UiAlert>

    <Card v-if="request?.status === 'pending'" tone="warning" title="Refund requested by the patient" data-testid="refund-request-card">
      <dl class="facts">
        <div><dt>Reason</dt><dd>{{ REASON_LABEL[request.reasonCode] ?? request.reasonCode }}</dd></div>
        <div><dt>Requested</dt><dd>{{ when(request.createdAt) }}</dd></div>
      </dl>
      <p v-if="request.note" class="note"><span class="subtle">Patient's note:</span> {{ request.note }}</p>
      <p class="subtle">The patient keeps or disposes of the product; nothing is returned.</p>
      <div class="actions">
        <UiButton variant="danger" :disabled="busy" data-testid="approve-refund" @click="open('approve')">Approve refund</UiButton>
        <UiButton :disabled="busy" data-testid="decline-refund" @click="open('decline')">Decline</UiButton>
      </div>
    </Card>

    <p v-else-if="request" class="subtle history" data-testid="refund-request-history">
      Patient refund request {{ request.status }} {{ when(request.decidedAt) }}<template v-if="request.decisionNote">: "{{ request.decisionNote }}"</template>
    </p>

    <div v-if="status === 'paid' && !hasPending" class="direct">
      <UiButton variant="danger-quiet" size="sm" :disabled="busy" data-testid="direct-refund" @click="open('direct')">Refund order</UiButton>
    </div>

    <ConfirmDialog
      :open="dialog !== null"
      :title="dialog === 'decline' ? 'Decline this refund request?' : `Refund ${formatMoney(subtotalCents)}?`"
      :confirm-label="dialog === 'decline' ? 'Decline request' : 'Refund order'"
      :tone="dialog === 'decline' ? 'primary' : 'danger'"
      :busy="busy"
      @confirm="confirm"
      @cancel="dialog = null"
    >
      <template v-if="dialog === 'decline'">
        <p>The patient will see your note on their order.</p>
        <label for="decline-note" class="lbl">Note to the patient</label>
        <textarea id="decline-note" v-model="declineNote" rows="3" maxlength="500" data-testid="decline-note" />
      </template>
      <template v-else>
        <ul class="effects">
          <li>The patient is refunded {{ formatMoney(subtotalCents) }} in full.</li>
          <li>Your margin on this order is reversed and the 0.75% platform fee is kept (ADR-012).</li>
          <li v-if="fulfilled">The order has shipped, so stock is not returned; Cerbo writes off the cost (ADR-013).</li>
          <li v-else>Not yet shipped, so the stock is returned to inventory.</li>
          <li>This cannot be undone.</li>
        </ul>
        <template v-if="dialog === 'direct'">
          <label for="direct-reason" class="lbl">Reason</label>
          <select id="direct-reason" v-model="directReason" data-testid="direct-reason">
            <option value="" disabled>Choose a reason</option>
            <option v-for="r in DIRECT_REASONS" :key="r" :value="r">{{ REASON_LABEL[r] }}</option>
          </select>
        </template>
      </template>
      <p v-if="fieldError" class="field-error">{{ fieldError }}</p>
      <UiAlert v-if="actionError" tone="danger">{{ actionError }}</UiAlert>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.refund-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.refund-panel:empty {
  display: none;
}
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-8);
  margin: 0 0 var(--space-3);
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
  margin-bottom: var(--space-2);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.direct {
  display: flex;
  justify-content: flex-end;
}
.history {
  margin: 0;
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
textarea,
select {
  width: 100%;
}
.field-error {
  color: var(--danger);
  font-size: var(--text-sm);
  font-weight: 550;
  margin: var(--space-2) 0 0;
}
</style>
