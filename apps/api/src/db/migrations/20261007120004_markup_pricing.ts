// Migration 10: per-unit dollar markup pricing (ADR-028). Providers enter a markup; the
// price is derived as COGS + markup grossed up for the fee. The markup is stored on order
// lines and schedule lines for tracking and audit. Cerbo Admin no longer sets a list price,
// so products.list_price_cents becomes nullable (kept for history, no longer read).
//
// LIVE-DB SAFETY (runs at boot on the next deploy):
//  - additive: two nullable-then-backfilled columns and one dropped NOT NULL; never touches
//    journals, ledger_entries, payments, refunds or payable_statements.
//  - idempotent: `add column if not exists`, null-guarded backfills, `drop not null` and
//    constraints added only if absent.
//  - DRAFT lines are backfilled with the markup their current price already implies,
//    floor(price * (10000 - fee_bps) / 10000) - cogs (at least 0), so re-deriving the price
//    from it never raises what the patient would pay (except by the 1 cent of headroom a
//    $0 markup carries, which a draft priced at or below cost + fee would gain). Sent and paid lines keep a NULL
//    markup: they predate ADR-028 and their stored price and split stay the record.
//  - schedule lines are backfilled the same way from the list price they were indicating,
//    then set NOT NULL, because each recurring cycle now prices from the schedule's markup.
//  - lines of recurring cycles parked ON_HOLD take their schedule line's markup, so a retry
//    prices from current COGS + markup like any new cycle (instead of a stale list price).
import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    alter table order_lines add column if not exists unit_markup_cents integer;
    alter table schedule_lines add column if not exists unit_markup_cents integer;

    update order_lines ol
       set unit_markup_cents = least(100000, greatest(0,
             (ol.unit_price_cents * (10000 - o.fee_bps)) / 10000 - p.unit_cogs_cents))
      from orders o, products p
     where o.id = ol.order_id and p.sku = ol.sku
       and o.status = 'draft' and ol.unit_markup_cents is null;

    update schedule_lines sl
       set unit_markup_cents = least(100000, greatest(0,
             (coalesce(p.list_price_cents, sl.unit_price_cents) * 9925) / 10000 - p.unit_cogs_cents))
      from products p
     where p.sku = sl.sku and sl.unit_markup_cents is null;

    alter table schedule_lines alter column unit_markup_cents set not null;

    update order_lines ol
       set unit_markup_cents = sl.unit_markup_cents
      from orders o, schedule_lines sl
     where o.id = ol.order_id and o.kind = 'recurring_cycle' and o.status = 'on_hold'
       and sl.schedule_id = o.schedule_id and sl.sku = ol.sku
       and ol.unit_markup_cents is null;

    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'order_lines_unit_markup_cents_check') then
        alter table order_lines add constraint order_lines_unit_markup_cents_check
          check (unit_markup_cents is null or unit_markup_cents between 0 and 100000);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'schedule_lines_unit_markup_cents_check') then
        alter table schedule_lines add constraint schedule_lines_unit_markup_cents_check
          check (unit_markup_cents between 0 and 100000);
      end if;
    end
    $$;

    alter table products alter column list_price_cents drop not null;
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    alter table order_lines drop constraint if exists order_lines_unit_markup_cents_check;
    alter table schedule_lines drop constraint if exists schedule_lines_unit_markup_cents_check;
    alter table order_lines drop column if exists unit_markup_cents;
    alter table schedule_lines drop column if exists unit_markup_cents;
  `)
}
