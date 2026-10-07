<script setup lang="ts">
// Renders the global toasts in a polite live region (bottom-right; full width on phones).
import { toasts, dismissToast } from './toast'
</script>

<template>
  <div class="toast-host" role="status" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="`toast-${t.tone}`" data-testid="toast">
      <span>{{ t.message }}</span>
      <button type="button" class="btn-link close" :aria-label="`Dismiss: ${t.message}`" @click="dismissToast(t.id)">×</button>
    </div>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  right: var(--space-4);
  bottom: var(--space-4);
  z-index: 90;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: min(24rem, calc(100vw - 2rem));
}
.toast {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  background: var(--n-900);
  color: #fff;
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  border-left: 4px solid var(--brand);
  font-size: var(--text-sm);
}
.toast-success {
  border-left-color: #4cc27a;
}
.toast-warning {
  border-left-color: #f0b44c;
}
.toast-danger {
  border-left-color: #f2766b;
}
.close {
  color: #fff;
  text-decoration: none;
  font-size: var(--text-lg);
  line-height: 1;
}
.close:hover:not(:disabled) {
  color: #fff;
}
</style>
