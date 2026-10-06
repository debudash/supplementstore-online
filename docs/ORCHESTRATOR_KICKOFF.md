# ORCHESTRATOR_KICKOFF.md - Paste this into the AO project orchestrator

---

You are coordinating the build of a vertical slice for Cerbo: providers sell supplements to patients inside the EHR, patients pay Cerbo directly, and the system records an auditable money split (COGS to Cerbo, margin to the provider, 75 bps platform fee to Cerbo), plus refunds, recurring orders, inventory, reports, and a Cerbo Admin migration report. It deploys to Railway.

**Deadline:** 10 pm CST. Human review time is limited (about 2 hours total). Spend it only on gates G1 to G5.

## Read first, in order

1. `AGENTS.md` - rules for every worker. Pass it to every worker you spawn.
2. `docs/SPEC.md` - requirements (FR IDs) and out of scope
3. `docs/ARCHITECTURE.md` - data model, money algorithm, ledger, API, seams
4. `docs/DECISIONS.md` - approved decisions. Do not reopen them; if a worker hits a conflict, escalate to me
5. `docs/TASKS.md` - tasks, ownership, waves, gates
6. `docs/EVALS.md`, `docs/RED_TEAM.md`, `docs/METRICS.md` - acceptance bar

## How to run

1. Execute tasks in wave order from TASKS.md. Never start a task before its dependencies are merged.
2. Spawn one worker per task. Give each worker: its task section verbatim, AGENTS.md, and links to the relevant doc sections. Tell it explicitly which paths it owns.
3. Never run two tasks in parallel that own the same paths.
4. For gated tasks (T1, T2, T4, T5, and the final deploy), move the PR to "Needs you" and wait for my approval. Do not merge gated PRs yourself.
5. For non-gated tasks, merge when CI is green and the PR checklist from AGENTS.md section 9 is complete.
6. If CI fails, send the failure back to the same worker. After 2 failed attempts on the same issue, escalate to me with a summary.
7. If a worker proposes changing a protected file, an expected eval value, or an approved decision, stop that worker and escalate.
8. Start T12 (Railway) as soon as T0 merges so deployment risk is retired early.
9. If time runs short, finish the current wave and stop starting Tier 3 tasks (T9, T10, T11 restock). Never cut T13 or T14.

## Status report format (send to me after each merge, gate, or escalation)

```
Task: T#  | Status: working / needs-you / in-review / merged / blocked
PR: <link> | CI: green / red <link>
FR covered: FR-#, ... | EVALs passing: EVAL-#, ...
Deviations from docs: none / <list>
AI corrections this task: none / <what was wrong, how fixed>
Next: <task(s) starting>
```

## Definition of project done

- All Tier 1 and Tier 2 tasks merged; Tier 3 merged or explicitly listed as cut
- `npm run test:e2e` green in CI with EVAL and RT-A results listed
- Railway deployment live and passing G5
- README.md complete per T14
