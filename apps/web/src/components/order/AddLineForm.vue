<script setup lang="ts">
// Add a SKU to the draft (FR-1, FR-2, FR-3). Picks a product, quantity, and either a
// price or a margin %. Out-of-stock SKUs stay visible but are marked unavailable
// (FR-3 AC3). Sends unitPriceCents or marginBps; the server derives and stores the
// canonical price. Page-level add errors (e.g. INSUFFICIENT_STOCK) render here.
import { ref } from 'vue'
import type { ProductView } from '@cerbo/contracts'
import { formatCents, dollarsToCents, marginPercentToBps } from './format'

defineProps<{
  products: ProductView[]
  busy: boolean
  /** Error from the last add attempt (INSUFFICIENT_STOCK / MARGIN_NEGATIVE / other). */
  error: string | null
}>()

const emit = defineEmits<{
  (e: 'add', payload: { sku: string; qty: number; unitPriceCents?: number; marginBps?: number }): void
}>()

type Mode = 'price' | 'margin'
const sku = ref<string>('')
const qty = ref<number>(1)
const mode = ref<Mode>('price')
const priceInput = ref<string>('')
const marginInput = ref<string>('')
const inputError = ref<string | null>(null)

function submit(): void {
  inputError.value = null
  if (!sku.value) {
    inputError.value = 'Choose a product.'
    return
  }
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
    emit('add', { sku: sku.value, qty: qtyNum, unitPriceCents: cents })
  } else {
    const bps = marginPercentToBps(marginInput.value)
    if (bps === null || bps > 9500) {
      inputError.value = 'Enter a margin percent from 0 to 95.'
      return
    }
    emit('add', { sku: sku.value, qty: qtyNum, marginBps: bps })
  }
}
</script>

<template>
  <form class="add-line" @submit.prevent="submit">
    <h3>Add item</h3>
    <div class="controls">
      <label class="field">
        Product
        <select v-model="sku" :disabled="busy">
          <option value="" disabled>Select a SKU</option>
          <option
            v-for="p in products"
            :key="p.sku"
            :value="p.sku"
            :disabled="p.available <= 0"
          >
            {{ p.name }} ({{ p.sku }}) - COGS {{ formatCents(p.unitCogsCents) }} -
            {{ p.available > 0 ? `available ${p.available}` : 'unavailable' }}
          </option>
        </select>
      </label>

      <label class="field">
        Qty
        <input v-model.number="qty" type="number" min="1" max="100" step="1" :disabled="busy" />
      </label>

      <div class="mode">
        <label>
          <input type="radio" value="price" :checked="mode === 'price'" :disabled="busy" @change="mode = 'price'" />
          Price
        </label>
        <label>
          <input type="radio" value="margin" :checked="mode === 'margin'" :disabled="busy" @change="mode = 'margin'" />
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

      <button type="submit" :disabled="busy">Add to order</button>
    </div>

    <p v-if="inputError" class="inline-error" role="alert">{{ inputError }}</p>
    <p v-if="error" class="inline-error" role="alert" data-test="add-error">{{ error }}</p>
  </form>
</template>

<style scoped>
.add-line {
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 0.75rem;
  margin-bottom: 1rem;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: flex-end;
}
.field {
  display: flex;
  flex-direction: column;
  font-size: 0.85em;
  gap: 0.2rem;
}
.mode {
  display: flex;
  flex-direction: column;
  font-size: 0.85em;
}
.inline-error {
  color: #c0392b;
  margin: 0.5rem 0 0;
}
</style>
