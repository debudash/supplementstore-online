<script setup lang="ts">
// Role switcher (FR-16 AC1): lists the seeded demo users and sets X-Demo-User by
// updating the current demo identity. Changing identity re-navigates to the role home.
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { DEMO_USERS } from '../api/users'
import { currentUserId, setCurrentUser } from '../api/session'

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
  <label class="role-switcher">
    <span>Acting as</span>
    <select v-model="selected">
      <option v-for="u in DEMO_USERS" :key="u.id" :value="u.id">
        {{ u.displayName }} - {{ u.role }} ({{ u.detail }})
      </option>
    </select>
  </label>
</template>

<style scoped>
.role-switcher {
  display: inline-flex;
  gap: 0.5rem;
  align-items: center;
}
</style>
