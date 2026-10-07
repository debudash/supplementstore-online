<script setup lang="ts">
// "Demo login" (FR-16 AC1): lists the seeded demo users and sets X-Demo-User by
// updating the current demo identity. Changing identity re-navigates to the role home.
// Stands in for real sign-in, so it carries the DemoBadge.
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { DEMO_USERS } from '../api/users'
import { currentUserId, setCurrentUser } from '../api/session'
import DemoBadge from './DemoBadge.vue'

const router = useRouter()

const ROLE_LABEL: Record<string, string> = { provider: 'Provider', patient: 'Patient', cerbo_admin: 'Cerbo Admin' }

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
    <label class="role-switcher-label" for="demo-login">Demo login</label>
    <select id="demo-login" v-model="selected" data-testid="demo-login">
      <option v-for="u in DEMO_USERS" :key="u.id" :value="u.id">
        {{ u.displayName }} - {{ ROLE_LABEL[u.role] }}, {{ u.detail }}
      </option>
    </select>
    <DemoBadge
      reason="Stands in for real sign-in. In production the EHR session establishes who you are; here this picker sets the X-Demo-User header."
    />
  </div>
</template>

<style scoped>
.role-switcher {
  display: inline-flex;
  flex-wrap: nowrap;
  gap: var(--space-2);
  align-items: center;
}
.role-switcher-label {
  font-size: var(--text-sm);
  font-weight: 600;
  white-space: nowrap;
}
select {
  font-size: var(--text-sm);
  min-height: 2.25rem;
  max-width: 13rem;
}
@media (max-width: 1100px) {
  select {
    flex: 1;
    max-width: none;
  }
}
</style>
