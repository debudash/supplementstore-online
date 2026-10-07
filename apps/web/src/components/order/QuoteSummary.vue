<script setup lang="ts">
// Order-level live quote (FR-2 AC2): patient price (subtotal), COGS, platform fee, net
// margin. Every figure comes from the server quote endpoint; this component only formats.
// Net margin is green when positive and red, labelled, when negative.
import type { OrderTotals } from '@cerbo/contracts'
import { formatCents } from './format'
import { formatBps, isNegative } from '../../utils/money'
import DemoBadge from '../DemoBadge.vue'

defineProps<{ totals: OrderTotals | null; itemCount?: number }>()
</script>

<template>
  <section class="quote-summary" aria-labelledby="quote-title">
    <h2 id="quote-title" class="title">Order summary</h2>
    <dl v-if="totals && itemCount !== 0">
      <div class="row big">
        <dt>Patient pays</dt>
        <dd class="money" data-test="subtotal">{{ formatCents(totals.subtotalCents) }}</dd>
      </div>
      <div class="row">
        <dt class="label-row">Cerbo cost (COGS) <DemoBadge reason="COGS is Cerbo's wholesale cost. A prescribing doctor would not normally see it; shown here to make the order economics demonstrable." /></dt>
        <dd class="money" data-test="cogs">{{ formatCents(totals.cogsCents) }}</dd>
      </div>
      <div class="row">
        <dt>Platform fee ({{ formatBps(totals.feeBps) }})</dt>
        <dd class="money" data-test="fee">{{ formatCents(totals.feeCents) }}</dd>
      </div>
      <div class="row total" :class="{ negative: isNegative(totals.marginCents) }">
        <dt>Your net margin<span v-if="isNegative(totals.marginCents)" class="neg-tag"> - negative</span></dt>
        <dd class="money" data-test="margin">{{ formatCents(totals.marginCents) }}</dd>
      </div>
    </dl>
    <p v-else class="empty">Add an item to see the totals.</p>
    <slot />
  </section>
</template>

<style scoped>
.quote-summary {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  padding: var(--space-5);
}
.title {
  font-size: var(--text-lg);
  margin: 0 0 var(--space-3);
}
dl {
  margin: 0;
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-4);
  padding: var(--space-2) 0;
  font-size: var(--text-sm);
}
.row.big {
  font-size: var(--text-lg);
  font-weight: 700;
  border-bottom: 1px solid var(--border);
  padding-bottom: var(--space-3);
  margin-bottom: var(--space-1);
}
dt {
  color: var(--muted);
}
.big dt {
  color: var(--text);
}
.label-row {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
dd {
  margin: 0;
  text-align: right;
}
.row.total {
  border-top: 1px solid var(--border-strong);
  margin-top: var(--space-1);
  padding-top: var(--space-3);
  font-weight: 700;
  font-size: var(--text-md);
}
.row.total dt {
  color: var(--text);
}
.row.total dd {
  color: var(--success);
}
.row.total.negative dd,
.neg-tag {
  color: var(--danger);
}
.empty {
  color: var(--muted);
  margin: 0;
}
</style>
