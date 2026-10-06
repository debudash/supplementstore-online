<script setup lang="ts">
import { useRoute } from 'vue-router'
import Placeholder from '../../components/Placeholder.vue'

const route = useRoute()
</script>

<template>
  <Placeholder
    title="Order Audit"
    :note="`Audit view for order ${route.params.id} (FR-7). Implemented by T6.`"
  />
</template>
