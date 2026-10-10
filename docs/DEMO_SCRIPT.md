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
   are never touched. Demo orders are dated in the past (this month's on the 15th or two
   days before today, whichever is earlier), so they never show as today's or future orders.
   Do not use the **Generate synthetic data** card before the demo: **Regenerate baseline**
   replaces the synthetic baseline, but **Generate migration activity** ADDS another batch of
   demo orders on top, so the Metrics numbers stop matching the standard story until you
   reset again.

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
| Vitamin D3 + K2 | $11.25 | 40 | main order, margin floor, decline | $13.56 ($25.00); $0 ($11.34); $1.78 ($13.13) |
| Omega-3 Fish Oil 1000mg | $22.80 | 30 | post-fulfillment refund | $26.81 ($49.99) |
| Probiotic 50B CFU | $26.75 | 5 | low stock | $15.91 ($42.99) |
| Zinc Picolinate 30mg | $6.90 | 0 | out of stock | - |

## The 2-minute version

1. **Provider (Dr. Ana Reyes) > New Order > Cara Lopez.** Add Magnesium x2 with markup
   **$15.26** and Vitamin D3 x1 with markup **$13.56**. Order summary: **Patient pays $84.97, COGS $40.25, fee $0.64, your net
   margin $44.08.** Review & send; copy the pay link.
2. **Open the pay link** (phone-sized window). One total, one button: pay **$84.97**. Receipt.
3. **Provider > Orders > the order > audit.** Invariants: all checks pass. Ledger tab: the
   payment journal balances to zero.
4. **Cerbo Admin > Evidence.** All integrity checks pass. Unit economics: at 2.9% + 30c card
   processing, Cerbo loses money on the average order at a 0.75% fee; the page shows the
   break-even fee. That is the business finding.

## Act 1 - Provider builds and sends an order (EVAL-01)

Switch to **Dr. Ana Reyes** > **New Order** > choose **Cara Lopez** > **Start order**.

1. Add **Magnesium Glycinate, quantity 2**, **Your markup $15.26**. Before you add it the live
   preview reads **Patient pays $29.99 per unit (cost $14.50 + your markup $15.26 + 0.75% fee)**.
2. Add **Vitamin D3 + K2, quantity 1**, **Your markup $13.56** (patient pays **$25.00** per unit).

The items table (Unit price, Line total, COGS, Net margin - there is no per-line fee column)
and the Order summary read:

| Line | Unit price | Line total | COGS | Net margin |
|---|---|---|---|---|
| Magnesium x2 | $29.99 avg | $59.97 | $29.00 | $30.52 |
| Vitamin D3 x1 | $25.00 | $25.00 | $11.25 | $13.56 |
| **Order summary** | | **Patient pays $84.97** | **$40.25** | **$44.08** |

The Order summary also shows **Platform fee (0.75%) $0.64**, once for the whole order.

Talking points:
- **Rounded once, nothing left over.** Cost + markup comes to $84.33; the order total is
  rounded up once to **$84.97** and the 0.75% fee is rounded up once to **$0.64** - exactly
  the difference. So there is no rounding left over for anyone: the provider nets exactly
  their markup, **$44.08** (2 x $15.26 + $13.56), and Cerbo's fee is never below 0.75%.
- **The fee is shown once.** Per-line fees ($0.45 and $0.19) are stored and shown in the audit
  (Act 4), not on the builder.
- **"avg" unit price.** The $84.97 is split across the lines to the cent, so Magnesium's line is
  $59.97 for 2 units: the unit price shows **$29.99 avg**, and the line total is what is
  charged. The patient's pay page says "avg each" the same way. (A bigger example: Omega x3 at
  $10 + Magnesium x3 at $29 + Vitamin D3 x10 at $20 = patient **$545.50**, fee $4.10, provider
  exactly **$317.00**; the Vitamin D3 line is $314.86, shown as **$31.49 avg**.)

**Price is never typed.** The provider enters a dollar markup; the server prices the whole order
once: cost + markup grossed up for the fee (`total = ceil((cost + markup) / (1 - 0.0075))`, over
the whole order), fee = 0.75% of the total rounded up. The preview line is the server's own
calculation, the same one the order uses.

