<script setup lang="ts">
// Inline alert. Danger alerts use role="alert" (assertive); the rest use role="status"
// (polite), so screen readers announce them without stealing focus.
defineProps<{ tone?: 'info' | 'success' | 'warning' | 'danger'; title?: string }>()
</script>

<template>
  <div
    class="alert"
    :class="`alert-${tone ?? 'info'}`"
    :role="tone === 'danger' ? 'alert' : 'status'"
    :aria-live="tone === 'danger' ? 'assertive' : 'polite'"
  >
    <span class="alert-icon" aria-hidden="true">{{ tone === 'danger' ? '!' : tone === 'success' ? '✓' : tone === 'warning' ? '!' : 'i' }}</span>
    <div class="alert-body">
      <strong v-if="title" class="alert-title">{{ title }}</strong>
      <slot />
      <div v-if="$slots.actions" class="alert-actions"><slot name="actions" /></div>
    </div>
  </div>
</template>

<style scoped>
.alert {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  padding: var(--space-3) var(--space-4);
  border: 1px solid;
  border-left-width: 4px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}
.alert-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 50%;
  font-size: var(--text-xs);
  font-weight: 800;
  color: #fff;
  margin-top: 0.1rem;
}
.alert-body {
  min-width: 0;
}
.alert-title {
  display: block;
  margin-bottom: var(--space-1);
}
.alert-actions {
  margin-top: var(--space-2);
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.alert-info {
  background: var(--info-tint);
  border-color: var(--info-border);
  border-left-color: var(--info);
  color: var(--brand-strong);
}
.alert-info .alert-icon {
  background: var(--info);
}
.alert-success {
  background: var(--success-tint);
  border-color: var(--success-border);
  border-left-color: var(--success);
  color: var(--success);
}
.alert-success .alert-icon {
  background: var(--success);
}
.alert-warning {
  background: var(--warning-tint);
  border-color: var(--warning-border);
  border-left-color: var(--warning);
  color: var(--warning);
}
.alert-warning .alert-icon {
  background: var(--warning);
}
.alert-danger {
  background: var(--danger-tint);
  border-color: var(--danger-border);
  border-left-color: var(--danger);
  color: var(--danger-strong);
}
.alert-danger .alert-icon {
  background: var(--danger);
}
</style>
