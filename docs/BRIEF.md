# Project Brief - ECommerce Supplement Store (Cerbo)

The original project brief and PRD as received, kept verbatim. `docs/SPEC.md` restates it as
numbered requirements (FR ids) with acceptance criteria; `docs/DECISIONS.md` records where the
brief was silent and a decision had to be made.

Platinum - Version 1 - AI-solution - Last updated 8/7/2026

## PRD

Our users are clinical providers who recommend nutritional supplements as part of patient treatment plans. Today they order those supplements through third-party marketplaces: the provider places the order on the patient's behalf, it ships to the patient, the provider pays the marketplace up front, and the patient reimburses the provider separately and out-of-band.

Today, that supply happens through third-party supplement marketplaces sitting entirely outside our EHR. The current flow looks like this:

- The provider selects supplements for a patient and places the order on the patient's behalf through an external marketplace.
- The order ships to the patient's address. The provider pays the marketplace at point of sale.
- The patient then reimburses the provider separately, through some other channel.

This creates friction at every step. The provider is fronting money and chasing reimbursement. The patient experience is disjointed and disconnected from the care they're receiving. None of it is reflected in the clinical record or the practice's financial system. And the whole transaction — including the margin and the payment — flows through systems we don't own. We're bringing this in-house. We want providers to recommend supplements to a patient directly inside our product, have the patient pay us directly, route the provider's margin to the provider, and take a 75 bps platform fee on the transaction. Assume we hold the inventory, US-only, and that regulatory/compliance is out of scope for this exercise.

Your task is to build a working vertical slice of this system: a provider assembles a supplement order for a patient, the patient pays, and the system correctly computes and records the money split.

We care far more about the integrity of the core flow and the quality of your judgment than about breadth, styling, or polish. Stub or fake anything external (payments, auth, email, shipping) — just keep the seams clean and tell us what's stubbed.

## Problem & Context

### Business Context

Supplements are a recurring, high-margin part of these practices' treatment plans — often an ongoing protocol rather than a one-off. Today that revenue leaks entirely out of our ecosystem: the clunky workflow suppresses volume, the provider-as-middleman model creates missed and delayed reimbursements, and every dollar of margin and every transaction fee accrues to a third-party platform.

By owning this flow we improve the provider and patient experience, eliminate reimbursement leakage by having patients pay directly, and capture transaction revenue (75 bps) on volume that already exists. It's a new recurring revenue line bolted onto a workflow our users already perform daily.

### Impact Metrics

The headline metric is GMV processed in-house (and the 75 bps we earn on it); the leading indicator of success is volume migrated off third-party marketplaces. Whatever you build should make those numbers something we could eventually measure cleanly.

## Requirements & Success Criteria

### Functional Requirements

1. A provider can assemble an order for a patient: select one or more supplements, set the patient-facing price (or margin) per item.
2. A patient can pay for that order (a stubbed/fake payment step is fine).
3. The system computes and persists the money split for the order: item cost (COGS), provider margin, and our 75 bps platform fee.
4. The split must be correct and auditable — we should be able to look at a paid order and see exactly where every cent went.
5. Provider dashboard to show what's been sold and update inventory

### Explicitly out of scope

1. Real payment processing, real auth, real shipping/fulfillment integrations.
2. Catalog browsing UX, search, product imagery, styling. A hardcoded or seeded list of a few supplements is fine.
3. Regulatory/compliance, tax, and shipping cost. Ignore them.
4. Multi-state, international. Assume US-only.
5. Inventory mechanics beyond what you need — assume we hold the inventory; you don't need to model warehouses or stock levels unless you want to.

We are not grading on visual design, feature breadth, or test coverage for its own sake. Build the smallest thing that proves you understand the problem, and tell us how you thought about it.

### Performance Benchmarks

What we're looking for:

- Technical judgment: sensible data model, clean seams, correct money handling, pragmatic scoping under a time box.
- Effective AI leverage: using AI to move fast and knowing when to override it.
- Clear thinking and communication: decisions and trade-offs explained crisply; honesty about limitations.

### Time Constraints

1-2 days

### Technical Contact

Make assumptions and document why you chose them

## Technology

No restrictions on what technologies are used. Off-limits tech: none.

## Submission & AI Policy

### AI Usage Documentation

Include the following:

- Key decisions you made and the trade-offs behind them.
- What you deliberately cut, and what you'd do next with more time.
- How you used AI on this: what tools, what worked, what didn't go as expected, and how you iterated when it went sideways. We're genuinely interested in this — candor about where AI misled you or where you had to course-correct is a positive signal, not a negative one.

### Required Deliverables

- Video demo
- GitHub repository
- Deployed application URL
- Documentation
- Source code
- Technical documentation
- Demo video
- AI usage log