**Change markup** on a line: on the Magnesium line click **Change markup**, type **$10.00** -
the preview reads **Patient pays $24.69 per unit** (you net $10.00). Apply it to show the line
re-price, or Cancel to keep $15.26 for the rest of the walkthrough.

Click **Review & send**. The dialog lists the items and **$84.97**, and says stock is reserved
for 7 days. Confirm. The success card shows the **copyable patient pay link** (DEMO badge: in
production it is emailed or texted). You can recover it later from Orders ("Show link").

**Show-off: lab-informed suggestions (DEMO, ADR-029).** Under the items, the block
**Suggestions from Cara's latest labs** (DEMO - simulated labs, panel collected Sep 28, 2026)
lists Vitamin D3 + K2 (vitamin D 22 ng/mL, low - *Already on this order*), Magnesium Glycinate
(RBC magnesium 4.0 mg/dL, low), Omega-3 Fish Oil (Omega-3 Index 3.6%, low) and Zinc Picolinate
(64 ug/dL, low - *Currently out of stock*), with hs-CRP listed as normal. Add Magnesium to the
order and its line changes to "Already on this order". Talking point: read-only decision
support from fixed, explainable rules, provider-only; the panels are simulated and a real
version would come from a lab feed (README "Lab-informed suggestions (showcase)"). As Dr. Ben Cole, a draft for Dev Patel shows a
different profile (Omega-3 and gut microbiome low).

## Act 2 - Guardrails (fail on purpose)

In a new draft:

- **Low stock.** Add **Probiotic, quantity 6**. Refused with "On-hand stock cannot meet this
  quantity (available: 5). Wait for restock or reduce quantity." Quantity 5 is accepted.
- **Out of stock.** Zinc is listed but disabled ("Out of stock").
- **Margin floor.** Add **Vitamin D3, markup $0**. The patient pays **$11.34** and the line nets
  exactly **$0.00**: cost $11.25 + fee $0.09 + markup $0.00, nothing left over.
  Because the price is always cost +
  markup grossed up for the fee, a markup-priced line can never go below zero: a provider can
  never sell at a loss (the `MARGIN_NEGATIVE` guard still exists for legacy lines, EVAL-04).

Delete the draft from **Orders** (Delete asks for confirmation; drafts hold no stock).

## Act 3 - Patient pays (EVAL-05, EVAL-12)

Open the pay link (or **Cara Lopez > My Orders > Review and pay**). The page shows who is
being paid (Dr. Ana Reyes, Riverside Integrative), the items (Magnesium "Qty 2 - $29.99 avg each",
line $59.97; Vitamin D3 $25.00), and one total, **$84.97**. There
is no cost, fee or margin anywhere: the patient view is a strict whitelist (EVAL-12).

Click **Pay $84.97**. Receipt with the amount, confirmation number and date paid.
- Order becomes **Paid**; stock is sold (Magnesium 50 to 48, Vitamin D3 40 to 39).
- The payment journal posts cash +$84.97, COGS -$40.25, provider payable -$44.08, platform fee
  -$0.64, and sums to zero.
- Paying twice from the same page returns the same payment (idempotency key per page load).

**Decline (optional).** The gateway stub declines exactly $13.13. Build Vitamin D3 x1 with
**markup $1.78** (patient pays $13.13, fee $0.10), send, pay: the page shows the decline and **Try again**; the
order stays sent and nothing is posted.

## Act 4 - The audit: every cent traceable

**Dr. Ana Reyes > Orders**, click the order row. The audit page shows the patient, status and
amounts, and **Invariants: all checks pass**. Tabs:
- **Money split - "Where every cent went":** **$84.97 = cost of goods $40.25 (Cerbo) + platform
  fee $0.64 (Cerbo, 0.75% of the order rounded up to the cent) + provider markup $44.08
  (exactly as entered)**. There is no rounding row: nothing is left over. Each line shows the
  same parts: Magnesium x2 ($29.99 avg, line $59.97) = $29.00 + fee $0.45 + markup $30.52
  (2 x $15.26); Vitamin D3 ($25.00) = $11.25 + $0.19 + $13.56. The line fees ($0.45 + $0.19)
  add up to the order fee. The **Provider (markup)** column shows each line's markup as
  qty x per-unit markup (2 x $15.26). The **Checks** tab includes `order.every_cent_accounted`
  (shown as "Order every cent accounted": total = cost + fee + markup) and
  `order.price_matches_markup` (shown as "Order price matches markup": re-prices the order from
  the stored cost and markups and gets the same totals and fees), both passing.
