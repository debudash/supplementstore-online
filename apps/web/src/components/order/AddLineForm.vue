<script setup lang="ts">
// Add a SKU to the draft (FR-1, FR-2, FR-3). Picks a product, quantity, and optionally a
// margin %. Out-of-stock SKUs stay visible but are marked unavailable (FR-3 AC3).
//
// PRICE IS READ-ONLY (owner requirement): the doctor SEES the seeded catalog list price
// but never types one. The starting price is the catalog price; if the provider sets a
// margin %, the server RE-DERIVES the price (priceFromMarginBps, ADR-005) and the derived
// figure shows in the line + quote. Either way no price is typed. The API still accepts
// unitPriceCents; here we send the catalog price as-is, or marginBps when it is set.
//
// CATALOG PRICE SOURCE: ProductView.listPriceCents (integer cents, same convention as
// unitCogsCents). Read through one isolated accessor so that on a main where the field is
// not yet present the form degrades to a neutral "catalog price pending" state (margin
// required) instead of showing or sending a guessed number. Once the field is present the
// fallback simply stops being reached - no code change needed.
import { ref, computed } from 'vue'
import type { ProductView } from '@cerbo/contracts'
import { formatCents, marginPercentToBps } from './format'
import DemoBadge from '../DemoBadge.vue'

const props = defineProps<{
  products: ProductView[]
  busy: boolean
  /** Error from the last add attempt (INSUFFICIENT_STOCK / MARGIN_NEGATIVE / other). */
  error: string | null
}>()

const emit = defineEmits<{
  (e: 'add', payload: { sku: string; qty: number; unitPriceCents?: number; marginBps?: number }): void
}>()

const sku = ref<string>('')
const qty = ref<number>(1)
const marginInput = ref<string>('')
const inputError = ref<string | null>(null)

/**
 * The seeded catalog list price in integer cents, or null when the field is not present
 * (the window before the backend list_price_cents migration merges). Isolated so wiring
 * it is a single point; reads the fixed field name ProductView.listPriceCents without a
 * compile dependency on it existing yet.
 */
function listPriceCents(product: ProductView): number | null {
  const v = (product as unknown as Record<string, unknown>).listPriceCents
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null
}

const selectedProduct = computed(() => props.products.find((p) => p.sku === sku.value) ?? null)
const selectedListPrice = computed(() =>
  selectedProduct.value ? listPriceCents(selectedProduct.value) : null
)

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

  // A margin %, when set, overrides the catalog price: the server re-derives the price.
  if (marginInput.value.trim() !== '') {
    const bps = marginPercentToBps(marginInput.value)
    if (bps === null || bps > 9500) {
      inputError.value = 'Enter a margin percent from 0 to 95.'
      return
    }
    emit('add', { sku: sku.value, qty: qtyNum, marginBps: bps })
    return
  }

  // No margin: use the catalog price as-is (not typed by the doctor). If the catalog price
  // is not available yet, a margin % is required - we never fabricate a price.
  const listPrice = selectedListPrice.value
  if (listPrice === null) {
    inputError.value = 'Catalog price is not available yet. Enter a margin percent to price this line.'
    return
  }
  emit('add', { sku: sku.value, qty: qtyNum, unitPriceCents: listPrice })
}
</script>

<template>
  <form class="add-line" @submit.prevent="submit">
    <h3>Add item</h3>
    <div class="controls">
      <label class="field">
        <span class="label-row">
          Product
          <DemoBadge
            label="Demo: COGS"
            reason="COGS is Cerbo's wholesale cost, shown in this list only to make the economics demonstrable. A prescribing doctor would not normally see it."
          />
        </span>
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

      <div class="field">
        <span class="label-row">Unit price <span class="readonly-tag">read-only</span></span>
        <output class="price" data-test="unit-price">
          {{ selectedListPrice !== null ? formatCents(selectedListPrice) : 'catalog price pending' }}
        </output>
      </div>

      <label class="field">
        Qty
        <input v-model.number="qty" type="number" min="1" max="100" step="1" :disabled="busy" />
      </label>

      <label class="field">
        <span class="label-row">
          Margin %
          <DemoBadge
            reason="In production a Provider Admin sets margin in a separate login; it is editable on the doctor screen only to make the slice demonstrable."
          />
        </span>
        <input v-model="marginInput" type="text" inputmode="decimal" placeholder="optional" :disabled="busy" data-test="margin-input" />
      </label>

      <button type="submit" class="btn-primary" :disabled="busy">Add to order</button>
    </div>

    <p class="hint">
      The price starts from the catalog value. Set a margin % to have the server re-derive
      the price - the new figure appears on the line and in the quote. You never type a price.
    </p>

    <p v-if="inputError" class="inline-error" role="alert">{{ inputError }}</p>
    <p v-if="error" class="inline-error" role="alert" data-test="add-error">{{ error }}</p>
  </form>
</template>

<style scoped>
.add-line {
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: var(--radius);
  padding: 0.85rem 1rem;
  margin-bottom: 1rem;
  box-shadow: var(--shadow-sm);
}
.add-line h3 {
  margin: 0 0 0.6rem;
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
.label-row {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.readonly-tag {
  color: var(--subtle);
  font-size: 0.9em;
  font-style: italic;
}
.price {
  font-variant-numeric: tabular-nums;
  padding: 0.3rem 0;
  color: var(--text);
}
.hint {
  color: var(--muted);
  font-size: 0.82em;
  margin: 0.6rem 0 0;
}
.inline-error {
  color: var(--danger);
  background: var(--danger-tint);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  padding: 0.4rem 0.6rem;
  margin: 0.6rem 0 0;
}
</style>
