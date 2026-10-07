<script setup lang="ts">
// Shared marker for demonstration-only affordances (owner requirement).
//
// Some controls exist only to make the slice demonstrable - the role switcher stands in
// for real sign-in, the provider-visible pay link stands in for an email/SMS, admin
// "restock" stands in for procurement. Marking them keeps a reviewer from reading a
// deliberate demo affordance as a production design flaw.
//
// The badge is a real button: clicking it (mouse, keyboard or touch) reveals the
// `reason` as visible text, so the explanation is not hover-only. Use this component
// (or the bare `.demo-badge` class outside Vue) everywhere. `label` defaults to "Demo".
import { ref } from 'vue'

defineProps<{
  reason: string
  label?: string
}>()

const open = ref(false)
const id = `demo-${Math.random().toString(36).slice(2, 9)}`
</script>

<template>
  <span class="demo-badge-wrap">
    <button
      type="button"
      class="demo-badge"
      :aria-expanded="open"
      :aria-controls="id"
      :title="reason"
      @click="open = !open"
      @keydown.esc="open = false"
    >
      {{ label ?? 'Demo' }}
    </button>
    <span v-if="open" :id="id" class="demo-pop" role="note">
      <strong>Demonstration only.</strong> {{ reason }}
    </span>
  </span>
</template>

<style scoped>
.demo-badge-wrap {
  position: relative;
  display: inline-flex;
  vertical-align: middle;
}
button.demo-badge {
  min-height: 0;
  cursor: pointer;
  font-weight: 650;
}
button.demo-badge:hover:not(:disabled) {
  background: var(--demo-border);
}
.demo-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 30;
  width: min(18rem, 80vw);
  padding: var(--space-2) var(--space-3);
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--demo-border);
  border-left: 3px solid var(--demo);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lg);
  font-size: var(--text-sm);
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  white-space: normal;
  text-align: left;
}
</style>
