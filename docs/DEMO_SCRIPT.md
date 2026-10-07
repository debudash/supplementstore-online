# DEMO_SCRIPT.md - Live walkthrough

A script you can follow live without improvising. Every step prints the number you should
see; if the screen disagrees, something is wrong and you will notice immediately. Figures
tied to an EVAL id are verified in CI against real Postgres (`tests/e2e/RESULTS.md`).

There is a **2-minute version** for short slots, then the **full walkthrough** by act.

## Before you start

1. Open the app: https://cerbo-api-production.up.railway.app (or http://localhost:5173 locally).
2. Check health: `/api/health` must return `status: ok` and `catalog: { ready: true, products: 5 }`.
3. As **Cerbo Admin** (Demo login, top right), open **Demo Data** and click **Reset demo story**
   (type `RESET`). This clears synthetic data and regenerates the same 6-month baseline and
   3-month ramp every time, so Metrics and Evidence always show the same story. Real orders
   are never touched.

Demo logins (the picker stands in for sign-in; it carries a DEMO badge):

| Role | Name | Practice |
|---|---|---|
| Provider | Dr. Ana Reyes | Riverside Integrative |
| Provider | Dr. Ben Cole | Summit DPC |
| Patient | Cara Lopez | Riverside |
| Patient | Dev Patel | Summit |
| Cerbo Admin | Cerbo Admin | - |

Seeded catalog. Cerbo sets only its cost; the provider types a dollar markup per unit and
the patient pays cost + markup + the 0.75% fee (ADR-028). There is no list price.

| Product | Cerbo cost | Stock | Use | Markup to type (patient pays) |
|---|---|---|---|---|
| Magnesium Glycinate 120ct | $14.50 | 50 | main order, recurring | $15.26 ($29.99) |
| Vitamin D3 + K2 | $11.25 | 40 | main order, margin floor, decline | $13.55 ($24.99); $0 ($11.35); $1.78 ($13.13) |
| Omega-3 Fish Oil 1000mg | $22.80 | 30 | post-fulfillment refund | $26.81 ($49.99) |
| Probiotic 50B CFU | $26.75 | 5 | low stock | $15.91 ($42.99) |
| Zinc Picolinate 30mg | $6.90 | 0 | out of stock | - |

## The 2-minute version

1. **Provider (Dr. Ana Reyes) > New order > Cara Lopez.** Add Magnesium x2 with markup
   **$15.26** and Vitamin D3 x1 with markup **$13.55**. Order summary: **Patient pays $84.97, COGS $40.25, fee $0.64, your net
   margin $44.08.** Review & send; copy the pay link.
2. **Open the pay link** (phone-sized window). One total, one button: pay **$84.97**. Receipt.
3. **Provider > Orders > the order > audit.** Invariants: all checks pass. Ledger tab: the
   payment journal balances to zero.
4. **Cerbo Admin > Evidence.** All integrity checks pass. Unit economics: at 2.9% + 30c card
   processing, Cerbo loses money on the average order at a 0.75% fee; the page shows the
   break-even fee. That is the business finding.

## Act 1 - Provider builds and sends an order (EVAL-01)

Switch to **Dr. Ana Reyes** > **New order** > choose **Cara Lopez** > **Start order**.

1. Add **Magnesium Glycinate, quantity 2**, **Your markup $15.26**. Before you add it the live
   preview reads **Patient pays $29.99 per unit (cost $14.50 + you net $15.27 + fee $0.22)**.
2. Add **Vitamin D3 + K2, quantity 1**, **Your markup $13.55** (patient pays **$24.99** per unit).

The items table and Order summary read:

| Line | Total | COGS | Fee | Net margin |
|---|---|---|---|---|
| Magnesium x2 @ $29.99 | $59.98 | $29.00 | $0.45 | $30.53 |
| Vitamin D3 x1 @ $24.99 | $24.99 | $11.25 | $0.19 | $13.55 |
| **Order** | **$84.97** | **$40.25** | **$0.64** | **$44.08** |

Talking points: the 0.75% fee is computed once on $84.97 (64c, half-up) and split 45/19 by
largest remainder, so the lines add back exactly. Every line satisfies cost + fee + margin =
total, and margin is never negative. The provider keeps the markup they typed: the order nets
$44.08 against $44.07 of markup (2 x $15.26 + $13.55); the extra cent is round-up headroom.

