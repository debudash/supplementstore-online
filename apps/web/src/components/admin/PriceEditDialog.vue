<script setup lang="ts">
// Cerbo Admin list-price editor (ADR-025): Edit -> Review -> Save.
//
// Edit: new price (typed in dollars, parsed to integer cents as a string - never float
// math) and a required reason. Review: the SERVER's preview (current vs new price and
// margin, difference, active schedules that will pick it up). Save: PATCH with the price
// the admin saw, so a concurrent change is refused (PRICE_CONFLICT) instead of being
// overwritten. Every figure shown comes from the API; the UI only formats.
import { computed, ref, watch } from 'vue'
import type { AdminInventoryItem, ListPricePreview, UpdateListPriceResult } from '@cerbo/contracts'
import { apiRequest, ApiError } from '../../api/client'
import { dollarsToCents } from '../order/format'
import { formatMoney, formatBps } from '../../utils/money'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import UiAlert from '../ui/UiAlert.vue'

const props = defineProps<{ item: AdminInventoryItem | null }>()
const emit = defineEmits<{
  (e: 'saved', result: UpdateListPriceResult): void
  (e: 'close'): void
  (e: 'conflict'): void
}>()

const REASON_MIN = 3
const REASON_MAX = 500

const step = ref<'edit' | 'review'>('edit')
const priceInput = ref('')
const reason = ref('')
const priceError = ref<string | null>(null)
const reasonError = ref<string | null>(null)
const serverError = ref<string | null>(null)
const conflict = ref(false)
const busy = ref(false)
const preview = ref<ListPricePreview | null>(null)

watch(
  () => props.item,
  () => {
    step.value = 'edit'
    priceInput.value = ''
    reason.value = ''
    priceError.value = null
    reasonError.value = null
    serverError.value = null
    conflict.value = false
    preview.value = null
  }
)

const title = computed(() => (props.item ? `${step.value === 'edit' ? 'Change list price' : 'Review price change'}: ${props.item.name}` : ''))
const confirmLabel = computed(() => (step.value === 'edit' ? 'Review change' : 'Save new price'))
const differenceLabel = computed(() => {
  const d = preview.value?.differenceCents ?? 0
  const abs = formatMoney(d).replace(/^-/, '')
  return d > 0 ? `${abs} increase` : d < 0 ? `${abs} decrease` : 'No change'
})

async function toReview(): Promise<void> {
  const item = props.item
  if (!item) return
  priceError.value = null
  reasonError.value = null
  serverError.value = null
  const cents = dollarsToCents(priceInput.value)
  if (cents === null || cents < 1) priceError.value = 'Enter a price in dollars, for example 32.99.'
  else if (cents === item.listPriceCents) priceError.value = 'That is already the current price.'
  else if (cents <= item.unitCogsCents) priceError.value = `The price must be above Cerbo's cost of ${formatMoney(item.unitCogsCents)}.`
  const r = reason.value.trim()
  if (r.length < REASON_MIN || r.length > REASON_MAX) reasonError.value = `Give a reason (${REASON_MIN} to ${REASON_MAX} characters).`
  if (priceError.value || reasonError.value || cents === null) return

  busy.value = true
  try {
    preview.value = await apiRequest<ListPricePreview>(
      `/admin/products/${encodeURIComponent(item.sku)}/list-price-preview?listPriceCents=${cents}`
    )
    step.value = 'review'
  } catch (err) {
    serverError.value = err instanceof ApiError ? err.message : 'Could not preview this change.'
  } finally {
    busy.value = false
  }
}

async function save(): Promise<void> {
  const item = props.item
  const p = preview.value
  if (!item || !p) return
  busy.value = true
  serverError.value = null
  try {
    const result = await apiRequest<UpdateListPriceResult>(`/admin/products/${encodeURIComponent(item.sku)}/list-price`, {
      method: 'PATCH',
      body: { listPriceCents: p.listPriceCents, expectedCurrentPriceCents: item.listPriceCents, reason: reason.value.trim() }
    })
    emit('saved', result)
  } catch (err) {
    if (err instanceof ApiError && err.code === 'PRICE_CONFLICT') {
      conflict.value = true
      const current = (err.details as { currentPriceCents?: number }).currentPriceCents
      serverError.value = `Someone else changed this price${current ? ` to ${formatMoney(current)}` : ''} while you were editing. Nothing was saved.`
      emit('conflict')
    } else {
      serverError.value = err instanceof ApiError ? err.message : 'Could not save the new price.'
    }
  } finally {
    busy.value = false
  }
}

function onConfirm(): void {
  if (conflict.value) return emit('close')
  if (step.value === 'edit') void toReview()
  else void save()
}
function onCancel(): void {
  if (step.value === 'review' && !conflict.value) {
    step.value = 'edit'
    return
  }
  emit('close')
}
</script>

