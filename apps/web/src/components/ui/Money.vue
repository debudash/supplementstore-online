<script setup lang="ts">
// Display an integer-cents amount. Formatting only (utils/money.ts) - never arithmetic.
// Negative amounts get the danger colour AND keep the leading minus, so the sign is
// never carried by colour alone.
import { computed } from 'vue'
import { formatMoney, isNegative } from '../../utils/money'

const props = defineProps<{ cents: number | null | undefined; strong?: boolean }>()
const negative = computed(() => isNegative(props.cents))
</script>

<template>
  <span class="money" :class="{ 'money-negative': negative, 'money-strong': strong }">{{ formatMoney(cents) }}</span>
</template>

<style scoped>
.money-strong {
  font-weight: 700;
}
</style>
