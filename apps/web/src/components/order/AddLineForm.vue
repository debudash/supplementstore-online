<script setup lang="ts">
// Add a product to the draft (FR-1, FR-2, FR-3).
//
// PRICE IS NOT TYPED (owner requirement). The provider enters their per-unit dollar
// markup (required, $0 to $1,000); we send markupCents and the SERVER derives the price:
// Cerbo's cost + markup, grossed up so the 0.75% fee is covered (priceFromMarkupCents,
// ADR-028). The live preview shows what the patient pays. The UI never computes a price.
//
// Availability: out-of-stock products stay listed but disabled (FR-3 AC3); the chosen
// product shows an In stock / Low stock / Out of stock chip from the API's `available`.
import { ref, computed, watch } from 'vue'
import type { ProductView, PricePreview } from '@cerbo/contracts'
import { formatCents, dollarsToCents } from './format'
import DemoBadge from '../DemoBadge.vue'
import QuantityStepper from '../ui/QuantityStepper.vue'
import MarkupPreview from './MarkupPreview.vue'

const props = defineProps<{
  products: ProductView[]
  busy: boolean
  /** Error from the last add attempt (INSUFFICIENT_STOCK / other). */
  error: string | null
  /** Quantity already on this draft per SKU. A SKU already on the order is hidden here
   *  (change its quantity on the item row instead); removing the item brings it back. */
  onOrder?: Record<string, number>
  /** Server price preview for a markup (ADR-028). Optional: without it no preview shows. */
  previewPrice?: (sku: string, markupCents: number) => Promise<PricePreview>
}>()

const emit = defineEmits<{
  (e: 'add', payload: { sku: string; qty: number; markupCents: number }): void
}>()

const LOW_STOCK = 5
/** Largest per-unit markup the server accepts: $1,000 (ADR-028). */
const MAX_MARKUP_CENTS = 100000

const sku = ref<string>('')
const qty = ref<number | string>(1)
const markupInput = ref<string>('')
const productError = ref<string | null>(null)
const qtyError = ref<string | null>(null)
const markupError = ref<string | null>(null)

const addableProducts = computed(() => props.products.filter((p) => (props.onOrder?.[p.sku] ?? 0) === 0))
const selectedProduct = computed(() => addableProducts.value.find((p) => p.sku === sku.value) ?? null)

function stockLabel(available: number): string {
  if (available <= 0) return 'Out of stock'
  if (available <= LOW_STOCK) return `Low stock - ${available} left`
  return `In stock - ${available}`
}
function stockTone(available: number): string {
  if (available <= 0) return 'badge-danger'
  if (available <= LOW_STOCK) return 'badge-warning'
  return 'badge-success'
}

watch(addableProducts, (list) => {
  if (sku.value && !list.some((p) => p.sku === sku.value)) {
    sku.value = ''
    markupInput.value = ''
  }
})

function submit(): void {
  productError.value = null
  qtyError.value = null
  markupError.value = null
  if (!sku.value) {
    productError.value = 'Choose a product.'
    return
  }
  const qtyNum = Math.trunc(Number(qty.value))
  if (!Number.isInteger(qtyNum) || qtyNum < 1 || qtyNum > 100) {
    qtyError.value = 'Quantity must be a whole number from 1 to 100.'
    return
  }
  const markupCents = dollarsToCents(markupInput.value)
  if (markupCents === null || markupCents > MAX_MARKUP_CENTS) {
    markupError.value = 'Enter your markup per unit in dollars, from 0 to 1000 (e.g. 10 or 12.50).'
    return
  }
  emit('add', { sku: sku.value, qty: qtyNum, markupCents })
}
</script>

