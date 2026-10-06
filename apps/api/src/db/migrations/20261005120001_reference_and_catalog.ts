// T2 migration 1/5: reference entities and the inventory catalog.
// Tables: practices, providers, patients, users, products.
// Matches docs/ARCHITECTURE.md section 3 exactly. Migrations are additive-only
// forever (AGENTS.md section 4): never edit this file once merged, add a new one.
import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create extension if not exists pgcrypto;

    create table practices (
      id   uuid primary key default gen_random_uuid(),
      name text not null
    );

    create table providers (
      id          uuid primary key default gen_random_uuid(),
      practice_id uuid not null references practices (id),
      name        text not null,
      email       text not null unique
    );

    create table patients (
      id          uuid primary key default gen_random_uuid(),
      practice_id uuid not null references practices (id),
      name        text not null,
      email       text not null,
      ship_to     text
    );

    create table users (
      id           text primary key,
      role         text not null check (role in ('provider', 'patient', 'cerbo_admin')),
      provider_id  uuid references providers (id),
      patient_id   uuid references patients (id),
      display_name text not null
    );

    create table products (
      sku             text primary key,
      name            text not null,
      unit_cogs_cents integer not null check (unit_cogs_cents > 0),
      on_hand_qty     integer not null default 0 check (on_hand_qty >= 0),
      reserved_qty    integer not null default 0 check (reserved_qty >= 0),
      active          boolean not null default true,
      updated_at      timestamptz not null default now(),
      check (reserved_qty <= on_hand_qty)
    );
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists products;
    drop table if exists users;
    drop table if exists patients;
    drop table if exists providers;
    drop table if exists practices;
  `)
}
