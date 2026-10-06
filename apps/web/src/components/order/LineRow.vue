<script setup lang="ts">
// One cart line (FR-1..FR-3). The provider sets EITHER a patient-facing price OR a
// margin % (ADR-005); the other is derived on the SERVER (price is canonical). This
// row sends unitPriceCents or marginBps and DISPLAYS the server quote figures (price,
// COGS, fee, net margin) - it never computes money. A per-line error (MARGIN_NEGATIVE
// or INSUFFICIENT_STOCK) renders inline against this line, not as a page banner.
import { ref, watch } from 'vue'
import type { OrderLineView } from '@cerbo/contracts'
import { formatCents, centsToPlain, dollarsToCents, marginPercentToBps } from './format'

const props = defineProps<{
  line: OrderLineView
  /** Inline error message for this line, or null. */
  error: string | null
  /** True while a request for this line is in flight. */
  busy: boolean
}>()

const emit = defineEmits<{
  (e: 'commit', payload: { qty: number; unitPriceCents?: number; marginBps?: number }): void
  (e: 'remove'): void
}>()

type Mode = 'price' | 'margin'
const mode = ref<Mode>('price')
const qty = ref<number>(props.line.qty)
const priceInput = ref<string>(centsToPlain(props.line.unitPriceCents))
const marginInput = ref<string>('')
const inputError = ref<string | null>(null)

// Reseed editable fields when the server view for this line changes (e.g. after a
// successful quote refresh), but never prefill the margin field from the price: that
// would mean computing margin % in JavaScript, which the UI must not do.
watch(
  () => [props.line.qty, props.line.unitPriceCents],
  () => {
    qty.value = props.line.qty
    if (mode.value === 'price') priceInput.value = centsToPlain(props.line.unitPriceCents)
  }
)

function setMode(next: Mode): void {
  mode.value = next
  inputError.value = null
  if (next === 'price') priceInput.value = centsToPlain(props.line.unitPriceCents)
  else marginInput.value = ''
}

function commit(): void {
  inputError.value = null
  const qtyNum = Math.trunc(Number(qty.value))
  if (!Number.isInteger(qtyNum) || qtyNum < 1 || qtyNum > 100) {
    inputError.value = 'Quantity must be a whole number from 1 to 100.'
    return
  }
  if (mode.value === 'price') {
    const cents = dollarsToCents(priceInput.value)
    if (cents === null || cents < 1) {
      inputError.value = 'Enter a valid price, e.g. 29.99.'
      return
    }
    emit('commit', { qty: qtyNum, unitPriceCents: cents })
  } else {
    const bps = marginPercentToBps(marginInput.value)
    if (bps === null || bps > 9500) {
      inputError.value = 'Enter a margin percent from 0 to 95.'
      return
    }
    emit('commit', { qty: qtyNum, marginBps: bps })
  }
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
        <input v-model.number="qty" type="number" min="1" max="100" step="1" :disabled="busy" />
      </label>

      <div class="mode">
        <label>
          <input type="radio" value="price" :checked="mode === 'price'" :disabled="busy" @change="setMode('price')" />
          Price
        </label>
        <label>
          <input type="radio" value="margin" :checked="mode === 'margin'" :disabled="busy" @change="setMode('margin')" />
          Margin %
        </label>
      </div>

      <label v-if="mode === 'price'" class="field">
        Unit price
        <input v-model="priceInput" type="text" inputmode="decimal" placeholder="29.99" :disabled="busy" />
      </label>
      <label v-else class="field">
        Margin %
        <input v-model="marginInput" type="text" inputmode="decimal" placeholder="50" :disabled="busy" />
      </label>

      <button type="button" :disabled="busy" @click="commit">Update line</button>
      <button type="button" class="remove" :disabled="busy" @click="emit('remove')">Remove</button>
    </div>

    <p v-if="inputError" class="inline-error" role="alert">{{ inputError }}</p>
    <p v-if="error" class="inline-error" role="alert" data-test="line-error">{{ error }}</p>

    <dl class="figures">
      <div><dt>Unit price</dt><dd>{{ formatCents(line.unitPriceCents) }}</dd></div>
      <div><dt>Line total</dt><dd data-test="line-total">{{ formatCents(line.lineTotalCents) }}</dd></div>
      <div><dt>COGS</dt><dd>{{ formatCents(line.lineCogsCents) }}</dd></div>
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
.mode {
  display: flex;
  flex-direction: column;
  font-size: 0.82em;
  gap: 0.1rem;
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
.figures dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
</style>
