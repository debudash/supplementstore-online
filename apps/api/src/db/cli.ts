// Programmatic migrate/seed runner for the db:migrate and db:seed npm scripts.
// Avoids locating the knex CLI binary across npm-workspace hoisting and runs the
// same Knex instance the server uses. Migrations/seeds are owned by T2.
import 'dotenv/config'
import { db } from './knex'

async function main(): Promise<void> {
  const cmd = process.argv[2]
  switch (cmd) {
    case 'migrate':
      await db.migrate.latest()
      console.log('[db] migrations up to date')
      break
    case 'rollback':
      await db.migrate.rollback()
      console.log('[db] rolled back last batch')
      break
    case 'seed':
      await db.seed.run()
      console.log('[db] seeds complete')
      break
    default:
      throw new Error(`Unknown db command: ${cmd ?? '(none)'} (expected migrate|rollback|seed)`)
  }
}

main()
  .then(() => db.destroy())
  .catch(async (err) => {
    console.error('[db] command failed:', err)
    await db.destroy()
    process.exit(1)
  })
