// Knex CLI config for `db:migrate` / `db:seed`. Runtime boot uses the same config
// via src/db/knex.ts (see knexConfig). Migrations and seeds are owned by T2; this
// file only points the CLI at the (initially empty) directories.
import { knexConfig } from './src/db/knex'

export default knexConfig
