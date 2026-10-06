# AI_LOG.md - How AI was used, what worked, where it misled

Required by the PRD deliverable. Workers append entries when they or a reviewer catch an AI mistake. The planning project proposes entries from status reports.

## Tools
| Tool | Role |
|---|---|
| Claude (claude.ai Project) | Planning: PRD intake, gap analysis, decisions, context pack, execution tracking |
| Agent Orchestrator (AO) | Project orchestrator: task delegation, worker supervision, PR/CI tracking |
| AO workers (agents and models as configured in AO) | Implementation, tests, PRs |

## Entries
| Date | Tool | Phase / task | What happened | Worked or misled | Correction |
|---|---|---|---|---|---|
| 2026-10-05 | Claude | Planning | First brainstorm went to market strategy (build vs partner, competitive posture) before grounding in the PRD, which is a scoped vertical-slice build | Misled (scope) | Re-anchored on the PRD; Phase 1 restated requirements as FR IDs before any design |
| 2026-10-05 | Claude | Phase 1 | Surfaced that the PRD does not define the fee base, fee bearer, or rounding | Worked | Decisions ADR-001 to 003 approved by owner |
| 2026-10-05 | Claude | Phase 1 | Flagged that the stock check at add-to-cart alone allows oversell while orders await payment | Worked | ADR-011: reservation at send plus recheck at pay |
| 2026-10-05 | Claude | Phase 1 | Flagged that "provider admin restock" conflicts with Cerbo holding a single inventory pool | Worked | ADR-009: restock under Cerbo Admin, demo only |
| 2026-10-05 | Claude | Phase 1 | Owner's profit formula used a single margin % across orders; flagged it misstates profit when margins vary | Worked | ADR-015: compute per order from ledger, formula as reconciliation |
| 2026-10-05 | Claude | Phase 1 | Time-box rule summed task estimates; with parallel agents the real constraint is critical path plus human review capacity | Worked | ADR-021: tier-ordered build, review concentrated on gates |
| | | | | | |
