<script setup lang="ts">
// Quantity input with - / + buttons. The centre field is a real number input (so it can
// be typed, and keyboard Up/Down work natively); the buttons clamp to [min, max].
// `inputTestId` is forwarded to the input as data-test so existing tests keep working.
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{ modelValue: number | string; min?: number; max?: number; label: string; disabled?: boolean; inputTestId?: string; invalid?: boolean; describedby?: string }>(),
  { min: 1, max: 100 }
)
const emit = defineEmits<{ (e: 'update:modelValue', v: number | string): void; (e: 'enter'): void }>()

const n = computed(() => Math.trunc(Number(props.modelValue)))
const canDec = computed(() => !props.disabled && Number.isFinite(n.value) && n.value > props.min)
const canInc = computed(() => !props.disabled && (!Number.isFinite(n.value) || n.value < props.max))

function step(delta: number): void {
  const base = Number.isFinite(n.value) ? n.value : props.min
  emit('update:modelValue', Math.min(props.max, Math.max(props.min, base + delta)))
}
</script>

<template>
  <div class="stepper" :class="{ invalid }">
    <button type="button" class="step" :disabled="!canDec" :aria-label="`Decrease ${label}`" data-testid="qty-dec" @click="step(-1)">−</button>
    <input
      :value="modelValue"
      type="number"
      inputmode="numeric"
      :min="min"
      :max="max"
      step="1"
      :aria-label="label"
      :aria-invalid="invalid ? 'true' : undefined"
      :aria-describedby="describedby"
      :disabled="disabled"
      :data-test="inputTestId"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter.prevent="emit('enter')"
    />
    <button type="button" class="step" :disabled="!canInc" :aria-label="`Increase ${label}`" data-testid="qty-inc" @click="step(1)">+</button>
  </div>
</template>

<style scoped>
.stepper {
  display: inline-flex;
  align-items: stretch;
  border: 1px solid var(--border-input);
  border-radius: var(--radius-sm);
  background: var(--surface);
  overflow: hidden;
}
.stepper:focus-within {
  border-color: var(--brand);
  box-shadow: var(--focus-ring);
}
.stepper.invalid {
  border-color: var(--danger);
}
.step {
  border: none;
  border-radius: 0;
  min-width: 2.25rem;
  padding: 0 var(--space-2);
  font-size: var(--text-lg);
  background: var(--surface-2);
}
.step:focus-visible {
  box-shadow: inset var(--focus-ring);
}
input {
  width: 3rem;
  border: none;
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
  border-radius: 0;
  text-align: center;
  font-variant-numeric: tabular-nums;
  -moz-appearance: textfield;
}
input:focus-visible {
  box-shadow: none;
}
input::-webkit-outer-spin-button,
input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
</style>
