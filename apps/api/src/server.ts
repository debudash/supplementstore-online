// Boot entrypoint (docs/DEPLOY.md): load env, run migrations to latest, seed if
// the products table is empty, serve the built SPA in production, then listen.
import path from 'node:path'
import fs from 'node:fs'
import 'dotenv/config'
import express from 'express'
import { db } from './db/knex'
import { createApp } from './app'
import { createKnexActorLoader } from './auth/loadActor'

const PORT = Number(process.env.PORT ?? 3000)

/** Run migrations, then seed only if the products table exists and is empty. */
async function migrateAndSeed(): Promise<void> {
  await db.migrate.latest()
  try {
    const hasProducts = await db.schema.hasTable('products')
    if (!hasProducts) {
      console.log('[boot] products table not present yet; skipping seed (owned by T2)')
      return
    }
    const [{ count }] = await db('products').count<{ count: string }[]>('* as count')
    if (Number(count) === 0) {
      console.log('[boot] products table empty; running seeds')
      await db.seed.run()
    } else {
      console.log(`[boot] products table has ${count} rows; skipping seed`)
    }
  } catch (err) {
    console.error('[boot] seed-if-empty check failed (continuing):', (err as Error).message)
  }
}

/** Serve the built Vue SPA from a single service in production (ADR-022). */
function serveWebDist(app: express.Express): void {
  const webDist = path.resolve(__dirname, '../../web/dist')
  if (!fs.existsSync(webDist)) {
    console.log(`[boot] web dist not found at ${webDist}; API-only mode`)
    return
  }
  app.use(express.static(webDist))
  // SPA fallback for non-API routes.
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'))
  })
  console.log(`[boot] serving SPA from ${webDist}`)
}

async function main(): Promise<void> {
  await migrateAndSeed()
  const app = createApp({ db, loadActor: createKnexActorLoader(db) })
  serveWebDist(app)
  app.listen(PORT, () => {
    console.log(`[boot] API listening on :${PORT}`)
  })
}

main().catch((err) => {
  console.error('[boot] fatal:', err)
  process.exit(1)
})
