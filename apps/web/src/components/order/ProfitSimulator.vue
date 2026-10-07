<script setup lang="ts">
// Profit simulator (ADR-025): "what would I earn at this margin?" before adding an item.
//
// Asks the SERVER for two previews via the injected `preview` function
// (GET /api/products/:sku/price-preview): the chosen scenario and the list-price
// baseline, for the same units per month. The browser never computes money - it only
// formats the server's figures. The slider value IS marginBps (basis points, not money).
// Debounced; stale replies are ignored. Collapsed by default and nothing is fetched until
// it is opened. Nothing is saved.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ProductView, PricePreview } from '@cerbo/contracts'
import { formatBps, formatMoney } from '../../utils/money'
import Card from '../ui/Card.vue'
import UiAlert from '../ui/UiAlert.vue'
import UiButton from '../ui/UiButton.vue'
import Money from '../ui/Money.vue'
import QuantityStepper from '../ui/QuantityStepper.vue'
import DemoBadge from '../DemoBadge.vue'

const props = defineProps<{
  products: ProductView[]
  preview: (sku: string, marginBps: number | null, qty: number) => Promise<PricePreview>
}>()

const MAX_BPS = 9500
const STEP_BPS = 50
const MAX_QTY = 1000

const uid = `sim-${Math.random().toString(36).slice(2, 9)}`
const open = ref(false)
const sku = ref<string>('')
/** null = list price mode; otherwise the slider's basis points. */
const marginBps = ref<number | null>(null)
const qty = ref<number | string>(1)

const scenario = ref<PricePreview | null>(null)
const baseline = ref<PricePreview | null>(null)
const failed = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null
let seq = 0

const selected = computed(() => props.products.find((p) => p.sku === sku.value) ?? null)

/** List margin snapped down to the slider step (basis points, not money). */
function snappedListBps(p: ProductView | null): number {
  const bps = p && typeof p.listMarginBps === 'number' ? p.listMarginBps : 0
  return Math.min(MAX_BPS, Math.max(0, Math.floor(bps / STEP_BPS) * STEP_BPS))
}

function selectProduct(next: string): void {
  sku.value = next
  // Start at the exact list price (not the slider-snapped margin), so the first scenario
  // matches the list column; moving the slider switches to a margin.
  marginBps.value = null
}

watch(
  () => props.products,
  (list) => {
    if (sku.value && list.some((p) => p.sku === sku.value)) return
    const first = list.find((p) => p.available > 0) ?? list[0]
    if (first) selectProduct(first.sku)
    else sku.value = ''
  },
  { immediate: true }
)

const sliderValue = computed<number>({
  get: () => marginBps.value ?? snappedListBps(selected.value),
  set: (v) => {
    marginBps.value = Math.trunc(Number(v))
  }
})

const qtyNum = computed<number | null>(() => {
  const n = Math.trunc(Number(qty.value))
  return Number.isInteger(n) && n >= 1 && n <= MAX_QTY ? n : null
})

function useListPrice(): void {
  marginBps.value = null
}

function valid(r: PricePreview | null | undefined): r is PricePreview {
  return !!r && typeof r.unitPriceCents === 'number'
}

