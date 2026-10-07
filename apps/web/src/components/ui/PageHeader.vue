<script setup lang="ts">
// Page title block: one h1 per page, optional subtitle, a back slot and an actions slot.
// Also keeps the browser tab title in sync. Deliberately avoids RouterLink so views
// that are tested with a minimal vue-router mock can still use it (pass links via slot).
import { watchEffect } from 'vue'

const props = defineProps<{ title: string; subtitle?: string }>()

watchEffect(() => {
  if (typeof document !== 'undefined') document.title = `${props.title} - Cerbo`
})
</script>

<template>
  <header class="page-header">
    <div v-if="$slots.back" class="back"><slot name="back" /></div>
    <div class="title-row">
      <div class="titles">
        <h1>{{ title }}</h1>
        <p v-if="subtitle || $slots.subtitle" class="subtitle"><slot name="subtitle">{{ subtitle }}</slot></p>
      </div>
      <div v-if="$slots.actions" class="actions"><slot name="actions" /></div>
    </div>
  </header>
</template>

<style scoped>
.page-header {
  margin-bottom: var(--space-6);
}
.back {
  margin-bottom: var(--space-2);
  font-size: var(--text-sm);
}
.title-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-6);
  align-items: flex-end;
  justify-content: space-between;
}
h1 {
  margin: 0;
}
.subtitle {
  margin: var(--space-1) 0 0;
  color: var(--muted);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}
</style>
