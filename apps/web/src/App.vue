<script setup lang="ts">
// App shell (docs/ARCHITECTURE.md section 11): skip link, top bar with role-aware
// navigation (built from router meta), the "Demo login" switcher, an API health chip,
// and the global toast host. On narrow screens the navigation collapses into a menu.
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import RoleSwitcher from './components/RoleSwitcher.vue'
import ToastHost from './components/ui/ToastHost.vue'
import { currentUser } from './api/session'
import { routes } from './router'
import { getHealth } from './api/client'

const route = useRoute()
const role = computed(() => currentUser()?.role)

const tabs = computed(() =>
  routes
    .filter((r) => r.meta?.tab && role.value && r.meta.roles?.includes(role.value))
    .map((r) => ({ path: r.path, label: r.meta!.tab as string }))
)

const ROLE_LABEL: Record<string, string> = { provider: 'Provider', patient: 'Patient', cerbo_admin: 'Cerbo Admin' }
const roleLabel = computed(() => (role.value ? ROLE_LABEL[role.value] : ''))

type Health = 'checking' | 'ok' | 'db-down' | 'unreachable'
const health = ref<Health>('checking')
const HEALTH_TEXT: Record<Health, string> = {
  checking: 'Checking system...',
  ok: 'System online',
  'db-down': 'Database down',
  unreachable: 'API unreachable'
}
onMounted(async () => {
  try {
    const h = await getHealth()
    health.value = h.db.connected ? 'ok' : 'db-down'
  } catch {
    health.value = 'unreachable'
  }
})

const menuOpen = ref(false)
watch(
  () => route.fullPath,
  () => {
    menuOpen.value = false
  }
)
</script>

<template>
  <a class="skip-link" href="#main">Skip to main content</a>
  <header class="topbar">
    <div class="topbar-inner">
      <RouterLink to="/" class="brand" aria-label="Cerbo Supplement Store home">
        <span class="brand-mark" aria-hidden="true">C</span>
        <span class="brand-name">Cerbo <span class="brand-sub">Supplements</span></span>
      </RouterLink>
      <span v-if="roleLabel" class="role-chip" data-testid="role-chip">{{ roleLabel }}</span>

      <button
        type="button"
        class="menu-toggle"
        :aria-expanded="menuOpen"
        aria-controls="primary-nav"
        data-testid="menu-toggle"
        @click="menuOpen = !menuOpen"
      >
        <span aria-hidden="true">☰</span> Menu
      </button>

      <div id="primary-nav" class="nav-area" :class="{ open: menuOpen }">
        <nav class="tabs" aria-label="Primary">
          <RouterLink v-for="t in tabs" :key="t.path" :to="t.path" :data-testid="`nav-${t.path}`">{{ t.label }}</RouterLink>
        </nav>
        <span class="spacer" />
        <span class="health" :class="`health-${health}`" role="status" data-testid="health">
          <span class="dot" aria-hidden="true" :title="HEALTH_TEXT[health]" />
          <span class="health-text">{{ HEALTH_TEXT[health] }}</span>
        </span>
        <RoleSwitcher />
      </div>
    </div>
  </header>
  <main id="main" class="content" tabindex="-1">
    <RouterView />
  </main>
  <ToastHost />
</template>

<style scoped>
.skip-link {
  position: absolute;
  left: var(--space-4);
  top: -3rem;
  z-index: 200;
  padding: var(--space-2) var(--space-4);
  background: var(--brand);
  color: #fff;
  border-radius: var(--radius-sm);
  font-weight: 650;
}
.skip-link:focus {
  top: var(--space-2);
}
.topbar {
  position: sticky;
  top: 0;
  z-index: 50;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
}
.topbar-inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-4);
  margin: 0 auto;
  padding: var(--space-2) var(--space-6);
  min-height: var(--topbar-h);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text);
  text-decoration: none;
}
.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.9rem;
  height: 1.9rem;
  border-radius: 7px;
  background: var(--brand);
  color: #fff;
  font-weight: 750;
}
.brand-name {
  font-weight: 700;
  font-size: var(--text-lg);
}
.brand-sub {
  font-weight: 450;
  color: var(--muted);
}
.role-chip {
  font-size: var(--text-xs);
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--n-700);
  background: var(--n-100);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  padding: 0.1rem 0.55rem;
}
.menu-toggle {
  display: none;
  margin-left: auto;
}
.nav-area {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-width: 0;
}
.tabs {
  display: flex;
  flex-wrap: nowrap;
  gap: var(--space-1);
}
.tabs a {
  padding: 0.45rem 0.75rem;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: var(--text-sm);
  font-weight: 550;
  text-decoration: none;
  white-space: nowrap;
}
.tabs a:hover {
  background: var(--n-100);
  color: var(--text);
}
.tabs a.router-link-active {
  background: var(--brand-tint);
  color: var(--brand-strong);
  font-weight: 650;
}
.health {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--muted);
  white-space: nowrap;
}
.dot {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  background: var(--n-400);
}
.health-ok .dot {
  background: var(--success);
}
.health-db-down .dot,
.health-unreachable .dot {
  background: var(--danger);
}
.health-db-down,
.health-unreachable {
  color: var(--danger);
  font-weight: 650;
}
.content {
  max-width: var(--content-max);
  margin: 0 auto;
  padding: var(--space-8) var(--space-5) var(--space-16);
}
.content:focus {
  outline: none;
}

@media (max-width: 1360px) and (min-width: 1101px) {
  .brand-sub,
  .health-text {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }
  .tabs a {
    padding: 0.45rem 0.55rem;
  }
}
@media (max-width: 1100px) {
  .menu-toggle {
    display: inline-flex;
  }
  .nav-area {
    display: none;
    flex-basis: 100%;
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-3);
    padding: var(--space-2) 0 var(--space-3);
    border-top: 1px solid var(--border);
  }
  .nav-area.open {
    display: flex;
  }
  .tabs {
    flex-direction: column;
  }
  .tabs a {
    padding: var(--space-3);
    font-size: var(--text-md);
  }
  .spacer {
    display: none;
  }
}
@media (max-width: 640px) {
  .brand-sub {
    display: none;
  }
  .topbar-inner {
    padding: var(--space-2) var(--space-4);
  }
  .content {
    padding: var(--space-5) var(--space-4) var(--space-12);
  }
}
</style>
