<script setup lang="ts">
// Live "what price does this margin give?" line (ADR-025). Asks the SERVER via the
// injected `preview` function (GET /api/products/:sku/price-preview) - the browser never
// computes a price. Debounced while typing; stale responses are ignored; the result is
// announced politely. Renders nothing until there is a valid margin and a product.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { PricePreview } from '@cerbo/contracts'
import { marginPercentToBps } from './format'
import { formatMoney } from '../../utils/money'

const props = defineProps<{
  sku: string | null
  marginInput: string
  preview?: (sku: string, marginBps: number) => Promise<PricePreview>
}>()

const result = ref<PricePreview | null>(null)
const failed = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null
let seq = 0

const bps = computed(() => {
  const raw = props.marginInput.trim()
  if (!raw) return null
  const v = marginPercentToBps(raw)
  return v !== null && v <= 9500 ? v : null
})

watch(
  [() => props.sku, bps],
  ([sku, b]) => {
    if (timer) clearTimeout(timer)
    result.value = null
    failed.value = false
    if (!sku || b === null || !props.preview) return
    const mine = ++seq
    timer = setTimeout(async () => {
      try {
        const r = await props.preview!(sku, b)
        if (mine === seq && typeof r?.unitPriceCents === 'number') result.value = r
      } catch {
        if (mine === seq) failed.value = true
      }
    }, 300)
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

const comparison = computed(() => {
  const d = result.value?.differenceFromListCents ?? 0
  const abs = formatMoney(d).replace(/^-/, '')
  return d > 0 ? `${abs} above list` : d < 0 ? `${abs} below list` : 'same as list'
})
</script>

<template>
  <p class="margin-preview" aria-live="polite" data-testid="margin-preview">
    <template v-if="result">
      At {{ marginInput.trim() }}%: <strong class="money">{{ formatMoney(result.unitPriceCents) }}</strong> per unit
      <span :class="['delta', { up: result.differenceFromListCents > 0, down: result.differenceFromListCents < 0 }]">({{ comparison }})</span>
    </template>
    <template v-else-if="failed">Price preview unavailable - the price will show on the line after adding.</template>
  </p>
</template>

<style scoped>
.margin-preview {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  color: var(--text);
  min-height: 1.3em;
}
.margin-preview:empty {
  display: none;
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
</style>
