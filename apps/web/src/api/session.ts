// Current demo identity. The role switcher writes here; the API client reads it to
// set the X-Demo-User header (AGENTS.md section 7, FR-16).
import { ref } from 'vue'
import { DEMO_USERS, findUser, type DemoUser } from './users'

const STORAGE_KEY = 'cerbo.demoUserId'

function initialUserId(): string {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  if (stored && findUser(stored)) return stored
  return DEMO_USERS[0].id
}

export const currentUserId = ref<string>(initialUserId())

export function setCurrentUser(id: string): void {
  currentUserId.value = id
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, id)
  }
}

export function currentUser(): DemoUser | undefined {
  return findUser(currentUserId.value)
}
