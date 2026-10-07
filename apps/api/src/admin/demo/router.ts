// Cerbo Admin baseline + demo data routes (FR-14, docs/ARCHITECTURE.md section 8).
// Paths relative to /api/admin; mounted behind demoUser + requireRole('cerbo_admin').
//
// DEMO_MODE gate (FR-14 AC5, EVAL-15, RT-14): the synthetic generators and the reset are
// demo instrumentation and carry demoModeGuard, so they return 403 DEMO_DISABLED unless
// DEMO_MODE=true. The CSV baseline import is the real interim import mechanism (ADR-018),
// NOT a demo generator, so it is admin-only but not demo-gated (EVAL-15 scopes the gate
// to /api/admin/demo/*).
import { Router, type Request, type Response } from 'express'
import { db } from '../../db/knex'
import { ApiError, handleError, invalidInput } from '../errors'
import { demoModeGuard } from './config'
import { importBaselineCsv, regenerateSyntheticBaseline } from './baseline'
import { generateMigration } from './migration'
import { resetDemoData } from './reset'

export const adminDemoRouter: Router = Router()

/** Validate an optional integer body field with a default and bounds. */
function intField(value: unknown, field: string, def: number, min: number, max: number): number {
  if (value === undefined || value === null) return def
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidInput(`${field} must be an integer in [${min}, ${max}]`, { field, value })
  }
  return value
}

// Real interim baseline import (not demo-gated). CSV text arrives as a JSON string field.
adminDemoRouter.post('/baseline/import', async (req: Request, res: Response) => {
  try {
    res.status(201).json(await importBaselineCsv(db, req.body?.csv))
  } catch (err) {
    handleError(res, err)
  }
})

// Demo-only: regenerate the synthetic baseline (seed, months default 6).
adminDemoRouter.post('/demo/baseline/regenerate', demoModeGuard, async (req: Request, res: Response) => {
  try {
    const seed = intField(req.body?.seed, 'seed', 1337, 0, 2_000_000_000)
    const months = intField(req.body?.months, 'months', 6, 1, 60)
    res.status(201).json(await regenerateSyntheticBaseline(db, seed, months))
  } catch (err) {
    handleError(res, err)
  }
})

// Demo-only: generate synthetic in-house migration activity (seed, months default 3).
adminDemoRouter.post('/demo/migration/generate', demoModeGuard, async (req: Request, res: Response) => {
  try {
    const seed = intField(req.body?.seed, 'seed', 4242, 0, 2_000_000_000)
    const months = intField(req.body?.months, 'months', 3, 1, 60)
    res.status(201).json(await generateMigration(db, seed, months))
  } catch (err) {
    handleError(res, err)
  }
})

/** Real (non-synthetic) money rows attached to synthetic orders: these block a purge. */
async function unpurgeableRows(): Promise<{ journals: number; payments: number; refunds: number; total: number }> {
  const count = async (table: string): Promise<number> => {
    const [row] = await db(`${table} as t`)
      .join('orders as o', 'o.id', 't.order_id')
      .where('o.is_synthetic', true)
      .where('t.is_synthetic', false)
      .count<{ count: string }[]>('* as count')
    return Number(row?.count ?? 0)
  }
  const [journals, payments, refunds] = await Promise.all([count('journals'), count('payments'), count('refunds')])
  return { journals, payments, refunds, total: journals + payments + refunds }
}

/** The standard demo story's fixed seeds, so every reset produces the same numbers. */
export const DEMO_STORY = { baselineSeed: 1337, baselineMonths: 6, migrationSeed: 4242, migrationMonths: 3 }

// Demo-only, one click: purge synthetic data, then regenerate the standard story (6 months
// of marketplace baseline + 3 months of ramping in-house activity) with fixed seeds. Real
// orders are never touched (the ledger is append-only; only synthetic rows are purged).
adminDemoRouter.post('/demo/reset-story', demoModeGuard, async (_req: Request, res: Response) => {
  try {
    // The purge only removes synthetic money rows (DB-enforced). A REAL journal or payment
    // attached to a synthetic order can never be removed, so the purge would fail on a
    // foreign key. Detect that up front and say so plainly instead of returning a 500.
    const blocking = await unpurgeableRows()
    if (blocking.total > 0) {
      throw new ApiError(
        'DEMO_RESET_BLOCKED',
        'Some synthetic demo orders have real money records attached, so they cannot be purged. Nothing was changed.',
        blocking
      )
    }
    const reset = await resetDemoData(db)
    const baseline = await regenerateSyntheticBaseline(db, DEMO_STORY.baselineSeed, DEMO_STORY.baselineMonths)
    const migration = await generateMigration(db, DEMO_STORY.migrationSeed, DEMO_STORY.migrationMonths)
    res.status(201).json({ story: DEMO_STORY, reset, baseline, migration })
  } catch (err) {
    handleError(res, err)
  }
})

// Demo-only: purge all synthetic rows through the single guarded path.
adminDemoRouter.post('/demo/reset', demoModeGuard, async (_req: Request, res: Response) => {
  try {
    res.status(200).json(await resetDemoData(db))
  } catch (err) {
    handleError(res, err)
  }
})
