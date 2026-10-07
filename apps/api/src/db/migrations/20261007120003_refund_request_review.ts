// Migration 9: refund_requests gains the patient's "unopened" confirmation and a review
// token for the provider's review link (ADR-027).
//
// LIVE-DB SAFETY (runs at boot on the next deploy):
//  - additive only: two columns + one unique index on an existing table.
//  - idempotent: `add column if not exists`, `create unique index if not exists`.
//  - backfills a token for any existing request (gen_random_bytes from pgcrypto, which
//    migration 1 installs) before the unique index is created; existing rows keep
//    unopened_confirmed = false (they predate the confirmation).
import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    alter table refund_requests add column if not exists unopened_confirmed boolean not null default false;
    alter table refund_requests add column if not exists review_token text;
    update refund_requests set review_token = encode(gen_random_bytes(24), 'hex') where review_token is null;
    alter table refund_requests alter column review_token set not null;
    create unique index if not exists refund_requests_review_token on refund_requests (review_token);
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop index if exists refund_requests_review_token;
    alter table refund_requests drop column if exists review_token;
    alter table refund_requests drop column if exists unopened_confirmed;
  `)
}
