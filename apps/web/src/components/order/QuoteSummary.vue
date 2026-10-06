<script setup lang="ts">
// Order-level live quote (FR-2 AC2): subtotal (price), COGS, platform fee, net margin.
// Every figure comes from the server quote endpoint; this component only formats.
import { computed } from 'vue'
import type { OrderTotals } from '@cerbo/contracts'
import { formatCents } from './format'

const props = defineProps<{ totals: OrderTotals | null }>()

const feePercentLabel = computed(() => {
  if (!props.totals) return ''
  // feeBps is an integer basis-point rate, not a money value; this is label text only.
  const bps = props.totals.feeBps
  const whole = Math.trunc(bps / 100)
  const frac = bps % 100
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, '0')}%`
})
</script>

<template>
  <section class="quote-summary" aria-label="Order quote">
    <h3>Quote</h3>
    <dl v-if="totals">
      <div class="row">
        <dt>Subtotal (price)</dt>
        <dd data-test="subtotal">{{ formatCents(totals.subtotalCents) }}</dd>
      </div>
      <div class="row">
        <dt>COGS</dt>
        <dd data-test="cogs">{{ formatCents(totals.cogsCents) }}</dd>
      </div>
      <div class="row">
        <dt>Platform fee ({{ feePercentLabel }})</dt>
        <dd data-test="fee">{{ formatCents(totals.feeCents) }}</dd>
      </div>
      <div class="row total">
        <dt>Net margin</dt>
        <dd data-test="margin">{{ formatCents(totals.marginCents) }}</dd>
      </div>
    </dl>
    <p v-else class="empty">Add a line to see the quote.</p>
  </section>
</template>

<style scoped>
.quote-summary {
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 0.75rem 1rem;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 2rem;
  padding: 0.15rem 0;
}
.row.total {
  border-top: 1px solid #ddd;
  margin-top: 0.3rem;
  padding-top: 0.4rem;
  font-weight: 600;
}
dl {
  margin: 0;
}
dt {
  color: #444;
}
dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.empty {
  color: #666;
}
</style>
