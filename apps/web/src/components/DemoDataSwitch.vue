<script setup lang="ts">
// "Include demo data" switch for reports. Synthetic rows (Reset demo story) are excluded
// from reporting by default (EVAL-13); this mixes them in to show the demo narrative.
import DemoBadge from './DemoBadge.vue'

const model = defineModel<boolean>({ required: true })
defineProps<{ testId?: string }>()
</script>

<template>
  <div class="demo-switch" :class="{ on: model }">
    <label class="switch-label">
      <input v-model="model" type="checkbox" role="switch" class="switch" :data-testid="testId ?? 'include-synthetic'" />
      <span class="switch-text">
        <strong>Include demo data</strong>
        <span class="subtle">{{ model ? 'On - demo orders are mixed in' : 'Off - real orders only (default)' }}</span>
      </span>
    </label>
    <DemoBadge reason="Demo affordance - demo orders from Reset demo story are excluded from reports by default. This switch mixes them in to show the demo narrative; real reporting runs with it off." />
  </div>
</template>

<style scoped>
.demo-switch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 2px solid var(--demo-border);
  border-radius: var(--radius);
}
.demo-switch.on {
  background: var(--demo-tint);
  border-color: var(--demo);
}
.switch-label {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  cursor: pointer;
  flex: 1 1 14rem;
}
.switch-text {
  display: flex;
  flex-direction: column;
}
.switch-text .subtle {
  font-size: var(--text-sm);
}
input.switch {
  appearance: none;
  flex: none;
  position: relative;
  width: 3rem;
  height: 1.6rem;
  border-radius: 999px;
  border: 2px solid var(--border-strong);
  background: var(--n-200);
  cursor: pointer;
  transition: background-color 0.15s ease;
}
input.switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 1.1rem;
  height: 1.1rem;
  border-radius: 50%;
  background: #fff;
  box-shadow: var(--shadow-sm);
  transition: transform 0.15s ease;
}
input.switch:checked {
  background: var(--demo);
  border-color: var(--demo);
}
input.switch:checked::after {
  transform: translateX(1.4rem);
}
input.switch:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
</style>
