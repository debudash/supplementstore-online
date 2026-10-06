<script setup lang="ts">
import { useRoute } from 'vue-router'
import Placeholder from '../../components/Placeholder.vue'

const route = useRoute()
</script>

<template>
  <Placeholder
    title="Authorize Recurring"
    :note="`Schedule authorization for token ${route.params.token} (FR-12 AC2). Implemented by T7.`"
  />
</template>
