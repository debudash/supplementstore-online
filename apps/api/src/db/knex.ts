// Knex instance and shared config. Migrations/seeds directories are owned by T2;
// this file only configures Knex to point at them and installs pg type parsers.
import path from 'node:path'
import knexLib, { Knex } from 'knex'
import { installPgTypeParsers } from './types'

installPgTypeParsers()

const pgSsl = (process.env.PGSSL ?? 'false').toLowerCase() === 'true'

/** Shared Knex config used by both runtime boot and the Knex CLI (knexfile.ts). */
export const knexConfig: Knex.Config = {
  client: 'pg',
  connection: process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: pgSsl ? { rejectUnauthorized: false } : undefined
      }
    : undefined,
  pool: { min: 0, max: 10 },
  migrations: {
    // __dirname resolves to src/db in dev (tsx) and dist/db in production (node).
    directory: path.join(__dirname, 'migrations'),
    loadExtensions: ['.js', '.ts'],
    extension: 'ts'
  },
  seeds: {
    directory: path.join(__dirname, 'seeds'),
    loadExtensions: ['.js', '.ts']
  }
}

let instance: Knex | null = null

/** Lazily create and cache the shared Knex instance. */
export function getDb(): Knex {
  if (!instance) {
    instance = knexLib(knexConfig)
  }
  return instance
}

/** Default shared instance for convenience imports. */
export const db: Knex = getDb()