<template>
  <ConfirmDialog
    :open="item !== null"
    :title="title"
    :confirm-label="conflict ? 'Close' : confirmLabel"
    :cancel-label="step === 'review' && !conflict ? 'Back' : 'Cancel'"
    :busy="busy"
    @confirm="onConfirm"
    @cancel="onCancel"
  >
    <template v-if="item">
      <dl class="facts">
        <div><dt>Current list price</dt><dd class="money">{{ formatMoney(item.listPriceCents) }}</dd></div>
        <div><dt>Cerbo cost (COGS)</dt><dd class="money">{{ formatMoney(item.unitCogsCents) }}</dd></div>
        <div><dt>Margin at list</dt><dd>{{ formatBps(item.listMarginBps) }}</dd></div>
      </dl>

      <div v-if="step === 'edit'" class="form" data-testid="price-edit-step">
        <div class="field">
          <label for="new-price">New list price</label>
          <span class="dollar">
            <span aria-hidden="true">$</span>
            <input
              id="new-price"
              v-model="priceInput"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              placeholder="32.99"
              :aria-invalid="priceError ? 'true' : undefined"
              :aria-describedby="priceError ? 'new-price-err' : 'new-price-hint'"
              data-testid="new-price-input"
              @keydown.enter.prevent="onConfirm"
            />
          </span>
          <span v-if="priceError" id="new-price-err" class="err">{{ priceError }}</span>
          <span v-else id="new-price-hint" class="hint">Must be above Cerbo's cost.</span>
        </div>
        <div class="field">
          <label for="price-reason">Reason for the change</label>
          <textarea
            id="price-reason"
            v-model="reason"
            rows="2"
            :maxlength="REASON_MAX"
            placeholder="e.g. Supplier cost increase from Oct 1"
            :aria-invalid="reasonError ? 'true' : undefined"
            :aria-describedby="reasonError ? 'price-reason-err' : 'price-reason-hint'"
            data-testid="price-reason-input"
          />
          <span v-if="reasonError" id="price-reason-err" class="err">{{ reasonError }}</span>
          <span v-else id="price-reason-hint" class="hint">Saved in the price history with your name.</span>
        </div>
      </div>

      <div v-else-if="preview" class="review" data-testid="price-review-step">
        <table class="table compare">
          <thead>
            <tr><th scope="col"></th><th scope="col" class="num">Current</th><th scope="col" class="num">New</th></tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">List price</th>
              <td class="num money">{{ formatMoney(preview.currentPriceCents) }}</td>
              <td class="num money strong" data-testid="review-new-price">{{ formatMoney(preview.listPriceCents) }}</td>
            </tr>
            <tr>
              <th scope="row">Margin at list</th>
              <td class="num">{{ formatBps(preview.currentMarginBps) }}</td>
              <td class="num strong" data-testid="review-new-margin">{{ formatBps(preview.listMarginBps) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="diff">{{ differenceLabel }}</p>

        <UiAlert v-if="preview.activeScheduleCount > 0" tone="warning" title="Recurring orders will change">
          {{ preview.activeScheduleCount }} active recurring
          {{ preview.activeScheduleCount === 1 ? 'schedule includes' : 'schedules include' }} this product. They will charge
          the new price from their next cycle.
        </UiAlert>
        <ul class="effects">
          <li>New orders start from the new price.</li>
          <li>Draft and sent orders keep the price already on them.</li>
          <li>Margin shown is before the 0.75% platform fee.</li>
          <li>The change and your reason are recorded in the price history.</li>
        </ul>
      </div>

      <UiAlert v-if="serverError" :tone="conflict ? 'warning' : 'danger'" class="server-err">{{ serverError }}</UiAlert>
    </template>
  </ConfirmDialog>
</template>

<style scoped>
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-6);
  margin: 0 0 var(--space-4);
  padding: var(--space-3) var(--space-4);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
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
  font-weight: 650;
}
.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.field label {
  font-size: var(--text-sm);
  font-weight: 600;
}
.dollar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-weight: 650;
}
.dollar input {
  width: 9rem;
  font-variant-numeric: tabular-nums;
}
textarea {
  width: 100%;
  resize: vertical;
}
.hint {
  font-size: var(--text-sm);
  color: var(--muted);
}
.err {
  font-size: var(--text-sm);
  color: var(--danger);
  font-weight: 550;
}
.compare {
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.compare th[scope='row'] {
  text-transform: none;
  font-size: var(--text-sm);
  letter-spacing: 0;
  color: var(--text);
  background: none;
  position: static;
}
.strong {
  font-weight: 700;
}
.diff {
  margin: var(--space-2) 0 var(--space-4);
  font-weight: 650;
  text-align: right;
}
.effects {
  margin: var(--space-4) 0 0;
  padding-left: var(--space-5);
  color: var(--muted);
  font-size: var(--text-sm);
}
.server-err {
  margin-top: var(--space-4);
}
</style>
