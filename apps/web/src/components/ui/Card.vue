<script setup lang="ts">
// Surface container with an optional titled header and header actions.
defineProps<{ title?: string; subtitle?: string; tone?: 'default' | 'warning' | 'danger' | 'success' | 'demo' }>()
</script>

<template>
  <section class="card" :class="tone ? `card-${tone}` : ''">
    <header v-if="title || $slots.header || $slots.actions" class="card-head">
      <div>
        <h2 v-if="title" class="card-title">{{ title }}</h2>
        <slot name="header" />
        <p v-if="subtitle" class="card-sub">{{ subtitle }}</p>
      </div>
      <div v-if="$slots.actions" class="card-actions"><slot name="actions" /></div>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  padding: var(--space-5);
  min-width: 0;
}
.card-warning {
  border-color: var(--warning-border);
  border-left: 4px solid var(--warning);
}
.card-danger {
  border-color: var(--danger-border);
  border-left: 4px solid var(--danger);
}
.card-success {
  border-color: var(--success-border);
  border-left: 4px solid var(--success);
}
.card-demo {
  border-color: var(--demo-border);
  border-left: 4px solid var(--demo);
}
.card-head {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: var(--space-4);
}
.card-title {
  font-size: var(--text-lg);
  margin: 0;
}
.card-sub {
  margin: var(--space-1) 0 0;
  color: var(--muted);
  font-size: var(--text-sm);
}
.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
@media (max-width: 640px) {
  .card {
    padding: var(--space-4);
  }
}
</style>
