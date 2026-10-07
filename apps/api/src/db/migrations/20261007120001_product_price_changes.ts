// Migration 7: product_price_changes - an append-only history of catalog LIST PRICE
// changes made by Cerbo Admin (ADR-025). Every edit records who, when, old -> new and a
// required reason, in the same transaction that updates products.list_price_cents.
//
// LIVE-DB SAFETY (runs at boot on the next deploy):
//  - additive only: one new table + index + two triggers; existing tables are untouched
//    (the products row is only ever UPDATED by the new admin endpoint, never here).
//  - idempotent: `create table if not exists`, `create index if not exists`, triggers
//    created only if absent, so a re-run is a no-op.
//  - append-only like the ledger: UPDATE and DELETE are rejected by the existing
//    cerbo_reject_update / cerbo_reject_delete_always functions (migration 5).
//  - no backfill needed: history starts empty; the seeded price is the implicit origin.
import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table if not exists product_price_changes (
      id               bigserial primary key,
      sku              text not null references products (sku),
      old_price_cents  integer not null check (old_price_cents > 0),
      new_price_cents  integer not null check (new_price_cents > 0),
      reason           text not null check (char_length(btrim(reason)) between 3 and 500),
      actor_user_id    text not null references users (id),
      changed_at       timestamptz not null default now()
    );

    create index if not exists product_price_changes_sku_changed_at
      on product_price_changes (sku, changed_at desc);

    do $$
    begin
      if not exists (select 1 from pg_trigger where tgname = 'product_price_changes_no_update') then
        create trigger product_price_changes_no_update before update on product_price_changes
          for each row execute function cerbo_reject_update();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'product_price_changes_no_delete') then
        create trigger product_price_changes_no_delete before delete on product_price_changes
          for each row execute function cerbo_reject_delete_always();
      end if;
    end
    $$;
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`drop table if exists product_price_changes;`)
}
