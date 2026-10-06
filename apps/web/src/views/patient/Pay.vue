<script setup lang="ts">
import { useRoute } from 'vue-router'
import Placeholder from '../../components/Placeholder.vue'

const route = useRoute()
</script>

<template>
  <Placeholder
    title="Pay"
    :note="`Patient pay page for token ${route.params.token} (FR-5). Implemented by T7.`"
  />
</template>
