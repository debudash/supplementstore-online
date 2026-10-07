<script setup lang="ts">
// Loading placeholder. Announces "Loading" once to screen readers; the bars are hidden.
withDefaults(defineProps<{ lines?: number; height?: string; label?: string }>(), {
  lines: 3,
  height: '1rem',
  label: 'Loading'
})
</script>

<template>
  <div class="skeleton" role="status" aria-live="polite">
    <span class="sr-only">{{ label }}...</span>
    <span v-for="i in lines" :key="i" class="bar" :style="{ height, width: i === lines && lines > 1 ? '60%' : '100%' }" aria-hidden="true" />
  </div>
</template>

<style scoped>
.skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.bar {
  display: block;
  border-radius: var(--radius-sm);
  background: linear-gradient(90deg, var(--n-100), var(--n-200), var(--n-100));
  background-size: 200% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
}
@keyframes shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}
</style>
