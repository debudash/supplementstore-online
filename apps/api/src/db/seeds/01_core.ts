// T2 seed: the exact fixtures every downstream EVAL depends on (docs/EVALS.md
// "Seed data"). Values here are canonical - never change one to make a test pass
// (AGENTS.md section 4). The seed is idempotent: it upserts on primary keys, so
// `db.seed.run()` can run repeatedly (server boot runs it only when products is
// empty; `npm run db:seed` may run it any time).
//
// Deterministic UUIDs let the upsert key stay stable across runs and let other
// seeds/tests reference these rows.
import type { Knex } from 'knex'

// Stable practice / provider / patient ids (users carry the string ids from EVALS).
const PRACTICE_RIVERSIDE = '11111111-1111-1111-1111-111111111111'
const PRACTICE_SUMMIT = '22222222-2222-2222-2222-222222222222'
const PROVIDER_ANA = 'aaaaaaaa-0000-0000-0000-000000000001'
const PROVIDER_BEN = 'aaaaaaaa-0000-0000-0000-000000000002'
const PATIENT_CARA = 'cccccccc-0000-0000-0000-000000000001'
const PATIENT_DEV = 'cccccccc-0000-0000-0000-000000000002'

const PRACTICES = [
  { id: PRACTICE_RIVERSIDE, name: 'Riverside Integrative' },
  { id: PRACTICE_SUMMIT, name: 'Summit DPC' }
]

const PROVIDERS = [
  { id: PROVIDER_ANA, practice_id: PRACTICE_RIVERSIDE, name: 'Dr. Ana Reyes', email: 'ana.reyes@riverside.example' },
  { id: PROVIDER_BEN, practice_id: PRACTICE_SUMMIT, name: 'Dr. Ben Cole', email: 'ben.cole@summit.example' }
]

const PATIENTS = [
  { id: PATIENT_CARA, practice_id: PRACTICE_RIVERSIDE, name: 'Cara Lopez', email: 'cara.lopez@example.com', ship_to: '100 River Rd, Riverside' },
  { id: PATIENT_DEV, practice_id: PRACTICE_SUMMIT, name: 'Dev Patel', email: 'dev.patel@example.com', ship_to: '200 Summit Ave, Summit' }
]

const USERS = [
  { id: 'prov-ana', role: 'provider', provider_id: PROVIDER_ANA, patient_id: null, display_name: 'Dr. Ana Reyes' },
  { id: 'prov-ben', role: 'provider', provider_id: PROVIDER_BEN, patient_id: null, display_name: 'Dr. Ben Cole' },
  { id: 'pat-cara', role: 'patient', provider_id: null, patient_id: PATIENT_CARA, display_name: 'Cara Lopez' },
  { id: 'pat-dev', role: 'patient', provider_id: null, patient_id: PATIENT_DEV, display_name: 'Dev Patel' },
  { id: 'admin-cerbo', role: 'cerbo_admin', provider_id: null, patient_id: null, display_name: 'Cerbo Admin' }
]

// SKU, name, unit_cogs_cents, on_hand_qty - verbatim from docs/EVALS.md seed table.
// There is no catalog list price: providers price each line with a markup (ADR-028).
const PRODUCTS = [
  { sku: 'MAG-GLY-120', name: 'Magnesium Glycinate 120ct', unit_cogs_cents: 1450, on_hand_qty: 50 },
  { sku: 'VITD3-K2', name: 'Vitamin D3 + K2', unit_cogs_cents: 1125, on_hand_qty: 40 },
  { sku: 'OMEGA3-1000', name: 'Omega-3 Fish Oil 1000mg', unit_cogs_cents: 2280, on_hand_qty: 30 },
  { sku: 'PROBIO-50B', name: 'Probiotic 50B CFU', unit_cogs_cents: 2675, on_hand_qty: 5 },
  { sku: 'ZINC-30', name: 'Zinc Picolinate 30mg', unit_cogs_cents: 690, on_hand_qty: 0 }
]

/**
 * Upsert all canonical fixtures in FK dependency order. Idempotent: re-running
 * restores the canonical values without duplicating rows or erroring.
 */
export async function seedCore(knex: Knex): Promise<void> {
  await knex('practices').insert(PRACTICES).onConflict('id').merge()
  await knex('providers').insert(PROVIDERS).onConflict('id').merge()
  await knex('patients').insert(PATIENTS).onConflict('id').merge()
  await knex('users').insert(USERS).onConflict('id').merge()
  // reserved_qty/active/updated_at keep their table defaults; only seed the
  // columns EVALS.md pins. Merge restores on_hand_qty/cogs to canonical on re-seed.
  await knex('products')
    .insert(PRODUCTS)
    .onConflict('sku')
    .merge(['name', 'unit_cogs_cents', 'on_hand_qty'])
}

/** Run the core seed only when the products table is empty (server-boot helper). */
export async function seedIfEmpty(knex: Knex): Promise<void> {
  const [{ count }] = await knex('products').count<{ count: string }[]>('* as count')
  if (Number(count) === 0) {
    await seedCore(knex)
  }
}

/** Knex seed entrypoint invoked by `db.seed.run()` (server boot and `npm run db:seed`). */
export async function seed(knex: Knex): Promise<void> {
  await seedCore(knex)
}
