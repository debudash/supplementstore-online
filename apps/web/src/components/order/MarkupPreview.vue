<script setup lang="ts">
// Live "what does the patient pay with this markup?" line (ADR-028). Asks the SERVER via
// the injected `preview` function (GET /api/products/:sku/price-preview) - the browser
// never computes a price. Debounced while typing; stale responses are ignored; the result
// is announced politely. Renders nothing until there is a valid markup and a product.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { PricePreview } from '@cerbo/contracts'
import { dollarsToCents } from './format'
import { formatMoney } from '../../utils/money'

/** Largest per-unit markup the server accepts: $1,000 (ADR-028). */
const MAX_MARKUP_CENTS = 100000

const props = defineProps<{
  sku: string | null
  markupInput: string
  preview?: (sku: string, markupCents: number) => Promise<PricePreview>
}>()

const result = ref<PricePreview | null>(null)
const failed = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null
let seq = 0

const markupCents = computed(() => {
  const raw = props.markupInput.trim()
  if (!raw) return null
  const v = dollarsToCents(raw)
  return v !== null && v <= MAX_MARKUP_CENTS ? v : null
})

watch(
  [() => props.sku, markupCents],
  ([sku, m]) => {
    if (timer) clearTimeout(timer)
    result.value = null
    failed.value = false
    if (!sku || m === null || !props.preview) return
    const mine = ++seq
    timer = setTimeout(async () => {
      try {
        const r = await props.preview!(sku, m)
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
</script>

<template>
  <p class="markup-preview" aria-live="polite" data-testid="markup-preview">
    <template v-if="result">
      Patient pays <strong class="money">{{ formatMoney(result.unitPriceCents) }}</strong> per unit
      <span class="parts">(cost {{ formatMoney(result.lineCogsCents) }} + your markup {{ formatMoney(result.lineMarginCents) }} + 0.75% fee)</span>
    </template>
    <template v-else-if="failed">Price preview unavailable - the price will show on the line after adding.</template>
  </p>
</template>

<style scoped>
.markup-preview {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  color: var(--text);
  min-height: 1.3em;
}
.markup-preview:empty {
  display: none;
}
.parts {
  color: var(--muted);
}
</style>
