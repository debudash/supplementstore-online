// T2 migration 2/5: recurring schedules, orders, lines, events, inventory movements.
// recurring_schedules is created before orders because orders.schedule_id references it.
// Matches docs/ARCHITECTURE.md section 3 exactly. Additive-only (AGENTS.md section 4).
import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table recurring_schedules (
      id                   uuid primary key default gen_random_uuid(),
      provider_id          uuid not null references providers (id),
      practice_id          uuid not null references practices (id),
      patient_id           uuid not null references patients (id),
      interval_days        integer not null default 30 check (interval_days between 7 and 90),
      next_run_at          timestamptz,
      status               text not null default 'active' check (status in ('active', 'paused', 'cancelled')),
      authorized_at        timestamptz,
      payment_method_token text,
      pay_token            text unique,
      created_at           timestamptz not null default now()
    );

    create table schedule_lines (
      id               uuid primary key default gen_random_uuid(),
      schedule_id      uuid not null references recurring_schedules (id),
      position         integer not null,
      sku              text not null references products (sku),
      qty              integer not null check (qty between 1 and 100),
      unit_price_cents integer not null check (unit_price_cents > 0)
    );

    create table orders (
      id                     uuid primary key default gen_random_uuid(),
      provider_id            uuid not null references providers (id),
      practice_id            uuid not null references practices (id),
      patient_id             uuid not null references patients (id),
      kind                   text not null check (kind in ('one_off', 'recurring_cycle')),
      schedule_id            uuid references recurring_schedules (id),
      cycle_number           integer,
      status                 text not null check (status in ('draft', 'sent', 'paid', 'cancelled', 'expired', 'refunded', 'on_hold')),
      hold_reason            text,
      fee_bps                integer not null default 75,
      subtotal_cents         integer,
      cogs_cents             integer,
      fee_cents              integer,
      margin_cents           integer,
      pay_token              text unique,
      reservation_expires_at timestamptz,
      sent_at                timestamptz,
      paid_at                timestamptz,
      fulfilled_at           timestamptz,
      cancelled_at           timestamptz,
      expired_at             timestamptz,
      refunded_at            timestamptz,
      is_synthetic           boolean not null default false,
      created_at             timestamptz not null default now(),
      updated_at             timestamptz not null default now(),
      check (subtotal_cents is null or subtotal_cents = cogs_cents + fee_cents + margin_cents),
      check (margin_cents is null or margin_cents >= 0)
    );

    create table order_lines (
      id               uuid primary key default gen_random_uuid(),
      order_id         uuid not null references orders (id),
      position         integer not null,
      sku              text not null references products (sku),
      qty              integer not null check (qty between 1 and 100),
      unit_price_cents integer not null check (unit_price_cents > 0),
      unit_cogs_cents  integer not null check (unit_cogs_cents > 0),
      line_total_cents integer,
      line_cogs_cents  integer,
      line_fee_cents   integer,
      line_margin_cents integer,
      unique (order_id, sku),
      unique (order_id, position),
      check (line_fee_cents is null or line_total_cents = line_cogs_cents + line_fee_cents + line_margin_cents)
    );

    create table order_events (
      id            bigserial primary key,
      order_id      uuid not null references orders (id),
      from_status   text,
      to_status     text not null,
      actor_user_id text references users (id),
      at            timestamptz not null default now(),
      note          text
    );

    create table inventory_movements (
      id            bigserial primary key,
      sku           text not null references products (sku),
      delta_on_hand integer not null default 0,
      delta_reserved integer not null default 0,
      reason        text not null check (reason in ('seed', 'restock', 'reserve', 'release', 'sale', 'refund_restock', 'adjustment')),
      order_id      uuid references orders (id),
      actor_user_id text references users (id),
      created_at    timestamptz not null default now()
    );
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists inventory_movements;
    drop table if exists order_events;
    drop table if exists order_lines;
    drop table if exists orders;
    drop table if exists schedule_lines;
    drop table if exists recurring_schedules;
  `)
}
