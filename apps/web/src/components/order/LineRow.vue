<script setup lang="ts">
// One row in the Items table (FR-1..FR-3). DISPLAYS the server quote figures (price,
// COGS, fee, net margin) and never computes money.
//
// Editable on an existing item: QUANTITY (stepper + "Update Item") and, on request,
// MARGIN % ("Change margin" opens an inline editor; the server re-derives the price).
// The price itself is never typed (owner requirement). Remove asks the parent, which
// confirms before deleting. Errors (MARGIN_NEGATIVE / INSUFFICIENT_STOCK) render inline
// in a row beneath this one and are linked to the quantity field.
import { ref, watch } from 'vue'
import type { OrderLineView } from '@cerbo/contracts'
import { formatCents, marginPercentToBps } from './format'
import DemoBadge from '../DemoBadge.vue'
import QuantityStepper from '../ui/QuantityStepper.vue'
import Money from '../ui/Money.vue'

const props = defineProps<{
  line: OrderLineView
  /** Inline error message for this line, or null. */
  error: string | null
  /** True while a request for this line is in flight. */
  busy: boolean
}>()

const emit = defineEmits<{
  (e: 'commit', payload: { qty: number }): void
  (e: 'margin', payload: { marginBps: number }): void
  (e: 'remove'): void
}>()

const qty = ref<number | string>(props.line.qty)
const inputError = ref<string | null>(null)
const editingMargin = ref(false)
const marginInput = ref('')
const errId = `line-err-${props.line.id}`

watch(
  () => props.line.qty,
  () => {
    qty.value = props.line.qty
  }
)
watch(
  () => props.line.unitPriceCents,
  () => {
    editingMargin.value = false
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

function applyMargin(): void {
  inputError.value = null
  const bps = marginPercentToBps(marginInput.value)
  if (bps === null || bps > 9500) {
    inputError.value = 'Enter a margin percent from 0 to 95.'
    return
  }
  emit('margin', { marginBps: bps })
}

function openMargin(): void {
  marginInput.value = ''
  inputError.value = null
  editingMargin.value = true
}
</script>

<template>
  <tr class="item-row" :class="{ 'has-error': !!error }">
    <td data-label="Item" class="item-cell">
      <strong class="name">{{ line.name }}</strong>
      <span class="sku">{{ line.sku }}</span>
      <button type="button" class="btn-link remove" :disabled="busy" :aria-label="`Remove ${line.name}`" data-testid="remove-line" @click="emit('remove')">Remove</button>
    </td>
    <td data-label="Qty" class="qty-cell">
      <div class="qty-wrap">
        <QuantityStepper
          v-model="qty"
          :label="`Quantity of ${line.name}`"
          :disabled="busy"
          :invalid="!!(error || inputError)"
          :describedby="error || inputError ? errId : undefined"
          input-test-id="qty-input"
          @enter="commit"
        />
        <button
          type="button"
          class="btn-sm"
          :disabled="busy || Number(qty) === line.qty"
          :aria-label="`Update Item: ${line.name}`"
          @click="commit"
        >Update Item</button>
      </div>
    </td>
    <td data-label="Unit price" class="num">
      <span class="money">{{ formatCents(line.unitPriceCents) }}</span>
      <button v-if="!editingMargin" type="button" class="btn-link change" :disabled="busy" :aria-label="`Change margin for ${line.name}`" data-testid="change-margin" @click="openMargin">Change margin</button>
    </td>
    <td data-label="Line total" class="num"><span class="money" data-test="line-total">{{ formatCents(line.lineTotalCents) }}</span></td>
    <td data-label="COGS" class="num">
      <span class="cogs-head"><DemoBadge reason="COGS is Cerbo's wholesale cost. A prescribing doctor would not normally see it; shown here to make the per-line economics demonstrable." /></span>
      <span class="money" data-test="line-cogs">{{ formatCents(line.lineCogsCents) }}</span>
    </td>
    <td data-label="Fee" class="num"><span class="money">{{ formatCents(line.lineFeeCents) }}</span></td>
    <td data-label="Net margin" class="num"><Money :cents="line.lineMarginCents" strong data-test="line-margin" /></td>
  </tr>
  <tr v-if="editingMargin" class="margin-row">
    <td colspan="7">
      <form class="margin-form" @submit.prevent="applyMargin">
        <label :for="`m-${line.id}`">New margin % for {{ line.name }}</label>
        <span class="pct">
          <input :id="`m-${line.id}`" v-model="marginInput" type="text" inputmode="decimal" placeholder="e.g. 40" :disabled="busy" data-testid="line-margin-input" />
          <span aria-hidden="true">%</span>
        </span>
        <button type="submit" class="btn-primary btn-sm" :disabled="busy" data-testid="line-margin-apply">Apply margin</button>
        <button type="button" class="btn-sm" :disabled="busy" @click="editingMargin = false">Cancel</button>
        <span class="subtle">The server sets the new price from Cerbo's cost.</span>
      </form>
    </td>
  </tr>
  <tr v-if="inputError || error" class="error-row">
    <td :id="errId" colspan="7">
      <span v-if="inputError" class="inline-error" role="alert">{{ inputError }}</span>
      <span v-if="error" class="inline-error" role="alert" data-test="line-error">{{ error }}</span>
    </td>
  </tr>
</template>

<style scoped>
.item-row.has-error > td {
  background: var(--danger-tint);
}
.item-cell {
  min-width: 10rem;
}
.name {
  display: block;
  font-weight: 650;
}
.sku {
  color: var(--subtle);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.qty-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}
.change {
  display: block;
  margin-left: auto;
  font-size: var(--text-xs);
}
.cogs-head {
  margin-right: var(--space-1);
}
.remove {
  display: block;
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  color: var(--danger);
}
.remove:hover:not(:disabled) {
  color: var(--danger-strong);
}
.margin-row td {
  background: var(--brand-tint);
}
.margin-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
}
.margin-form label {
  font-weight: 600;
}
.pct {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.pct input {
  width: 6rem;
}
.error-row td {
  padding-top: var(--space-1);
  background: var(--danger-tint);
}
.inline-error {
  display: inline-block;
  color: var(--danger-strong);
  font-weight: 600;
  margin-right: var(--space-4);
}
@media (max-width: 640px) {
  .change {
    display: inline;
    margin-left: var(--space-2);
  }
}
</style>
