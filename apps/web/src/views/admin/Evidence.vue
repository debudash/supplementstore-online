<script setup lang="ts">
// Cerbo Admin evidence. Live integrity checks against the ledger (balanced journals,
// per-order invariants, stock consistency, append-only guards, reconciliation), plus
// the unit economics behind the business and the refund exposure.
//
// The UI only DISPLAYS (AGENTS.md money rule 2): every figure, including the estimated
// card processing cost and the break-even fee, is computed server-side. The only
// conversion here is the processing-rate INPUT ("2.9" -> 290 bps), done with integer
// string math (marginPercentToBps), never floats.
import { computed, onMounted, ref, watch } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import type { EvidenceResponse } from '@cerbo/contracts'
import { formatMoney, formatBps } from '../../utils/money'
import { marginPercentToBps } from '../../components/order/format'
import DemoBadge from '../../components/DemoBadge.vue'
import PageHeader from '../../components/ui/PageHeader.vue'
import Card from '../../components/ui/Card.vue'
import KpiCard from '../../components/ui/KpiCard.vue'
import Money from '../../components/ui/Money.vue'
import UiAlert from '../../components/ui/UiAlert.vue'
import UiField from '../../components/ui/UiField.vue'
import UiButton from '../../components/ui/UiButton.vue'
import Skeleton from '../../components/ui/Skeleton.vue'

const DEFAULT_RATE_BPS = 290
const DEFAULT_FIXED_CENTS = 30

/** 290 -> "2.90": a rate in bps shown as a percent with 2 decimals (integer math only). */
function bpsToPercentInput(bps: number): string {
  return `${Math.trunc(bps / 100)}.${String(Math.abs(bps % 100)).padStart(2, '0')}`
}

const data = ref<EvidenceResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const includeSynthetic = ref(false)

// The inputs as typed, and the values last applied (null = let the server default).
const rateInput = ref(bpsToPercentInput(DEFAULT_RATE_BPS))
const fixedInput = ref(String(DEFAULT_FIXED_CENTS))
const appliedRateBps = ref<number | null>(null)
const appliedFixedCents = ref<number | null>(null)

const rateError = computed<string | null>(() =>
  marginPercentToBps(rateInput.value) === null ? 'Enter a percent with up to 2 decimals, e.g. 2.9.' : null
)
const fixedError = computed<string | null>(() =>
  /^\d{1,6}$/.test(fixedInput.value.trim()) ? null : 'Enter a whole number of cents, e.g. 30.'
)

let requestSeq = 0

