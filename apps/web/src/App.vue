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
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">C</span>
      <span class="brand-name">Cerbo Supplement Store</span>
    </div>
    <nav class="tabs" aria-label="Primary">
      <RouterLink v-for="t in tabs" :key="t.path" :to="t.path">{{ t.label }}</RouterLink>
    </nav>
    <span class="spacer" />
    <span class="health" :class="{ ok: health === 'db: connected' }">
      <span class="dot" aria-hidden="true" />
      <small>{{ health }}</small>
    </span>
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
  gap: 1.25rem;
  padding: 0.6rem 1.25rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 6px;
  background: var(--brand);
  color: #fff;
  font-weight: 700;
  font-size: 0.95rem;
}
.brand-name {
  font-weight: 650;
  color: var(--text);
}
.tabs {
  display: flex;
  gap: 0.25rem;
}
.tabs a {
  padding: 0.35rem 0.7rem;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 0.92rem;
}
.tabs a:hover {
  background: var(--surface-2);
  color: var(--text);
  text-decoration: none;
}
.tabs a.router-link-active {
  background: var(--brand-tint);
  color: var(--brand-strong);
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.health {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--muted);
}
.health .dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--subtle);
}
.health.ok .dot {
  background: var(--success);
}
.content {
  padding: 1.5rem 1.25rem;
  max-width: 1040px;
  margin: 0 auto;
}
</style>