watch(
  [open, sku, marginBps, qtyNum],
  ([isOpen, s, m, q]) => {
    if (timer) clearTimeout(timer)
    const mine = ++seq
    if (!isOpen || !s || q === null) return
    timer = setTimeout(async () => {
      try {
        const [scen, base] = await Promise.all([props.preview(s, m, q), props.preview(s, null, q)])
        if (mine !== seq) return
        failed.value = false
        scenario.value = valid(scen) ? scen : null
        baseline.value = valid(base) ? base : null
      } catch {
        if (mine === seq) failed.value = true
      }
    }, 250)
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

const coversFee = computed(() => scenario.value?.coversFee !== false)

const comparison = computed(() => {
  const d = scenario.value?.differenceFromListCents ?? 0
  const abs = formatMoney(d).replace(/^-/, '')
  return d > 0 ? `${abs} above list` : d < 0 ? `${abs} below list` : 'same as list'
})

const marginLabel = computed(() =>
  marginBps.value === null ? `List price (${formatBps(selected.value?.listMarginBps)})` : formatBps(marginBps.value)
)
</script>

<template>
  <Card class="profit-sim" data-testid="profit-simulator">
    <template #header>
      <h2 class="sim-title">
        <button
          type="button"
          class="toggle"
          :aria-expanded="open ? 'true' : 'false'"
          :aria-controls="`${uid}-body`"
          data-testid="sim-toggle"
          @click="open = !open"
        >
          <span class="chev" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
          Profit simulator
        </button>
      </h2>
      <p class="sim-sub">See what you earn at different margins before you add an item. Nothing is saved.</p>
    </template>

    <div v-if="open" :id="`${uid}-body`" class="body">
      <p v-if="products.length === 0" class="muted">No products to simulate.</p>
      <template v-else>
        <div class="controls">
          <div class="field">
            <label :for="`${uid}-product`" class="label">Product</label>
            <select :id="`${uid}-product`" :value="sku" data-testid="sim-product" @change="selectProduct(($event.target as HTMLSelectElement).value)">
              <option v-for="p in products" :key="p.sku" :value="p.sku">{{ p.name }}{{ p.available > 0 ? '' : ' - Out of stock' }}</option>
            </select>
          </div>

          <div class="field">
            <span class="label-row">
              <label :for="`${uid}-margin`" class="label">Margin</label>
              <output :for="`${uid}-margin`" class="margin-value" data-testid="sim-margin-value">{{ marginLabel }}</output>
            </span>
            <input
              :id="`${uid}-margin`"
              v-model.number="sliderValue"
              type="range"
              min="0"
              :max="MAX_BPS"
              :step="STEP_BPS"
              :aria-valuetext="marginLabel"
              data-testid="sim-margin"
            />
            <UiButton size="sm" variant="link" class="list-btn" :disabled="marginBps === null" data-testid="sim-use-list" @click="useListPrice">
              Use list price
            </UiButton>
          </div>

          <div class="field">
            <span class="label" aria-hidden="true">Units per month</span>
            <QuantityStepper v-model="qty" label="Units per month" :min="1" :max="MAX_QTY" :invalid="qtyNum === null" data-testid="sim-qty" input-test-id="sim-qty-input" />
          </div>
        </div>

        <p v-if="failed" class="muted" role="status">Preview unavailable right now. Try again in a moment.</p>

        <template v-else-if="scenario">
          <div class="headline" aria-live="polite" data-testid="sim-headline">
            <p class="earn">
              <template v-if="coversFee">You earn <Money :cents="scenario.lineMarginCents" strong /> a month</template>
              <template v-else>This margin cannot be ordered</template>
            </p>
            <p class="per-unit">
              Patient pays <strong class="money">{{ formatMoney(scenario.unitPriceCents) }}</strong> per unit
              <span :class="['delta', { up: scenario.differenceFromListCents > 0, down: scenario.differenceFromListCents < 0 }]" data-testid="sim-diff">({{ comparison }})</span>
            </p>
          </div>

          <UiAlert v-if="!coversFee" tone="warning" data-testid="sim-fee-warning">
            This margin does not cover the 0.75% platform fee, so it cannot be ordered. Raise the margin.
          </UiAlert>

          <div class="table-wrap">
            <table class="table sim-table" data-testid="sim-table">
              <thead>
                <tr>
                  <th scope="col"><span class="sr-only">Figure</span></th>
                  <th scope="col" class="num">At list price</th>
                  <th scope="col" class="num">Your scenario</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Patient pays per unit</th>
                  <td class="num"><Money :cents="baseline?.unitPriceCents" /></td>
                  <td class="num" data-testid="sim-unit"><Money :cents="scenario.unitPriceCents" /></td>
                </tr>
                <tr>
                  <th scope="row">Patient pays per month</th>
                  <td class="num"><Money :cents="baseline?.lineTotalCents" /></td>
                  <td class="num" data-testid="sim-total"><Money :cents="scenario.lineTotalCents" /></td>
                </tr>
                <tr>
                  <th scope="row">
                    <span class="label-row">
                      Cerbo cost
                      <DemoBadge
                        label="Demo: COGS"
                        reason="COGS is Cerbo's wholesale cost, shown here only to make the economics demonstrable. A prescribing doctor would not normally see it."
                      />
                    </span>
                  </th>
                  <td class="num"><Money :cents="baseline?.lineCogsCents" /></td>
                  <td class="num" data-testid="sim-cogs"><Money :cents="scenario.lineCogsCents" /></td>
                </tr>
                <tr>
                  <th scope="row">Platform fee</th>
                  <td class="num"><Money :cents="baseline?.lineFeeCents" /></td>
                  <td class="num" data-testid="sim-fee"><Money :cents="coversFee ? scenario.lineFeeCents : null" /></td>
                </tr>
                <tr class="net">
                  <th scope="row">Your net per month</th>
                  <td class="num"><Money :cents="baseline?.lineMarginCents" strong /></td>
                  <td class="num" data-testid="sim-net"><Money :cents="coversFee ? scenario.lineMarginCents : null" strong /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <p class="small-print">
          Margin is set from Cerbo's cost and is before the 0.75% platform fee. Figures come from the same calculation the order uses.
        </p>
      </template>
    </div>
  </Card>
</template>

<style scoped>
.sim-title {
  margin: 0;
  font-size: var(--text-lg);
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
  min-height: 0;
  border: none;
  background: none;
  font: inherit;
  font-weight: 700;
  color: var(--text);
  cursor: pointer;
}
.chev {
  color: var(--muted);
  width: 1em;
}
.sim-sub {
  margin: var(--space-1) 0 0;
  color: var(--muted);
  font-size: var(--text-sm);
}
.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.controls {
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
  flex-wrap: wrap;
  gap: var(--space-2);
}
.margin-value {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
input[type='range'] {
  width: 100%;
  accent-color: var(--brand);
}
.list-btn {
  align-self: flex-start;
}
.field > :deep(.stepper) {
  align-self: flex-start;
}
.headline p {
  margin: 0;
}
.earn {
  font-size: var(--text-xl);
  font-weight: 700;
}
.per-unit {
  margin-top: var(--space-1) !important;
  font-size: var(--text-sm);
}
.delta {
  color: var(--muted);
}
.delta.up {
  color: var(--success);
}
.delta.down {
  color: var(--warning);
}
.sim-table {
  width: 100%;
}
.sim-table th[scope='row'] {
  font-weight: 500;
  text-align: left;
}
.sim-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.sim-table tr.net th {
  font-weight: 700;
}
.muted,
.small-print {
  margin: 0;
  color: var(--muted);
  font-size: var(--text-sm);
}
@media (max-width: 640px) {
  .controls {
    grid-template-columns: 1fr;
  }
}
</style>