async function load(): Promise<void> {
  const seq = ++requestSeq
  loading.value = true
  error.value = null
  try {
    const params = new URLSearchParams({ includeSynthetic: String(includeSynthetic.value) })
    if (appliedRateBps.value !== null) params.set('processingRateBps', String(appliedRateBps.value))
    if (appliedFixedCents.value !== null) params.set('processingFixedCents', String(appliedFixedCents.value))
    const res = await apiRequest<EvidenceResponse>(`/admin/evidence?${params.toString()}`)
    if (seq !== requestSeq) return
    data.value = res
    rateInput.value = bpsToPercentInput(res.unitEconomics.assumptions.processingRateBps)
    fixedInput.value = String(res.unitEconomics.assumptions.processingFixedCents)
  } catch (err) {
    if (seq !== requestSeq) return
    error.value = err instanceof ApiError ? err.message : 'Failed to load the evidence.'
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function applyAssumptions(): void {
  const bps = marginPercentToBps(rateInput.value)
  if (bps === null || fixedError.value) return
  appliedRateBps.value = bps
  appliedFixedCents.value = Number(fixedInput.value.trim())
  void load()
}

watch(includeSynthetic, () => void load())
onMounted(() => void load())

const checkedAt = computed(() =>
  data.value
    ? new Date(data.value.generatedAt).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
    : ''
)

// ---- Integrity -------------------------------------------------------------------

interface Check {
  key: string
  title: string
  meaning: string
  pass: boolean
}

const checks = computed<Check[]>(() => {
  const i = data.value?.integrity
  if (!i) return []
  return [
    { key: 'journals', title: 'Ledger balanced', meaning: "Every journal's entries sum to zero", pass: i.journals.unbalanced === 0 },
    {
      key: 'orders',
      title: 'Order invariants',
      meaning: 'Each paid or refunded order passes the same checks as its audit page',
      pass: i.orders.failing === 0
    },
    { key: 'stock', title: 'Stock consistent', meaning: 'On-hand is never negative and never below reserved', pass: i.stock.issues.length === 0 },
    {
      key: 'guards',
      title: 'Append-only guards',
      meaning: 'Database triggers block edits and deletes on money records',
      pass: i.guards.missing.length === 0
    },
    { key: 'reconciliation', title: 'Reconciliation', meaning: "Ledger margin matches the owner's per-order formula", pass: i.reconciliation.pass }
  ]
})

const failedChecks = computed(() => checks.value.filter((c) => !c.pass))
const allPass = computed(() => checks.value.length > 0 && failedChecks.value.length === 0)

// ---- Unit economics --------------------------------------------------------------

const ue = computed(() => data.value?.unitEconomics ?? null)
const rateLabel = computed(() => (ue.value ? formatBps(ue.value.assumptions.processingRateBps) : '-'))
const fixedLabel = computed(() => (ue.value ? formatMoney(ue.value.assumptions.processingFixedCents) : '-'))
const losing = computed(() => !!ue.value && ue.value.perOrder.cerboNetCents < 0)
/** The absolute loss for copy: format the negative amount and drop the sign (no arithmetic). */
const lossLabel = computed(() => (ue.value ? formatMoney(ue.value.perOrder.cerboNetCents).replace(/^-/, '') : '-'))
const breakevenLabel = computed(() => formatBps(ue.value?.breakevenFeeBps ?? null))

// ---- Refund exposure -------------------------------------------------------------

const rx = computed(() => data.value?.refundExposure ?? null)

/** patient_request -> "Patient request". */
function humanizeReason(code: string): string {
  const s = code.replace(/_/g, ' ').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : code
}
</script>

<template>
  <section class="evidence">
    <PageHeader title="Evidence" subtitle="Live checks against the ledger, plus the economics behind the business.">
      <template #actions>
        <span v-if="data" class="subtle checked" data-testid="evidence-checked">Checked {{ checkedAt }}</span>
        <UiButton :busy="loading" busy-label="Refreshing..." data-testid="evidence-refresh" @click="load">Refresh</UiButton>
      </template>
    </PageHeader>

    <p class="sr-only" aria-live="polite">{{ loading ? 'Loading evidence' : data ? 'Evidence updated' : '' }}</p>

    <UiAlert v-if="error" tone="danger" title="Could not load the evidence" data-testid="evidence-error">
      {{ error }}
      <template #actions>
        <UiButton size="sm" data-testid="evidence-retry" @click="load">Retry</UiButton>
      </template>
    </UiAlert>

    <Skeleton v-if="loading && !data" :lines="6" height="1.4rem" label="Loading evidence" />

    <template v-if="data">
      <!-- a) Integrity -->
      <section class="block" aria-labelledby="integrity-h">
        <h2 id="integrity-h" class="block-title">Integrity</h2>

        <UiAlert v-if="allPass" tone="success" title="All checks pass" class="banner" data-testid="evidence-banner">
          The ledger, orders, stock, guards and reconciliation all agree.
        </UiAlert>
        <UiAlert v-else tone="danger" title="Some checks failed" class="banner" data-testid="evidence-banner">
          Failed: {{ failedChecks.map((c) => c.title).join(', ') }}.
        </UiAlert>

        <div class="check-grid">
          <Card v-for="c in checks" :key="c.key" :tone="c.pass ? 'default' : 'danger'" :data-testid="`check-${c.key}`">
            <div class="check-head">
              <h3 class="check-title">{{ c.title }}</h3>
              <span class="badge" :class="c.pass ? 'badge-success' : 'badge-danger'">{{ c.pass ? 'Pass' : 'Fail' }}</span>
            </div>
            <p class="subtle meaning">{{ c.meaning }}</p>

            <template v-if="c.key === 'journals'">
              <p class="figure">
                {{ data.integrity.journals.total }} journals, {{ data.integrity.journals.unbalanced }} unbalanced
              </p>
            </template>

            <template v-else-if="c.key === 'orders'">
              <p class="figure">
                {{ data.integrity.orders.passing }} of {{ data.integrity.orders.checked }} orders pass<span v-if="data.integrity.orders.capped"> (latest 500)</span>
              </p>
              <ul v-if="data.integrity.orders.failures.length > 0" class="issues">
                <li v-for="f in data.integrity.orders.failures" :key="f.orderId">
                  <code>{{ f.orderId }}</code>: {{ f.failedChecks.join(', ') }}
                </li>
              </ul>
            </template>

            <template v-else-if="c.key === 'stock'">
              <p class="figure">
                {{ data.integrity.stock.issues.length === 0 ? 'No stock issues' : `${data.integrity.stock.issues.length} issue(s)` }}
              </p>
              <ul v-if="data.integrity.stock.issues.length > 0" class="issues">
                <li v-for="s in data.integrity.stock.issues" :key="s.sku">
                  <code>{{ s.sku }}</code>: on hand {{ s.onHandQty }}, reserved {{ s.reservedQty }}
                </li>
              </ul>
            </template>

            <template v-else-if="c.key === 'guards'">
              <p class="figure">{{ data.integrity.guards.present }} of {{ data.integrity.guards.expected }} in place</p>
              <ul v-if="data.integrity.guards.missing.length > 0" class="issues">
                <li v-for="g in data.integrity.guards.missing" :key="g">Missing <code>{{ g }}</code></li>
              </ul>
            </template>

            <template v-else-if="c.key === 'reconciliation'">
              <dl class="facts">
                <div><dt>Formula</dt><dd><Money :cents="data.integrity.reconciliation.formulaCents" /></dd></div>
                <div><dt>Ledger</dt><dd><Money :cents="data.integrity.reconciliation.ledgerCents" /></dd></div>
                <div><dt>Difference</dt><dd><Money :cents="data.integrity.reconciliation.diffCents" /></dd></div>
                <div><dt>Tolerance</dt><dd><Money :cents="data.integrity.reconciliation.toleranceCents" /></dd></div>
              </dl>
            </template>
          </Card>
        </div>
      </section>

      <!-- b) Unit economics -->
      <Card v-if="ue" title="Unit economics" class="block">
        <p class="lead">
          Cerbo earns the {{ formatBps(ue.assumptions.platformFeeBps) }} platform fee per order; card processing is not
          modelled in the product, so this estimates it.
        </p>

        <form class="assumptions" @submit.prevent="applyAssumptions">
          <UiField v-slot="f" label="Processing rate (%)" :error="rateError">
            <input
              :id="f.id"
              v-model="rateInput"
              type="text"
              inputmode="decimal"
              :aria-describedby="f.describedby"
              :aria-invalid="f.invalid ? 'true' : undefined"
              data-testid="evidence-rate"
            />
          </UiField>
          <UiField v-slot="f" label="Fixed fee per charge (cents)" :error="fixedError">
            <input
              :id="f.id"
              v-model="fixedInput"
              type="text"
              inputmode="numeric"
              :aria-describedby="f.describedby"
              :aria-invalid="f.invalid ? 'true' : undefined"
              data-testid="evidence-fixed"
            />
          </UiField>
          <div class="apply">
            <UiButton type="submit" variant="primary" :disabled="loading || !!rateError || !!fixedError" data-testid="evidence-apply">
              Apply
            </UiButton>
          </div>
        </form>

        <div class="synthetic" :class="{ on: includeSynthetic }">
          <label class="check-label">
            <input v-model="includeSynthetic" type="checkbox" data-testid="evidence-include-synthetic" />
            <span>Include synthetic demo data</span>
          </label>
          <DemoBadge reason="Demo affordance - synthetic rows are demonstration data, excluded by default. This mixes them in to show the demo narrative." />
        </div>

        <div class="kpi-grid">
          <KpiCard label="Paid orders" :value="ue.orderCount" />
          <KpiCard primary label="GMV" :cents="ue.gmvCents" />
          <KpiCard label="Platform fee earned" :cents="ue.platformFeeCents" />
          <KpiCard label="Est. processing cost" :cents="ue.processingCostCents" :hint="`${rateLabel} + ${fixedLabel} per charge`" />
          <KpiCard label="Cerbo net" :cents="ue.cerboNetCents" data-testid="evidence-cerbo-net" />
        </div>

        <h3 class="sub-title">Per order</h3>
        <dl class="facts per-order">
          <div><dt>Average order value</dt><dd><Money :cents="ue.perOrder.aovCents" /></dd></div>
          <div><dt>Fee per order</dt><dd><Money :cents="ue.perOrder.platformFeeCents" /></dd></div>
          <div><dt>Processing per order</dt><dd><Money :cents="ue.perOrder.processingCostCents" /></dd></div>
          <div><dt>Net per order</dt><dd><Money :cents="ue.perOrder.cerboNetCents" strong /></dd></div>
        </dl>

        <UiAlert v-if="losing" tone="warning" title="Cerbo loses money on an average order" class="callout" data-testid="evidence-callout">
          At {{ rateLabel }} + {{ fixedLabel }} per charge, Cerbo loses {{ lossLabel }} on an average order.
          Break-even platform fee: {{ breakevenLabel }}.
        </UiAlert>
        <UiAlert v-else tone="success" title="Cerbo earns money on an average order" class="callout" data-testid="evidence-callout">
          Cerbo nets {{ formatMoney(ue.perOrder.cerboNetCents) }} per average order after processing.
        </UiAlert>

        <h3 class="sub-title">Options to close the gap</h3>
        <ul class="options">
          <li>Raise the platform fee toward {{ breakevenLabel }}</li>
          <li>Pass card processing through to the patient or provider</li>
          <li>Add a fixed per-order fee for small orders</li>
        </ul>
      </Card>

      <!-- c) Refund exposure -->
      <Card v-if="rx" title="Refund exposure" class="block">
        <div class="kpi-grid">
          <KpiCard
            label="Refunds"
            :value="rx.refundCount"
            :hint="`${rx.refundRateBps === null ? '-' : formatBps(rx.refundRateBps)} of paid orders`"
          />
          <KpiCard label="Refunded to patients" :cents="rx.refundedCents" />
          <KpiCard label="Fees kept (provider bears, ADR-012)" :cents="rx.feeRetainedCents" />
          <KpiCard label="COGS written off by Cerbo (ADR-013)" :cents="rx.cogsWrittenOffCents" />
          <KpiCard label="Restocked vs written off" :value="`${rx.restockedCount} vs ${rx.writtenOffCount}`" />
        </div>

        <h3 class="sub-title">By reason</h3>
        <div class="table-wrap">
          <table class="table table-stack">
            <caption class="sr-only">Refunds by reason</caption>
            <thead>
              <tr>
                <th scope="col">Reason</th>
                <th scope="col" class="num">Count</th>
                <th scope="col" class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rx.byReason" :key="r.reasonCode">
                <td data-label="Reason">{{ humanizeReason(r.reasonCode) }}</td>
                <td data-label="Count" class="num">{{ r.count }}</td>
                <td data-label="Amount" class="num"><Money :cents="r.amountCents" /></td>
              </tr>
              <tr v-if="rx.byReason.length === 0">
                <td colspan="3" class="notice">No refunds yet.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="net-line" data-testid="evidence-net-after-writeoffs">
          Cerbo net after write-offs: <Money :cents="rx.cerboNetAfterWriteoffsCents" strong />
        </p>
        <p class="subtle small">
          Platform fees minus estimated processing minus cost of goods written off on post-fulfillment refunds.
        </p>
      </Card>
    </template>
  </section>
