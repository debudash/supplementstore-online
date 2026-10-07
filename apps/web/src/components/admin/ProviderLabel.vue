<script setup lang="ts">
// Provider identity for admin tables: the name (and practice) to read, plus the FULL id to
// match against logs, the database or support tickets. Ids are never truncated, because
// demo and seeded ids can share long prefixes (e.g. aaaaaaaa-0000-...-01 vs -02).
defineProps<{ id: string; name?: string | null; practice?: string | null }>()
</script>

<template>
  <span class="provider-label">
    <strong v-if="name" class="name">{{ name }}</strong>
    <span v-if="name && practice" class="practice">{{ practice }}</span>
    <code class="pid" :title="`Provider ID ${id}`"><span class="sr-only">Provider ID </span>{{ id }}</code>
  </span>
</template>

<style scoped>
.provider-label {
  display: inline-flex;
  flex-direction: column;
  gap: 0.1rem;
  line-height: 1.3;
  min-width: 0;
}
.name {
  color: var(--text);
}
.practice {
  font-size: var(--text-sm);
  color: var(--muted);
}
.pid {
  font-size: var(--text-xs);
  padding: 0 0.25rem;
  width: fit-content;
  max-width: 100%;
  user-select: all;
}
</style>
