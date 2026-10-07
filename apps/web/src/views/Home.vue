<script setup lang="ts">
// Role home: a short welcome and the main destinations for the current demo identity.
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { currentUser } from '../api/session'
import PageHeader from '../components/ui/PageHeader.vue'

interface Dest {
  to: string
  title: string
  text: string
}

const user = computed(() => currentUser())

const DESTS: Record<string, Dest[]> = {
  provider: [
    { to: '/orders/new', title: 'New order', text: 'Build a supplement order for a patient and send them a pay link.' },
    { to: '/orders', title: 'Orders', text: 'Track drafts, sent and paid orders, and open any order\'s money trail.' },
    { to: '/recurring', title: 'Recurring', text: 'Set up repeat orders and see anything on hold.' },
    { to: '/dashboard', title: 'Dashboard', text: 'Sales, fees and your net margin at a glance.' },
    { to: '/payables', title: 'Payables', text: 'What Cerbo owes your practice for a period.' }
  ],
  patient: [{ to: '/my-orders', title: 'My orders', text: 'Review and pay for supplements your provider sent you.' }],
  cerbo_admin: [
    { to: '/admin/evidence', title: 'Evidence', text: 'Live proof the money is right, plus unit economics and refund exposure.' },
    { to: '/admin/metrics', title: 'Metrics', text: 'Platform volume, fees and migration progress.' },
    { to: '/admin/operations', title: 'Operations', text: 'Fulfill orders, issue refunds and run jobs.' },
    { to: '/admin/inventory', title: 'Inventory', text: 'Stock levels and demo restock.' },
    { to: '/admin/payables', title: 'Payables', text: 'Provider statements and month close.' },
    { to: '/admin/demo', title: 'Demo data', text: 'Generate or reset demonstration data.' }
  ]
}

const dests = computed(() => (user.value ? DESTS[user.value.role] ?? [] : []))
</script>

<template>
  <section>
    <PageHeader
      :title="user ? `Welcome, ${user.displayName}` : 'Cerbo Supplement Store'"
      subtitle="Provider-dispensed supplements, with every dollar accounted for."
    />
    <div class="dests">
      <RouterLink v-for="d in dests" :key="d.to" :to="d.to" class="dest">
        <span class="dest-title">{{ d.title }} <span aria-hidden="true">→</span></span>
        <span class="dest-text">{{ d.text }}</span>
      </RouterLink>
    </div>
    <p v-if="user?.role === 'patient'" class="subtle hint">Your provider may also send you a direct pay link.</p>
  </section>
</template>

<style scoped>
.dests {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
  gap: var(--space-4);
}
.dest {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-5);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  color: var(--text);
  text-decoration: none;
}
.dest:hover {
  border-color: var(--brand-border);
  background: var(--brand-tint);
}
.dest-title {
  font-weight: 700;
  color: var(--brand-strong);
}
.dest-text {
  color: var(--muted);
  font-size: var(--text-sm);
}
.hint {
  margin-top: var(--space-6);
}
</style>