**Price is never typed.** The provider enters a dollar markup; the server derives the price as
cost + markup grossed up for the fee (`price = ceil((cost + markup) / (1 - 0.0075))`, a $0
markup counted as 1 cent). The preview line is the server's own calculation, the same one the
order uses.

**Change markup** on a line: on the Magnesium line click **Change markup**, type **$10.00** -
the preview reads **Patient pays $24.69 per unit** (fee $0.19, you net $10.00). Apply it to show
the line re-price, or Cancel to keep $15.26 for the rest of the walkthrough.

Click **Review & send**. The dialog lists the items and **$84.97**, and says stock is reserved
for 7 days. Confirm. The success card shows the **copyable patient pay link** (DEMO badge: in
production it is emailed or texted). You can recover it later from Orders ("Show link").

## Act 2 - Guardrails (fail on purpose)

In a new draft:

- **Low stock.** Add **Probiotic, quantity 6**. Refused with "On-hand stock cannot meet this
  quantity (available: 5). Wait for restock or reduce quantity." Quantity 5 is accepted.
- **Out of stock.** Zinc is listed but disabled ("Out of stock").
- **Margin floor.** Add **Vitamin D3, markup $0**. The patient pays **$11.35** (cost + fee + 1
  cent of rounding headroom) and the provider nets **$0.01**. Because the price is always cost +
  markup grossed up for the fee, a markup-priced line can never go below zero: a provider can
  never sell at a loss (the `MARGIN_NEGATIVE` guard still exists for legacy lines, EVAL-04).

Delete the draft from **Orders** (Delete asks for confirmation; drafts hold no stock).

## Act 3 - Patient pays (EVAL-05, EVAL-12)

Open the pay link (or **Cara Lopez > My orders > Review and pay**). The page shows who is
being paid (Dr. Ana Reyes, Riverside Integrative), the items, and one total, **$84.97**. There
is no cost, fee or margin anywhere: the patient view is a strict whitelist (EVAL-12).

Click **Pay $84.97**. Receipt with the amount, confirmation number and date paid.
- Order becomes **Paid**; stock is sold (Magnesium 50 to 48, Vitamin D3 40 to 39).
- The payment journal posts cash +$84.97, COGS -$40.25, provider payable -$44.08, platform fee
  -$0.64, and sums to zero.
- Paying twice from the same page returns the same payment (idempotency key per page load).

**Decline (optional).** The gateway stub declines exactly $13.13. Build Vitamin D3 x1 with
**markup $1.78** (patient pays $13.13), send, pay: the page shows the decline and **Try again**; the
order stays sent and nothing is posted.

## Act 4 - The audit: every cent traceable

**Dr. Ana Reyes > Orders**, click the order row. The audit page shows the patient, status and
amounts, and **Invariants: all checks pass**. Tabs:
- **Money split:** each line's total, COGS, fee and net, plus the provider's **Markup / unit**
  ($15.26 and $13.55); totals from the order record.
- **Ledger:** the payment journal with Debit and Credit columns and a **Balanced** badge.
- **Timeline:** draft, sent, paid. **Stock:** reserve at send, sale at pay.
- **Checks:** each invariant in plain English, all passing.

## Act 5 - Refunds (EVAL-07, EVAL-08)

**Patient asks.** As **Cara Lopez > My orders**, the paid order has **Request a refund** with
"Unopened products, until <date>" (30 days after payment, ADR-027). Pick a reason and tick
**The product is unopened** (required; the server refuses without it). An order paid more
than 30 days ago shows "The 30-day refund window closed" instead. Return shipping is out of
scope.

