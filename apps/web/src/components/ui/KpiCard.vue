<script setup lang="ts">
// One key figure with a plain-language explanation underneath. Money only via <Money>.
import Money from './Money.vue'

defineProps<{ label: string; cents?: number | null; value?: string | number; hint?: string; primary?: boolean; loading?: boolean }>()
</script>

<template>
  <div class="kpi" :class="{ primary }">
    <span class="kpi-label">{{ label }}</span>
    <span class="kpi-value" :aria-busy="loading ? 'true' : undefined">
      <span v-if="loading" class="kpi-loading" aria-hidden="true" />
      <Money v-else-if="cents !== undefined" :cents="cents" />
      <template v-else>{{ value ?? '-' }}</template>
    </span>
    <span v-if="hint" class="kpi-hint">{{ hint }}</span>
  </div>
</template>

<style scoped>
.kpi {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-4) var(--space-5);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  min-width: 0;
}
.kpi.primary {
  border-color: var(--brand-border);
  background: var(--brand-tint);
}
.kpi-label {
  font-size: var(--text-xs);
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.kpi-value {
  font-size: var(--text-2xl);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  min-height: 2.2rem;
}
.primary .kpi-value {
  font-size: var(--text-3xl);
  color: var(--brand-strong);
}
.kpi-hint {
  font-size: var(--text-sm);
  color: var(--muted);
}
.kpi-loading {
  display: inline-block;
  width: 7rem;
  height: 1.6rem;
  border-radius: var(--radius-sm);
  background: var(--n-200);
}
</style>
