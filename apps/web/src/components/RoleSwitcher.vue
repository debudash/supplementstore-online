<script setup lang="ts">
// Role switcher (FR-16 AC1): lists the seeded demo users and sets X-Demo-User by
// updating the current demo identity. Changing identity re-navigates to the role home.
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { DEMO_USERS } from '../api/users'
import { currentUserId, setCurrentUser } from '../api/session'
import DemoBadge from './DemoBadge.vue'

const router = useRouter()

const selected = computed({
  get: () => currentUserId.value,
  set: (id: string) => {
    setCurrentUser(id)
    router.push('/')
  }
})
</script>

<template>
  <div class="role-switcher">
    <DemoBadge
      reason="Demo affordance - stands in for real authentication. In production, sign-in establishes identity; here the X-Demo-User header is set by this switcher."
    />
    <label class="role-switcher-label">
      <span class="caption">Acting as</span>
      <select v-model="selected" aria-label="Acting as (demo user)">
        <option v-for="u in DEMO_USERS" :key="u.id" :value="u.id">
          {{ u.displayName }} - {{ u.role }} ({{ u.detail }})
        </option>
      </select>
    </label>
  </div>
</template>

<style scoped>
.role-switcher {
  display: inline-flex;
  gap: 0.5rem;
  align-items: center;
}
.role-switcher-label {
  display: inline-flex;
  gap: 0.4rem;
  align-items: center;
}
.caption {
  color: var(--muted);
  font-size: 0.85rem;
  white-space: nowrap;
}
.role-switcher select {
  font-size: 0.9rem;
}
</style>
