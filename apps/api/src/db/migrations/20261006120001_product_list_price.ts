// Migration 6: products.list_price_cents - a seeded catalog LIST PRICE so the New Order
// screen can show a price the provider does not type (owner decision). Additive only;
// T2's merged migrations are untouched (AGENTS.md section 4 permits ADDING a migration).
//
// LIVE-DB SAFETY (runs at boot on the next deploy):
//  - additive: adds one column to `products`; never touches orders, journals,
//    ledger_entries, payments, refunds, or payable_statements.
//  - idempotent / safe to run twice: `add column if not exists`, a null-guarded backfill,
//    a constraint added only if absent, and `set not null` (a no-op when already set).
//  - BACKFILLS the five known SKUs here, because the deployed DB is already seeded and the
//    seed is skip-if-empty (it will NOT re-run), so without this backfill production would
//    show blank prices. Backfill runs BEFORE `set not null`, so the constraint holds for
//    the existing rows; on a fresh (empty) DB the backfill is a no-op and the seed supplies
//    the prices.
//
// Column mirrors unit_cogs_cents: integer cents, NOT NULL, check (> 0). Prices match the
// demo/eval numbers so the walkthrough needs no typing (MAG 2999, VITD 2499, OMEGA 4999 are
// the EVAL-01/02 prices); PROBIO 4299 and ZINC 1290 are sensible above-COGS retail prices
// (~1.6x and ~1.9x COGS of 2675 and 690), comfortably clearing the line margin floor.
import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    alter table products add column if not exists list_price_cents integer;

    update products set list_price_cents = v.price
    from (values
      ('MAG-GLY-120', 2999),
      ('VITD3-K2',    2499),
      ('OMEGA3-1000', 4999),
      ('PROBIO-50B',  4299),
      ('ZINC-30',     1290)
    ) as v(sku, price)
    where products.sku = v.sku and products.list_price_cents is null;

    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'products_list_price_cents_check'
      ) then
        alter table products
          add constraint products_list_price_cents_check check (list_price_cents > 0);
      end if;
    end
    $$;

    alter table products alter column list_price_cents set not null;
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    alter table products drop constraint if exists products_list_price_cents_check;
    alter table products drop column if exists list_price_cents;
  `)
}
