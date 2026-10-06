// Knex-backed actor loader. Resolves a user from the `users` table (owned by T2)
// and attaches provider/practice/patient ownership fields for ownership checks.
import type { Knex } from 'knex'
import type { Actor, ActorLoader, Role } from './types'

interface UserRow {
  id: string
  role: Role
  provider_id: string | null
  patient_id: string | null
  practice_id: string | null
}

/**
 * Create an actor loader backed by Knex. Joins providers/patients to surface the
 * practice id used for ownership. Returns null when the user id is unknown.
 */
export function createKnexActorLoader(db: Knex): ActorLoader {
  return async function loadActor(userId: string): Promise<Actor | null> {
    const row = await db<UserRow>('users')
      .leftJoin('providers', 'users.provider_id', 'providers.id')
      .leftJoin('patients', 'users.patient_id', 'patients.id')
      .select(
        'users.id as id',
        'users.role as role',
        'users.provider_id as provider_id',
        'users.patient_id as patient_id',
        db.raw('coalesce(providers.practice_id, patients.practice_id) as practice_id')
      )
      .where('users.id', userId)
      .first()

    if (!row) return null
    return {
      id: row.id,
      role: row.role,
      providerId: row.provider_id,
      patientId: row.patient_id,
      practiceId: row.practice_id
    }
  }
}
