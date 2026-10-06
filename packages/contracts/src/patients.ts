// @cerbo/contracts - patient roster types (GET /api/patients).
//
// The provider order builder (FR-1) needs the real patients.id uuid to open a draft
// via POST /api/orders { patientId }. A provider only ever sees patients in their own
// practice (AGENTS.md section 7 ownership), so this roster is always practice-scoped
// server-side; the client never filters.

/** One patient as the provider sees them when choosing who to order for. */
export interface PatientView {
  /** patients.id uuid - the value POSTed as { patientId } to open a draft. */
  id: string
  name: string
  /** Shown to disambiguate patients with similar names; same-practice only. */
  email: string
}

/** GET /api/patients response (mirrors the { products } convention). */
export interface PatientsResponse {
  patients: PatientView[]
}
