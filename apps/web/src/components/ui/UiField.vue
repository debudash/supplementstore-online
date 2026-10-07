<script setup lang="ts">
// Labelled form field wrapper: label, optional hint and error, all wired by id. The
// control goes in the default slot and receives { id, describedby, invalid } so it can
// bind them: <UiField label="Patient" v-slot="f"><select :id="f.id" ...></UiField>
import { computed } from 'vue'

const props = defineProps<{ label: string; hint?: string; error?: string | null; optional?: boolean; inline?: boolean }>()
const id = `f-${Math.random().toString(36).slice(2, 9)}`
const describedby = computed(
  () => [props.hint ? `${id}-hint` : '', props.error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined
)
</script>

<template>
  <div class="field" :class="{ inline }">
    <label :for="id" class="field-label">
      {{ label }}<span v-if="optional" class="opt"> (optional)</span>
    </label>
    <slot :id="id" :describedby="describedby" :invalid="!!error" />
    <span v-if="hint" :id="`${id}-hint`" class="field-hint"><slot name="hint">{{ hint }}</slot></span>
    <span v-if="error" :id="`${id}-err`" class="field-error">{{ error }}</span>
  </div>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.field-label {
  font-size: var(--text-sm);
  font-weight: 600;
}
.opt {
  font-weight: 400;
  color: var(--muted);
}
.field-hint {
  font-size: var(--text-sm);
  color: var(--muted);
}
.field-error {
  font-size: var(--text-sm);
  color: var(--danger);
  font-weight: 550;
}
</style>
