// Migration 8: refund_requests - a patient asks for a refund; the provider approves (which
// runs the standard refund, ADR-012/013) or declines with a note. No return is involved:
// the patient keeps or safely disposes of the product (ADR-023).
//
// LIVE-DB SAFETY (runs at boot on the next deploy):
//  - additive only: one new table + one partial unique index; existing tables untouched.
//  - idempotent: `if not exists` throughout.
//  - at most ONE pending request per order (partial unique index), so two taps can never
//    create two open requests.
//  - `on delete cascade` from orders: the only orders ever deleted are drafts (which cannot
//    be refunded, so never have requests) and synthetic demo orders (requests are refused on
//    those, and cascade keeps the demo reset from ever being blocked).
//  - not append-only: a request moves pending -> approved | declined once; the money record
//    of an approval is the refund itself, which IS append-only.
import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table if not exists refund_requests (
      id             uuid primary key default gen_random_uuid(),
      order_id       uuid not null references orders (id) on delete cascade,
      patient_id     uuid not null references patients (id),
      reason_code    text not null check (reason_code in ('damaged', 'wrong_item', 'patient_request', 'other')),
      note           text check (note is null or char_length(note) <= 500),
      status         text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
      decision_note  text check (decision_note is null or char_length(decision_note) <= 500),
      decided_by     text references users (id),
      decided_at     timestamptz,
      created_at     timestamptz not null default now()
    );

    create unique index if not exists refund_requests_one_pending_per_order
      on refund_requests (order_id) where status = 'pending';

    create index if not exists refund_requests_order_created
      on refund_requests (order_id, created_at desc);
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`drop table if exists refund_requests;`)
}
