// Demo roster for the role switcher (FR-16 AC1): 2 providers (different practices),
// 2 patients, 1 Cerbo Admin. IDs match the seed table in docs/EVALS.md.
export type Role = 'provider' | 'patient' | 'cerbo_admin'

export interface DemoUser {
  id: string
  displayName: string
  role: Role
  detail: string
}

export const DEMO_USERS: DemoUser[] = [
  { id: 'prov-ana', displayName: 'Dr. Ana Reyes', role: 'provider', detail: 'Riverside Integrative' },
  { id: 'prov-ben', displayName: 'Dr. Ben Cole', role: 'provider', detail: 'Summit DPC' },
  { id: 'pat-cara', displayName: 'Cara Lopez', role: 'patient', detail: 'Riverside' },
  { id: 'pat-dev', displayName: 'Dev Patel', role: 'patient', detail: 'Summit' },
  { id: 'admin-cerbo', displayName: 'Cerbo Admin', role: 'cerbo_admin', detail: 'Platform' }
]

export function findUser(id: string): DemoUser | undefined {
  return DEMO_USERS.find((u) => u.id === id)
}
