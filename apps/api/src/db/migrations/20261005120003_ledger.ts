// T2 migration 3/5: the money record. payments, refunds, journals, ledger_entries.
// These are the append-only tables protected by triggers in migration 5/5
// (ADR-007, AGENTS.md money rule 6). Per-row money is integer cents, signed on
// ledger_entries (debit positive). Matches docs/ARCHITECTURE.md section 3 exactly.
// Additive-only (AGENTS.md section 4).
import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table payments (
      id              uuid primary key default gen_random_uuid(),
      order_id        uuid not null unique references orders (id),
      idempotency_key text not null unique,
      gateway_ref     text,
      amount_cents    integer not null,
      created_at      timestamptz not null default now(),
      is_synthetic    boolean not null default false
    );

    create table refunds (
      id                 uuid primary key default gen_random_uuid(),
      order_id           uuid not null unique references orders (id),
      reason_code        text not null check (reason_code in ('damaged', 'wrong_item', 'patient_request', 'provider_error', 'other')),
      amount_cents       integer not null,
      fee_retained_cents integer not null,
      restocked          boolean not null,
      writeoff_cogs_cents integer not null default 0,
      gateway_ref        text,
      actor_user_id      text references users (id),
      created_at         timestamptz not null default now(),
      is_synthetic       boolean not null default false
    );

    create table journals (
      id           uuid primary key default gen_random_uuid(),
      order_id     uuid not null references orders (id),
      type         text not null check (type in ('PAYMENT', 'REFUND')),
      ref_id       uuid,
      posted_at    timestamptz not null default now(),
      is_synthetic boolean not null default false
    );

    create table ledger_entries (
      id           bigserial primary key,
      journal_id   uuid not null references journals (id),
      order_id     uuid not null references orders (id),
      line_id      uuid references order_lines (id),
      account      text not null check (account in ('CASH_CLEARING', 'COGS_RECOVERY', 'PROVIDER_PAYABLE', 'PLATFORM_FEE_REVENUE')),
      provider_id  uuid references providers (id),
      practice_id  uuid references practices (id),
      amount_cents integer not null,
      memo         text,
      created_at   timestamptz not null default now(),
      is_synthetic boolean not null default false
    );
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists ledger_entries;
    drop table if exists journals;
    drop table if exists refunds;
    drop table if exists payments;
  `)
}
