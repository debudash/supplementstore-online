<script setup lang="ts">
// Shared marker for demonstration-only affordances (owner requirement).
//
// Many controls in this build exist to make the slice demonstrable - the role switcher
// stands in for real authentication, the provider-visible pay link stands in for an
// email/SMS to the patient, admin "run job" and "restock" controls stand in for real
// schedulers and procurement. Marking them keeps a reviewer from reading a deliberate
// demo affordance as a production design flaw.
//
// Use ONE convention everywhere: this component (or the bare `.demo-badge` class for
// non-Vue contexts). `reason` is a short, honest sentence shown as a tooltip explaining
// what the real system would do instead. `label` defaults to "Demo".
defineProps<{
  reason: string
  label?: string
}>()
</script>

<template>
  <span class="demo-badge" :title="reason" :aria-label="`Demonstration only. ${reason}`" role="note">
    {{ label ?? 'Demo' }}
  </span>
</template>