**Provider decides.** As **Dr. Ana Reyes**, the order shows **Refund requested** in Orders.
Open its audit: the request card shows the reason, "Unopened: Confirmed by the patient" and a
**Refund review link** (DEMO badge; in production it is emailed, like the patient's pay link).
Copy it into the address bar to show the review page, then **Accept and refund now** (or
**Decline** with a note). **Approve refund** on the audit page does the same. Accepting
refunds immediately through the standard refund:
- Patient gets **$84.97** back. Cerbo keeps the **$0.64** fee; the provider is debited margin
  plus fee, so the provider ends this order at **-$0.64** (ADR-012).
- Not yet fulfilled, so stock is restocked (Magnesium back to 50, Vitamin D3 to 40). A
  shipped order's return is always written off instead (ADR-013, ADR-027).
- A REFUND journal is added; the original payment journal is never edited. A second refund is
  refused.

Providers can also refund directly from the audit page (**Refund order**, reason required).

**After fulfillment (optional, EVAL-08).** Pay an Omega-3 x1 order, then **Cerbo Admin >
Operations**: look up the order, **Fulfill**, then **Refund** (reason Damaged). No restock;
Cerbo writes off the **$22.80** cost (ADR-013). This shows up on the Evidence page as refund
exposure.

## Act 6 - Provider reporting (EVAL-09b)

**Dr. Ana Reyes > Payables**, this month: Opening + Credits - Debits = Closing, with each
contributing order named by patient and linked to its audit. **Dashboard**: GMV, refunded,
settled, platform fees and net margin, all read from the ledger.

## Act 7 - Recurring orders (EVAL-11)

**Dr. Ana Reyes > Recurring**: create a schedule for Cara Lopez, Magnesium x1, **your markup
$15.26**, every 30 days. The card shows next run, the per-cycle amount at today's cost ($29.99
each, incl. your $15.26) and the authorize link. Authorize as the patient (consent checkbox; the
copy says the amount is current and can change if product costs change), then **Run cycle
now**: a paid cycle at **fee $0.22, net $15.27**.

**A cost rise passes through** (EVAL-11d, set by a test helper; there is no cost editor in the
UI): with Magnesium's cost raised to $30.00, the next cycle pays **$45.61** (fee $0.34) and the
provider still nets **$15.27**. The patient pays the new cost; the provider keeps the markup.
On-hold stories: Probiotic x6 (out of stock) or an unauthorized schedule. Each cycle is parked
**On hold** with the reason and the fix, never charged at a loss.

## Act 8 - Cerbo Admin: proof and economics

**Evidence** (first admin tab):
- **Integrity:** every journal balanced, every paid/refunded order passing its invariants,
  stock consistent, all 13 append-only database guards present, reconciliation passing.
- **Unit economics:** platform fee earned vs estimated card processing (adjustable, default
  2.9% + 30c), Cerbo's net per order and the **break-even platform fee**. Talking point: at a
  0.75% fee Cerbo loses money on a typical order once card processing is counted; options are
  raising the fee toward break-even, passing processing through, or a small-order fee.
- **Refund exposure:** refund rate, refunds paid, fees kept (provider bears), cost of goods
  written off (Cerbo bears), by reason, and Cerbo's net after write-offs.

**Metrics:** turn on **Include synthetic demo data** (a "Demo data included" banner appears),
group by **Provider**, and **Select** a provider to scope the whole report to them. Each row
shows the provider's name and full id. Reconciliation reads **Pass**. **Provider markup
(settled)** shows the markup providers earned and the average per unit ("Set by providers, not
Cerbo"); provider net margin is always at least that amount.

**Inventory:** Cerbo's unit cost and the shared stock pool; Cerbo Admin does not set a price
or see a margin percent (ADR-028). Stock restock is in its own Demo-only section.

**Operations:** look up any order (each line lists the provider's markup per unit), fulfill,
refund (reason required), each with a confirmation. The order audit shows the same markup in
its **Markup / unit** column.
**Payables:** a month can be closed only after it ends; closed statements are immutable.

## If something fails mid-demo

1. Railway dashboard **Redeploy** on the last good deployment (seconds, no rebuild).
2. Re-run the `main` pipeline in GitLab (rebuild and redeploy, a few minutes).
3. Health shows **Catalog not ready**: the database is empty or unmigrated. Restart `cerbo-api`
   on Railway; it migrates and seeds on boot (see `docs/DEPLOY.md`).
4. Wrong numbers: you are not on a freshly seeded database, or the demo story was not reset.
   Run **Reset demo story**; real orders made during the demo remain (the ledger is
   append-only by design).
5. Fallback: run locally against http://localhost:5173.