</template>

<style scoped>
.evidence {
  max-width: 1120px;
}
.checked {
  align-self: center;
  font-size: var(--text-sm);
}
.block {
  margin-top: var(--space-6);
}
.block:first-of-type {
  margin-top: 0;
}
.block-title {
  font-size: var(--text-xl);
  margin: 0 0 var(--space-3);
}
.banner {
  margin-bottom: var(--space-4);
  font-size: var(--text-md);
}
.check-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
  gap: var(--space-3);
}
.check-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-2);
}
.check-title {
  font-size: var(--text-md);
  margin: 0;
}
.meaning {
  margin: var(--space-1) 0 var(--space-3);
  font-size: var(--text-sm);
}
.figure {
  margin: 0;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.issues {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-5);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr));
  gap: var(--space-3);
  margin: 0;
}
.facts dt {
  font-size: var(--text-xs);
  color: var(--muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.facts dd {
  margin: var(--space-1) 0 0;
  font-size: var(--text-lg);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.per-order {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr));
}
.lead {
  margin-top: 0;
}
.assumptions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
  gap: var(--space-4);
  align-items: end;
}
.apply {
  display: flex;
}
.synthetic {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-4) 0;
  padding: var(--space-3) var(--space-4);
  border: 2px solid var(--demo-border);
  border-radius: var(--radius);
}
.synthetic.on {
  background: var(--demo-tint);
  border-color: var(--demo);
}
.check-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
  font-weight: 600;
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
  gap: var(--space-3);
}
.sub-title {
  font-size: var(--text-md);
  margin: var(--space-5) 0 var(--space-3);
}
.callout {
  margin-top: var(--space-4);
  font-size: var(--text-md);
}
.options {
  margin: 0;
  padding-left: var(--space-5);
}
.net-line {
  margin: var(--space-4) 0 var(--space-1);
  font-size: var(--text-lg);
}
.small {
  font-size: var(--text-sm);
  margin: 0;
}
</style>
