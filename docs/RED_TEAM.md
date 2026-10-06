# RED_TEAM.md - Adversarial cases

Two kinds of red teaming: attacks on the application, and failure modes of the AI agents building it. T13 automates the RT-A cases in `tests/e2e/golden/redteam.spec.ts`. RT-B items are review checklists for the orchestrator and the human gates.

## RT-A: Application attacks
| ID | Attack | Expected defense |
|---|---|---|
| RT-01 | Provider reads or edits another provider's order by ID (IDOR) | 404 NOT_FOUND, no data leaked |
| RT-02 | Patient token brute force or token for another patient's order | Tokens are 24 random bytes; invalid token 404; no sequential IDs on patient routes |
| RT-03 | Client sends `amountCents` or price fields in pay request | Ignored; server charges snapshot subtotal |
| RT-04 | 10 parallel pay requests, same and different idempotency keys | Exactly 1 payment, 1 journal, stock decremented once |
| RT-05 | Two providers send orders for the last units concurrently | Exactly one succeeds; `reserved_qty <= on_hand_qty` always holds |
| RT-06 | Edit lines after send (direct API) | 409 ORDER_NOT_EDITABLE |
| RT-07 | Negative, zero, decimal ("29.99"), string, or huge qty and price values | 400 INVALID_INPUT; no float ever reaches money functions |
| RT-08 | Concurrent double refund | Exactly 1 refund, 1 REFUND journal |
| RT-09 | Provider calls restock, admin metrics, or demo endpoints | 403 FORBIDDEN |
| RT-10 | Patient routes or error messages leak COGS, margin, or fee | Never; whitelist serializer on patient routes |
| RT-11 | Direct SQL UPDATE or DELETE on ledger tables | Trigger raises; purge only deletes `is_synthetic` rows with session flag set |
| RT-12 | SQL injection via sku, dates, or CSV import fields | Parameterized queries only; CSV validated row by row; bad rows reported, not inserted |
| RT-13 | Recurring cycle triggered twice for the same period | One child order per schedule cycle (unique schedule_id, cycle_number) |
| RT-14 | Demo endpoints in production mode | 403 DEMO_DISABLED |
| RT-15 | Pay an expired order after reservation released | 409 ORDER_EXPIRED; no oversell |

## RT-B: AI agent failure modes (review checklist)
| ID | Failure mode | Detection |
|---|---|---|
| AI-01 | Floats for money (`price * 0.0075`, `toFixed(2)`, `Math.round` on dollars) | grep in CI: fail build on `toFixed` or `parseFloat` in money, ledger, payments, refunds, reports |
| AI-02 | Per-line fee rounding instead of order-level allocation | EVAL-01 line fees must be [45, 19] |
| AI-03 | Weakening or deleting a failing protected test, or changing expected values | CI step diffs protected paths against main; any change requires human approval label |
| AI-04 | Recomputing splits from live catalog instead of snapshots | EVAL-11d and an audit test that changes COGS after payment and expects unchanged history |
| AI-05 | UPDATE on ledger to "fix" data | DB trigger plus code review of any migration touching ledger tables |
| AI-06 | Silently adding scope (tax, shipping, styling libraries) | PR checklist against SPEC out-of-scope list |
| AI-07 | Duplicating split math in UI or reports | Code review: only `packages/money` imports allowed for split math |
| AI-08 | Mocking the database in invariant tests so constraints never run | Invariant and e2e tests must run against real Postgres in CI |
| AI-09 | bigint returned as string concatenated instead of summed | Report tests with totals above 1,000 cents across multiple rows |
| AI-10 | Reporting a task done with CI red or untested paths | Orchestrator requires CI link and test list in every completion report |
