// Run-due recurring cycles sweep (FR-12 AC6, docs/ARCHITECTURE.md section 10).
//
// Every `active` schedule whose `next_run_at` has passed gets one cycle run. Each
// schedule is processed in its own transaction with the schedule row locked FOR UPDATE
// and a next_run_at due re-check (in runOneSchedule), so the job is idempotent and safe
// to run concurrently with the provider "Run cycle now" action or a second sweep - a
// double-trigger for the same period still produces exactly one child order (RT-13).
//
// Follows the T3 reservation-expiry job pattern (apps/api/src/jobs/expire.ts): list
// candidates cheaply, then process each under a lock + re-check. The admin endpoint that
// invokes this (POST /api/admin/jobs/run-due-schedules) is wired in the admin/operations
// router (owned by T11); this module is the reusable function it calls.
import type { Knex } from 'knex'
import type { Seams } from '../seams/types'
import { createSeams } from '../seams'
import { runOneSchedule } from '../recurring/service'
import type { RunCycleResult } from '../recurring/types'

/**
 * Run one cycle for every schedule that is active and due as of `clock.now()`.
 * Returns the per-schedule results (created cycles, retries, and no-ops).
 */
export async function runDueSchedules(
  db: Knex,
  seams: Seams = createSeams()
): Promise<{ ran: RunCycleResult[] }> {
  const now = seams.clock.now()

  // Candidate ids first (cheap, unlocked). runOneSchedule re-reads each FOR UPDATE and
  // re-checks due/status, so the set can change under us without a double-run.
  const candidates = await db('recurring_schedules')
    .where('status', 'active')
    .andWhere((qb) => qb.whereNull('next_run_at').orWhere('next_run_at', '<=', now))
    .select('id')

  const ran: RunCycleResult[] = []
  for (const { id } of candidates as Array<{ id: string }>) {
    ran.push(await runOneSchedule(db, id, now, seams))
  }
  return { ran }
}