- **Ledger:** the payment journal with Debit and Credit columns and a **Balanced** badge.
- **Timeline:** draft, sent, paid. **Stock:** reserve at send, sale at pay.
- **Checks:** each invariant in plain English, all passing.

## Act 5 - Refunds (EVAL-07, EVAL-08)

**Patient asks.** As **Cara Lopez > My Orders**, the paid order has **Request a refund** with
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
contributing order named by patient and linked to its audit. The page notes **Real orders
only**: demo data is never included, because payables are money Cerbo actually owes.

**Dashboard**: GMV, refunded, settled, platform fees and net margin, all read from the ledger,
each sale counted in the month it was paid. Real orders only by default; turn on **Include
demo data** (a "Demo data included" banner appears) to see Dr. Reyes's demo orders, and set
**From** / **To** to last month or the month before (then **Apply**) to see their sales land in
the month they were paid.

## Act 7 - Recurring orders (EVAL-11)

**Dr. Ana Reyes > Recurring**: create a schedule for Cara Lopez, Magnesium x1, **your markup
$15.26**, every 30 days. The card shows next run, the per-cycle amount at today's cost ($29.99
each, incl. your $15.26) and the authorize link. Authorize as the patient (consent checkbox; the
copy says the amount is current and can change if product costs change), then **Run cycle
now**: the toast reads "Cycle 1 paid ($29.99)." Open **Cycle 1** from the Cycles table for its
audit: **fee $0.23, net $15.26** (exactly the markup).

**A cost rise passes through** (EVAL-11d, set by a test helper; there is no cost editor in the
UI): with Magnesium's cost raised to $30.00, the next cycle pays **$45.61** (fee $0.35) and the
provider still nets **$15.26**. The patient pays the new cost; the provider keeps the markup.
On-hold stories: Probiotic x6 ("Not enough stock": only 5 on hand) or an unauthorized schedule
("Patient has not authorized"). Each cycle is parked **On hold** with the reason and the fix,
never charged at a loss.

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

**Migration leading indicator (the headline story):** on **Metrics**, turn on **Include
synthetic demo data** and click **Last 3 months**. The **Migration off third-party
marketplaces** card shows **Migration by month**: each month's in-house GMV against the
providers' 6-month marketplace baseline, climbing month over month (after a fresh Reset demo story in October 2026:
14.2% -> 27.7% -> 53.2%; the exact values shift as the month advances). That climb is the leading indicator: providers are moving volume they used to send to
marketplaces into Cerbo. The headline reads **Average monthly migration** for the range, and
each provider row shows its own trend. The data comes from **Reset demo story** (Before you
start, step 3): a seeded 6-month baseline per provider plus a 3-month in-house ramp, all marked
synthetic, so turning the switch off shows real data only.

**Metrics:** turn on **Include synthetic demo data** (a "Demo data included" banner appears),
group by **Provider**, and **Select** a provider to scope the whole report to them. Each row
shows the provider's name and full id. Reconciliation reads **Pass**. **Provider markup
(settled)** shows the markup providers earned and the average per unit ("Set by providers, not
Cerbo"); for markup-priced orders provider net margin equals that amount exactly.

**Inventory:** Cerbo's unit cost and the shared stock pool; Cerbo Admin does not set a price
or see a margin percent (ADR-028). Stock restock is in its own Demo-only section.

**Operations:** look up any order (each line lists the provider's markup per unit), fulfill,
refund (reason required), each with a confirmation. The order audit shows the same markup in
its **Provider (markup)** column (line markup, with qty x per-unit markup beneath).
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
