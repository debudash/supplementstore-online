<script setup lang="ts">
// DEMO extension (ADR-029): one read-only block on the order builder listing supplement
// suggestions from the patient's latest SIMULATED lab panel. No actions, nothing stored,
// provider-only (never on patient pages). Updates live as items are added or removed.
import { computed } from 'vue'
import { labSuggestions } from '../../demo/labSuggestions'

const props = defineProps<{
  patientId: string | null
  patientFirstName: string | null
  onOrderSkus: ReadonlySet<string>
  products: ReadonlyArray<{ sku: string; name: string; available: number }>
}>()

const view = computed(() => labSuggestions(props.patientId, props.onOrderSkus, props.products))

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "2026-09-28" -> "Sep 28, 2026" (a calendar date, no timezone shift). */
const collected = computed(() => {
  const d = view.value?.collectedOn
  if (!d) return ''
  const [y, m, day] = d.split('-')
  return `${MONTHS[Number(m) - 1]} ${Number(day)}, ${y}`
})
</script>

<template>
  <section class="lab" aria-labelledby="lab-title" data-testid="lab-suggestions">
    <div class="head">
      <h2 id="lab-title" class="title">
        Suggestions from {{ patientFirstName ? `${patientFirstName}'s` : 'the patient\'s' }} latest labs
      </h2>
      <span class="demo">DEMO - simulated labs</span>
      <span v-if="view" class="date">Panel collected {{ collected }}</span>
    </div>

    <p v-if="!view" class="empty" data-testid="lab-none">No recent lab results on file (DEMO).</p>
    <template v-else>
      <ul v-if="view.suggestions.length" class="list">
        <li v-for="s in view.suggestions" :key="s.sku" data-testid="lab-suggestion">
          <strong>{{ s.productName }}</strong> - {{ s.marker }} {{ s.result }}, low ({{ s.range }}).
          <template v-if="s.note">{{ ' ' + s.note }}</template>
          <span v-if="s.onOrder" class="on-order"> Already on this order.</span>
          <span v-else-if="s.outOfStock" class="oos"> Currently out of stock.</span>
        </li>
      </ul>
      <p v-else class="empty">No low results in the latest panel.</p>
      <p class="foot">
        <template v-if="view.normal.length">Normal results in this panel: {{ view.normal.join(', ') }}. </template>
        Decision support for the provider only; not shown to the patient. The provider decides what to prescribe.
      </p>
    </template>
  </section>
</template>

<style scoped>
.lab {
  background: var(--surface);
  border: 1px solid var(--demo-border);
  border-radius: var(--radius-lg);
  padding: var(--space-4) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}
.title {
  margin: 0;
  font-size: var(--text-lg);
}
.demo {
  padding: 0.1rem 0.6rem;
  border-radius: 999px;
  background: var(--demo-tint);
  border: 1px solid var(--demo-border);
  color: var(--demo);
  font-size: var(--text-xs);
  font-weight: 700;
}
.date {
  color: var(--muted);
  font-size: var(--text-sm);
}
.list {
  margin: 0;
  padding-left: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.on-order {
  color: var(--success);
  font-weight: 600;
}
.oos {
  color: var(--danger);
  font-weight: 600;
}
.empty {
  margin: 0;
  color: var(--muted);
}
.foot {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--muted);
}
</style>
