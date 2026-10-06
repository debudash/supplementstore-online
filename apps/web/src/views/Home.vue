<script setup lang="ts">
import { computed } from 'vue'
import { currentUser } from '../api/session'
import Placeholder from '../components/Placeholder.vue'

const role = computed(() => currentUser()?.role ?? 'unknown')
</script>

<template>
  <Placeholder
    title="Cerbo Supplement Store"
    :note="`Signed in as ${role}. Pick a tab above. Patients reach their pay page by link.`"
  />
</template>
