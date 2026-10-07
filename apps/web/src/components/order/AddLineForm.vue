<script setup lang="ts">
// Add a product to the draft (FR-1, FR-2, FR-3).
//
// PRICE IS NOT EDITABLE IN AN ORDER (owner requirement). The provider sees the catalog
// list price (read-only) and can only change it through Margin %. With margin blank we
// send the list price as-is; with a margin we send marginBps and the SERVER derives the
// price from Cerbo's cost (priceFromMarginBps, ADR-005). The UI never computes a price.
// List prices themselves are maintained by Cerbo Admin.
//
// Availability: out-of-stock products stay listed but disabled (FR-3 AC3); the chosen
// product shows an In stock / Low stock / Out of stock chip from the API's `available`.
import { ref, computed, watch } from 'vue'
import type { ProductView } from '@cerbo/contracts'
import { formatCents, marginPercentToBps } from './format'
import DemoBadge from '../DemoBadge.vue'
import QuantityStepper from '../ui/QuantityStepper.vue'

const props = defineProps<{
  products: ProductView[]
  busy: boolean
  /** Error from the last add attempt (INSUFFICIENT_STOCK / MARGIN_NEGATIVE / other). */
  error: string | null
  /** Quantity already on this draft per SKU. A SKU already on the order is hidden here
   *  (change its quantity on the item row instead); removing the item brings it back. */
  onOrder?: Record<string, number>
}>()

const emit = defineEmits<{
  (e: 'add', payload: { sku: string; qty: number; unitPriceCents?: number; marginBps?: number }): void
}>()

const LOW_STOCK = 5

const sku = ref<string>('')
const qty = ref<number | string>(1)
const marginInput = ref<string>('')
const productError = ref<string | null>(null)
const qtyError = ref<string | null>(null)
const marginError = ref<string | null>(null)

const addableProducts = computed(() => props.products.filter((p) => (props.onOrder?.[p.sku] ?? 0) === 0))
const selectedProduct = computed(() => addableProducts.value.find((p) => p.sku === sku.value) ?? null)
const selectedListPrice = computed(() => selectedProduct.value?.listPriceCents ?? null)

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
    marginInput.value = ''
  }
})

function submit(): void {
  productError.value = null
  qtyError.value = null
  marginError.value = null
  if (!sku.value) {
    productError.value = 'Choose a product.'
    return
  }
  const qtyNum = Math.trunc(Number(qty.value))
  if (!Number.isInteger(qtyNum) || qtyNum < 1 || qtyNum > 100) {
    qtyError.value = 'Quantity must be a whole number from 1 to 100.'
    return
  }
  if (marginInput.value.trim() !== '') {
    const bps = marginPercentToBps(marginInput.value)
    if (bps === null || bps > 9500) {
      marginError.value = 'Enter a margin percent from 0 to 95.'
      return
    }
    emit('add', { sku: sku.value, qty: qtyNum, marginBps: bps })
    return
  }
  if (selectedListPrice.value === null) {
    productError.value = 'Choose a product.'
    return
  }
  emit('add', { sku: sku.value, qty: qtyNum, unitPriceCents: selectedListPrice.value })
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
        <span id="add-price-label" class="label">List price <span class="tag">read-only</span></span>
        <output class="price" aria-labelledby="add-price-label" data-test="unit-price">{{ selectedListPrice !== null ? formatCents(selectedListPrice) : '-' }}</output>
      </div>

      <div class="field">
        <span class="label" aria-hidden="true">Quantity</span>
        <QuantityStepper v-model="qty" label="Quantity" :disabled="busy" :invalid="!!qtyError" data-testid="add-qty" />
        <span v-if="qtyError" class="err">{{ qtyError }}</span>
      </div>

      <div class="field margin">
        <span class="label-row">
          <label for="add-margin" class="label">Margin %</label>
          <span class="tag">optional</span>
          <DemoBadge reason="In production a Provider Admin sets margin in a separate login; it is editable on the doctor screen only to make the slice demonstrable." />
        </span>
        <span class="pct">
          <input
            id="add-margin"
            v-model="marginInput"
            type="text"
            inputmode="decimal"
            placeholder="e.g. 40"
            :disabled="busy"
            :aria-invalid="marginError ? 'true' : undefined"
            aria-describedby="add-margin-hint"
            data-test="margin-input"
          />
          <span aria-hidden="true">%</span>
        </span>
        <span v-if="marginError" class="err">{{ marginError }}</span>
      </div>

      <div class="submit">
        <button type="submit" class="btn-primary" :disabled="busy" data-testid="add-submit">Add to order</button>
      </div>
    </div>

    <p id="add-margin-hint" class="hint">
      Blank margin uses the list price. A margin sets the price from Cerbo's cost so that
      your share of the price is that percent, before the platform fee - it can raise or
      lower the price. The resulting price shows on the item line.
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
  grid-template-columns: minmax(14rem, 2fr) minmax(7rem, auto) auto minmax(8rem, 1fr) auto;
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
.price {
  display: flex;
  align-items: center;
  min-height: 2.5rem;
  font-size: var(--text-lg);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.pct {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.pct input {
  width: 100%;
  min-width: 5rem;
}
.submit {
  align-self: end;
  padding-top: 1.6rem;
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
@media (max-width: 980px) {
  .grid {
    grid-template-columns: 1fr 1fr;
  }
  .product {
    grid-column: 1 / -1;
  }
  .submit {
    grid-column: 1 / -1;
    padding-top: 0;
  }
  .submit button {
    width: 100%;
  }
}
@media (max-width: 480px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
