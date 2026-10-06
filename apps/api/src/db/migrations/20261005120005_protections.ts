// T2 migration 5/5: database-level protections (GATE G2 reviews this file).
// Implements "Database-level protections" from docs/ARCHITECTURE.md section 3 and
// ADR-007 (append-only double-entry enforced by DB triggers) / ADR-019 (one guarded
// synthetic purge path).
//
// 1. Append-only: UPDATE is always rejected on journals, ledger_entries, payments,
//    refunds, payable_statements. (AGENTS.md money rule 6.)
// 2. DELETE is rejected on journals, ledger_entries, payments, refunds EXCEPT when
//    the row is is_synthetic AND the session setting app.allow_synthetic_purge = 'on'
//    (set transaction-locally by the single guarded purge path, apps/api/src/admin/demo/reset.ts).
// 3. payable_statements is NEVER deletable, not even synthetic rows.
// 4. Deferred constraint trigger: every journal's ledger_entries sum to zero, checked
//    at COMMIT (not per statement), so a balanced multi-entry journal inserted in one
//    transaction is valid while an unbalanced one aborts the commit (ADR-007, money rule 7).
//
// Additive-only (AGENTS.md section 4): never edit this file once merged.
import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    -- Reject every UPDATE on an append-only table.
    create or replace function cerbo_reject_update() returns trigger
    language plpgsql as $$
    begin
      raise exception 'append-only: UPDATE on % is not allowed (corrections are new journals)', tg_table_name
        using errcode = 'restrict_violation';
    end;
    $$;

    -- Reject DELETE unless the row is synthetic and the guarded purge flag is set
    -- transaction-locally for this session.
    create or replace function cerbo_reject_delete_unless_synthetic() returns trigger
    language plpgsql as $$
    begin
      if old.is_synthetic and current_setting('app.allow_synthetic_purge', true) = 'on' then
        return old;
      end if;
      raise exception 'append-only: DELETE on % is not allowed (synthetic purge requires app.allow_synthetic_purge = on on a synthetic row)', tg_table_name
        using errcode = 'restrict_violation';
    end;
    $$;

    -- Reject every DELETE unconditionally (payable_statements are never deletable).
    create or replace function cerbo_reject_delete_always() returns trigger
    language plpgsql as $$
    begin
      raise exception 'append-only: DELETE on % is never allowed', tg_table_name
        using errcode = 'restrict_violation';
    end;
    $$;

    -- Deferred: each journal's entries sum to zero, verified at COMMIT.
    create or replace function cerbo_check_journal_balance() returns trigger
    language plpgsql as $$
    declare
      total bigint;
    begin
      select coalesce(sum(amount_cents), 0) into total
        from ledger_entries where journal_id = new.journal_id;
      if total <> 0 then
        raise exception 'journal % does not balance: entries sum to % (must be 0)', new.journal_id, total
          using errcode = 'check_violation';
      end if;
      return null;
    end;
    $$;

    -- UPDATE guard on all five append-only tables.
    create trigger journals_no_update          before update on journals          for each row execute function cerbo_reject_update();
    create trigger ledger_entries_no_update     before update on ledger_entries     for each row execute function cerbo_reject_update();
    create trigger payments_no_update           before update on payments           for each row execute function cerbo_reject_update();
    create trigger refunds_no_update            before update on refunds            for each row execute function cerbo_reject_update();
    create trigger payable_statements_no_update before update on payable_statements for each row execute function cerbo_reject_update();

    -- DELETE guard: synthetic purge allowed on the ledger tables, never on statements.
    create trigger journals_no_delete       before delete on journals       for each row execute function cerbo_reject_delete_unless_synthetic();
    create trigger ledger_entries_no_delete  before delete on ledger_entries  for each row execute function cerbo_reject_delete_unless_synthetic();
    create trigger payments_no_delete        before delete on payments        for each row execute function cerbo_reject_delete_unless_synthetic();
    create trigger refunds_no_delete         before delete on refunds         for each row execute function cerbo_reject_delete_unless_synthetic();
    create trigger payable_statements_no_delete before delete on payable_statements for each row execute function cerbo_reject_delete_always();

    -- Deferred zero-sum check on ledger entries (fires at commit).
    create constraint trigger ledger_entries_balanced
      after insert on ledger_entries
      deferrable initially deferred
      for each row execute function cerbo_check_journal_balance();
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop trigger if exists ledger_entries_balanced on ledger_entries;
    drop trigger if exists payable_statements_no_delete on payable_statements;
    drop trigger if exists refunds_no_delete on refunds;
    drop trigger if exists payments_no_delete on payments;
    drop trigger if exists ledger_entries_no_delete on ledger_entries;
    drop trigger if exists journals_no_delete on journals;
    drop trigger if exists payable_statements_no_update on payable_statements;
    drop trigger if exists refunds_no_update on refunds;
    drop trigger if exists payments_no_update on payments;
    drop trigger if exists ledger_entries_no_update on ledger_entries;
    drop trigger if exists journals_no_update on journals;
    drop function if exists cerbo_check_journal_balance();
    drop function if exists cerbo_reject_delete_always();
    drop function if exists cerbo_reject_delete_unless_synthetic();
    drop function if exists cerbo_reject_update();
  `)
}
