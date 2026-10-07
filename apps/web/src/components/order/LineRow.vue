<script setup lang="ts">
// One cart line (FR-1..FR-3). The line DISPLAYS the server quote figures (price, COGS,
// fee, net margin) and never computes money.
//
// UPDATE LINE IS QUANTITY ONLY (owner requirement): no price or margin field on an
// existing line - just quantity plus Remove. The canonical price was set from the
// margin % at add time and is derived on the server (ADR-005); editing it mid-order is
// not a doctor-facing action. The API still accepts a price/margin on PATCH; the UI
// simply sends quantity. A per-line error (MARGIN_NEGATIVE or INSUFFICIENT_STOCK)
// renders inline against this line, not as a page banner.
import { ref, watch } from 'vue'
import type { OrderLineView } from '@cerbo/contracts'
import { formatCents } from './format'
import DemoBadge from '../DemoBadge.vue'

const props = defineProps<{
  line: OrderLineView
  /** Inline error message for this line, or null. */
  error: string | null
  /** True while a request for this line is in flight. */
  busy: boolean
}>()

const emit = defineEmits<{
  (e: 'commit', payload: { qty: number }): void
  (e: 'remove'): void
}>()

const qty = ref<number>(props.line.qty)
const inputError = ref<string | null>(null)

// Reseed the quantity field when the server view for this line changes.
watch(
  () => props.line.qty,
  () => {
    qty.value = props.line.qty
  }
)

function commit(): void {
  inputError.value = null
  const qtyNum = Math.trunc(Number(qty.value))
  if (!Number.isInteger(qtyNum) || qtyNum < 1 || qtyNum > 100) {
    inputError.value = 'Quantity must be a whole number from 1 to 100.'
    return
  }
  emit('commit', { qty: qtyNum })
}
</script>

<template>
  <div class="line-row" :class="{ 'has-error': !!error }">
    <div class="line-head">
      <strong class="name">{{ line.name }}</strong>
      <span class="sku">{{ line.sku }}</span>
    </div>

    <div class="controls">
      <label class="field">
        Qty
        <input v-model.number="qty" type="number" min="1" max="100" step="1" :disabled="busy" data-test="qty-input" />
      </label>

      <button type="button" :disabled="busy" @click="commit">Update line</button>
      <button type="button" class="remove" :disabled="busy" @click="emit('remove')">Remove</button>
    </div>

    <p v-if="inputError" class="inline-error" role="alert">{{ inputError }}</p>
    <p v-if="error" class="inline-error" role="alert" data-test="line-error">{{ error }}</p>

    <dl class="figures">
      <div><dt>Unit price</dt><dd>{{ formatCents(line.unitPriceCents) }}</dd></div>
      <div><dt>Line total</dt><dd data-test="line-total">{{ formatCents(line.lineTotalCents) }}</dd></div>
      <div>
        <dt class="label-row">COGS <DemoBadge reason="COGS is Cerbo's wholesale cost. A prescribing doctor would not normally see it; shown here to make the per-line economics demonstrable." /></dt>
        <dd data-test="line-cogs">{{ formatCents(line.lineCogsCents) }}</dd>
      </div>
      <div><dt>Fee</dt><dd>{{ formatCents(line.lineFeeCents) }}</dd></div>
      <div><dt>Net margin</dt><dd data-test="line-margin">{{ formatCents(line.lineMarginCents) }}</dd></div>
    </dl>
  </div>
</template>

<style scoped>
.line-row {
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: var(--radius);
  padding: 0.85rem;
  margin-bottom: 0.75rem;
  box-shadow: var(--shadow-sm);
}
.line-row.has-error {
  border-color: var(--danger);
}
.line-head {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  margin-bottom: 0.5rem;
}
.name {
  font-weight: 600;
}
.sku {
  color: var(--subtle);
  font-size: 0.85em;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.85rem;
  align-items: flex-end;
}
.field {
  display: flex;
  flex-direction: column;
  font-size: 0.82em;
  color: var(--muted);
  gap: 0.25rem;
}
.field input {
  width: 7rem;
}
.remove {
  color: var(--danger);
  border-color: var(--border-strong);
}
.inline-error {
  color: var(--danger);
  background: var(--danger-tint);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  padding: 0.4rem 0.6rem;
  margin: 0.5rem 0 0;
}
.figures {
  display: flex;
  flex-wrap: wrap;
  gap: 1.4rem;
  margin: 0.75rem 0 0;
  padding-top: 0.6rem;
  border-top: 1px solid var(--border);
}
.figures div {
  display: flex;
  flex-direction: column;
}
.figures dt {
  color: var(--muted);
  font-size: 0.78em;
}
.label-row {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.figures dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
</style>
