<script setup lang="ts">
// Accessible tabs (WAI-ARIA tabs pattern): roving tabindex, Left/Right/Home/End keys.
// Panels come from named slots matching each tab id: <template #ledger>...</template>.
import { nextTick, ref } from 'vue'

const props = defineProps<{ tabs: Array<{ id: string; label: string; badge?: string | number }>; modelValue: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', id: string): void }>()

const buttons = ref<HTMLButtonElement[]>([])
const uid = Math.random().toString(36).slice(2, 8)

async function select(i: number): Promise<void> {
  const tab = props.tabs[(i + props.tabs.length) % props.tabs.length]
  emit('update:modelValue', tab.id)
  await nextTick()
  buttons.value[props.tabs.indexOf(tab)]?.focus()
}

function onKey(e: KeyboardEvent, i: number): void {
  if (e.key === 'ArrowRight') select(i + 1)
  else if (e.key === 'ArrowLeft') select(i - 1)
  else if (e.key === 'Home') select(0)
  else if (e.key === 'End') select(props.tabs.length - 1)
  else return
  e.preventDefault()
}
</script>

<template>
  <div class="tabs">
    <div class="tablist" role="tablist">
      <button
        v-for="(t, i) in tabs"
        :id="`tab-${uid}-${t.id}`"
        :key="t.id"
        ref="buttons"
        type="button"
        role="tab"
        class="tab"
        :class="{ active: t.id === modelValue }"
        :aria-selected="t.id === modelValue"
        :aria-controls="`panel-${uid}-${t.id}`"
        :tabindex="t.id === modelValue ? 0 : -1"
        :data-testid="`tab-${t.id}`"
        @click="select(i)"
        @keydown="onKey($event, i)"
      >
        {{ t.label }}<span v-if="t.badge !== undefined" class="tab-badge">{{ t.badge }}</span>
      </button>
    </div>
    <template v-for="t in tabs" :key="t.id">
      <div
        v-if="t.id === modelValue"
        :id="`panel-${uid}-${t.id}`"
        class="panel"
        role="tabpanel"
        :aria-labelledby="`tab-${uid}-${t.id}`"
        tabindex="0"
      >
        <slot :name="t.id" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.tablist {
  display: flex;
  gap: var(--space-1);
  overflow-x: auto;
  border-bottom: 1px solid var(--border-strong);
  margin-bottom: var(--space-4);
}
.tab {
  border: none;
  border-bottom: 3px solid transparent;
  border-radius: 0;
  background: none;
  color: var(--muted);
  padding: var(--space-2) var(--space-3);
  white-space: nowrap;
}
.tab:hover:not(:disabled) {
  background: var(--n-100);
  color: var(--text);
}
.tab.active {
  color: var(--brand-strong);
  border-bottom-color: var(--brand);
  font-weight: 650;
}
.tab-badge {
  margin-left: var(--space-2);
  padding: 0 0.4rem;
  border-radius: 999px;
  background: var(--n-200);
  color: var(--n-700);
  font-size: var(--text-xs);
}
.panel:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--radius-sm);
}
</style>
