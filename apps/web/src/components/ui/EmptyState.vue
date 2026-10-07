<script setup lang="ts">
// Friendly empty state: what is missing and, optionally, the next action.
defineProps<{ title: string; message?: string }>()
</script>

<template>
  <div class="empty" role="status">
    <p class="empty-title">{{ title }}</p>
    <p v-if="message" class="empty-msg">{{ message }}</p>
    <div v-if="$slots.default" class="empty-action"><slot /></div>
  </div>
</template>

<style scoped>
.empty {
  text-align: center;
  padding: var(--space-8) var(--space-4);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface);
}
.empty-title {
  font-weight: 650;
  margin: 0 0 var(--space-1);
}
.empty-msg {
  color: var(--muted);
  margin: 0;
}
.empty-action {
  margin-top: var(--space-4);
  display: flex;
  justify-content: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
</style>