<template>
  <form class="add-line" aria-labelledby="add-item-title" novalidate @submit.prevent="submit">
    <h2 id="add-item-title" class="title">Add item</h2>

    <div class="grid">
      <div class="field product">
        <label for="add-sku" class="label">Product</label>
        <select
          id="add-sku"
          v-model="sku"
          :disabled="busy"
          :aria-invalid="productError ? 'true' : undefined"
          aria-describedby="add-sku-detail"
          data-testid="add-product"
        >
          <option value="" disabled>Select a product</option>
          <option v-for="p in addableProducts" :key="p.sku" :value="p.sku" :disabled="p.available <= 0">
            {{ p.name }} - {{ p.available > 0 ? stockLabel(p.available) : 'Out of stock' }}
          </option>
        </select>
        <span v-if="productError" class="err">{{ productError }}</span>
        <div id="add-sku-detail" class="detail">
          <template v-if="selectedProduct">
            <span class="badge" :class="stockTone(selectedProduct.available)" data-testid="stock-chip">{{ stockLabel(selectedProduct.available) }}</span>
            <span class="sku">{{ selectedProduct.sku }}</span>
          </template>
          <span class="cogs">
            Cerbo cost
            <strong class="money" data-testid="add-cogs">{{ selectedProduct ? formatCents(selectedProduct.unitCogsCents) : '-' }}</strong>
            <DemoBadge
              label="Demo: COGS"
              reason="COGS is Cerbo's wholesale cost, shown here only to make the economics demonstrable. A prescribing doctor would not normally see it."
            />
          </span>
        </div>
      </div>

      <div class="field">
        <span class="label" aria-hidden="true">Quantity</span>
        <QuantityStepper v-model="qty" label="Quantity" :disabled="busy" :invalid="!!qtyError" data-testid="add-qty" />
        <span v-if="qtyError" class="err">{{ qtyError }}</span>
      </div>

      <div class="field markup">
        <label for="add-markup" class="label">Your markup <span class="tag">$ per unit</span></label>
        <span class="dollar">
          <span aria-hidden="true">$</span>
          <input
            id="add-markup"
            v-model="markupInput"
            type="text"
            inputmode="decimal"
            placeholder="e.g. 10.00"
            :disabled="busy"
            :aria-invalid="markupError ? 'true' : undefined"
            aria-describedby="add-markup-hint"
            data-test="markup-input"
          />
        </span>
        <span v-if="markupError" class="err">{{ markupError }}</span>
        <MarkupPreview v-else :sku="sku || null" :markup-input="markupInput" :preview="previewPrice" />
      </div>

      <div class="submit">
        <button type="submit" class="btn-primary" :disabled="busy" data-testid="add-submit">Add to order</button>
      </div>
    </div>

    <p id="add-markup-hint" class="hint">
      The patient pays Cerbo's cost plus your markup plus the 0.75% platform fee, so you
      keep the markup you enter. You will see the patient's price as you type.
    </p>
    <p v-if="error" class="field-alert" role="alert" data-test="add-error">{{ error }}</p>
  </form>
</template>

<style scoped>
.add-line {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  padding: var(--space-5);
}
.title {
  font-size: var(--text-lg);
  margin: 0 0 var(--space-4);
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-4);
  align-items: start;
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.label,
.label-row {
  font-size: var(--text-sm);
  font-weight: 600;
}
.label-row {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
.tag {
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--muted);
}
.detail {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--muted);
  margin-top: var(--space-1);
}
.sku {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.cogs {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.cogs strong {
  color: var(--text);
}
.dollar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.dollar input {
  width: 100%;
  min-width: 5rem;
}
.product {
  grid-column: span 2;
}
.field > :deep(.stepper) {
  align-self: flex-start;
}
.submit {
  align-self: end;
}
.submit button {
  width: 100%;
}
.err {
  color: var(--danger);
  font-size: var(--text-sm);
  font-weight: 550;
}
.hint {
  margin: var(--space-4) 0 0;
  font-size: var(--text-sm);
  color: var(--muted);
}
.field-alert {
  margin: var(--space-3) 0 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--danger-border);
  border-left: 4px solid var(--danger);
  border-radius: var(--radius-sm);
  background: var(--danger-tint);
  color: var(--danger-strong);
  font-weight: 550;
}
@media (max-width: 560px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .product {
    grid-column: auto;
  }
}
</style>
