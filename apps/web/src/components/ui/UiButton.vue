<script setup lang="ts">
// Button with variants and a busy state. While busy it is disabled, shows a spinner and
// `busyLabel`, and sets aria-busy so assistive tech knows work is in progress.
withDefaults(
  defineProps<{ variant?: 'primary' | 'secondary' | 'danger' | 'danger-quiet' | 'link'; busy?: boolean; busyLabel?: string; disabled?: boolean; type?: 'button' | 'submit'; size?: 'sm' | 'md'; block?: boolean }>(),
  { variant: 'secondary', type: 'button', size: 'md' }
)
</script>

<template>
  <button
    :type="type"
    :class="[
      variant === 'primary' && 'btn-primary',
      variant === 'danger' && 'btn-danger',
      variant === 'danger-quiet' && 'btn-danger-quiet',
      variant === 'link' && 'btn-link',
      size === 'sm' && 'btn-sm',
      block && 'btn-block'
    ]"
    :disabled="disabled || busy"
    :aria-busy="busy ? 'true' : undefined"
  >
    <span v-if="busy" class="spinner" aria-hidden="true" />
    <template v-if="busy && busyLabel">{{ busyLabel }}</template>
    <slot v-else />
  </button>
</template>

<style scoped>
.spinner {
  width: 0.9em;
  height: 0.9em;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
