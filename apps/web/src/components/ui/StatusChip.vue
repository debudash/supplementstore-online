<script setup lang="ts">
// Human-readable status chip for orders, schedules and recurring cycles. Colour reflects
// the state, and the label always says it in words (never colour alone).
import { computed } from 'vue'

const props = defineProps<{ status: string }>()

const MAP: Record<string, { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  sent: { label: 'Sent', tone: 'info' },
  paid: { label: 'Paid', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'danger' },
  refunded: { label: 'Refunded', tone: 'warning' },
  on_hold: { label: 'On hold', tone: 'warning' },
  active: { label: 'Active', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  fulfilled: { label: 'Fulfilled', tone: 'success' }
}

const view = computed(
  () => MAP[props.status] ?? { label: props.status.replace(/_/g, ' '), tone: 'neutral' }
)
</script>

<template>
  <span class="badge" :class="`badge-${view.tone}`" :data-status="status">{{ view.label }}</span>
</template>
