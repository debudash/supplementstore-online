<script setup lang="ts">
// Top bar: role switcher + role-filtered tabs (docs/ARCHITECTURE.md section 11).
import { computed, onMounted, ref } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import RoleSwitcher from './components/RoleSwitcher.vue'
import { currentUser } from './api/session'
import { routes } from './router'
import { getHealth } from './api/client'

const role = computed(() => currentUser()?.role)

const tabs = computed(() =>
  routes
    .filter((r) => r.meta?.tab && role.value && r.meta.roles?.includes(role.value))
    .map((r) => ({ path: r.path, label: r.meta!.tab as string }))
)

const health = ref<string>('checking...')
onMounted(async () => {
  try {
    const h = await getHealth()
    health.value = h.db.connected ? 'db: connected' : 'db: down'
  } catch {
    health.value = 'api: unreachable'
  }
})
</script>

<template>
  <header class="topbar">
    <strong class="brand">Cerbo Supplement Store</strong>
    <nav class="tabs">
      <RouterLink v-for="t in tabs" :key="t.path" :to="t.path">{{ t.label }}</RouterLink>
    </nav>
    <span class="spacer" />
    <small class="health">{{ health }}</small>
    <RoleSwitcher />
  </header>
  <main class="content">
    <RouterView />
  </main>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #ddd;
}
.tabs {
  display: flex;
  gap: 0.75rem;
}
.tabs a.router-link-active {
  font-weight: 600;
  text-decoration: underline;
}
.spacer {
  flex: 1;
}
.health {
  color: #666;
}
.content {
  padding: 1rem;
}
</style>
