<script setup lang="ts">
// One row in the Items table (FR-1..FR-3). DISPLAYS the server quote figures (price,
// COGS, fee, net margin) and never computes money.
//
// UPDATE IS QUANTITY ONLY (owner requirement): the only editable field on an existing
// item is its quantity - no price or margin field. Since a SKU already on the order is
// hidden from the Add dropdown, this row is the ONLY way to change its quantity. The
// canonical price was set from the margin % / catalog price at add time and is derived on
// the server (ADR-005); the API still accepts a price/margin on PATCH, the UI sends only
// quantity. A per-line error (MARGIN_NEGATIVE / INSUFFICIENT_STOCK) renders inline in a
// row beneath this one.
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
  <tr class="item-row" :class="{ 'has-error': !!error }">
    <td>
      <strong class="name">{{ line.name }}</strong>
      <span class="sku">{{ line.sku }}</span>
    </td>
    <td class="qty-cell">
      <input
        v-model.number="qty"
        type="number"
        min="1"
        max="100"
        step="1"
        :disabled="busy"
        aria-label="Quantity"
        data-test="qty-input"
      />
    </td>
    <td class="num">{{ formatCents(line.unitPriceCents) }}</td>
    <td class="num" data-test="line-total">{{ formatCents(line.lineTotalCents) }}</td>
    <td class="num">
      <span class="cogs-head"><DemoBadge reason="COGS is Cerbo's wholesale cost. A prescribing doctor would not normally see it; shown here to make the per-line economics demonstrable." /></span>
      <span data-test="line-cogs">{{ formatCents(line.lineCogsCents) }}</span>
    </td>
    <td class="num">{{ formatCents(line.lineFeeCents) }}</td>
    <td class="num" data-test="line-margin">{{ formatCents(line.lineMarginCents) }}</td>
    <td class="actions-cell">
      <button type="button" :disabled="busy" @click="commit">Update Item</button>
      <button type="button" class="remove" :disabled="busy" @click="emit('remove')">Remove</button>
    </td>
  </tr>
  <tr v-if="inputError || error" class="error-row">
    <td colspan="8">
      <span v-if="inputError" class="inline-error" role="alert">{{ inputError }}</span>
      <span v-if="error" class="inline-error" role="alert" data-test="line-error">{{ error }}</span>
    </td>
  </tr>
</template>

<style scoped>
.item-row.has-error > td {
  background: var(--danger-tint);
}
.name {
  font-weight: 600;
}
.sku {
  color: var(--subtle);
  font-size: 0.85em;
  margin-left: 0.4rem;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.cogs-head {
  margin-right: 0.35rem;
}
.qty-cell input {
  width: 4.5rem;
}
.actions-cell {
  display: flex;
  gap: 0.5rem;
  white-space: nowrap;
}
.remove {
  color: var(--danger);
  border-color: var(--border-strong);
}
.error-row td {
  padding-top: 0;
}
.inline-error {
  display: inline-block;
  color: var(--danger);
  margin-right: 1rem;
}
</style>
