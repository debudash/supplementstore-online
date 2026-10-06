// Auth stub types (AGENTS.md section 7).
export type Role = 'provider' | 'patient' | 'cerbo_admin'

/**
 * The resolved actor for a request. Loaded from the `users` table by the
 * `X-Demo-User` header. Ownership fields are present per role.
 */
export interface Actor {
  id: string
  role: Role
  providerId?: string | null
  practiceId?: string | null
  patientId?: string | null
}

/**
 * Loads an actor by user id, or null if no such user exists.
 * The knex-backed implementation lives in loadActor.ts; tests inject a fake.
 */
export type ActorLoader = (userId: string) => Promise<Actor | null>

// Augment Express Request with the resolved actor.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor
    }
  }
}
