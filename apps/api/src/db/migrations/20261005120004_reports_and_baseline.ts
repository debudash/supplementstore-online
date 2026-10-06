// T2 migration 4/5: payable statements (immutable period artifacts, ADR-016) and
// the baseline / migration demo-data tables (ADR-018, ADR-019). payable_statements
// aggregates use bigint (docs/ARCHITECTURE.md section 3). Matches section 3 exactly.
// Additive-only (AGENTS.md section 4).
import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table payable_statements (
      id           uuid primary key default gen_random_uuid(),
      provider_id  uuid not null references providers (id),
      practice_id  uuid not null references practices (id),
      period_start date not null,
      period_end   date not null,
      opening_cents bigint not null,
      credits_cents bigint not null,
      debits_cents  bigint not null,
      closing_cents bigint not null,
      closed_at    timestamptz not null default now(),
      closed_by    text references users (id),
      unique (provider_id, period_start)
    );

    create table baseline_imports (
      id         uuid primary key default gen_random_uuid(),
      source     text not null check (source in ('csv', 'synthetic')),
      seed       integer,
      months     integer,
      row_count  integer not null,
      created_at timestamptz not null default now()
    );

    create table baseline_orders (
      id                uuid primary key default gen_random_uuid(),
      import_batch_id   uuid not null references baseline_imports (id),
      provider_id       uuid references providers (id),
      practice_id       uuid references practices (id),
      source_marketplace text,
      order_date        date not null,
      gmv_cents         integer not null check (gmv_cents > 0),
      is_synthetic      boolean not null default false
    );
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists baseline_orders;
    drop table if exists baseline_imports;
    drop table if exists payable_statements;
  `)
}
