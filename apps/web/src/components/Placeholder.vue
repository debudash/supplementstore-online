<script setup lang="ts">
// Placeholder view used by the T0 shell. Each real view file replaces this
// content in its own task; the route stays pre-registered in router.ts.
defineProps<{ title: string; note?: string }>()
</script>

<template>
  <section class="placeholder">
    <h2>{{ title }}</h2>
    <p>{{ note ?? 'This view is pre-registered and will be implemented in a later task.' }}</p>
  </section>
</template>

<style scoped>
.placeholder {
  padding: 1.5rem;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--muted);
  max-width: 720px;
}
.placeholder h2 {
  color: var(--text);
  margin-top: 0;
}
</style>
