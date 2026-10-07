<script setup lang="ts">
// Per-order audit view (FR-7 AC2). Renders GET /api/orders/:id/audit: a summary strip
// (invariants verdict + the order's money split), then tabs for the per-line split, the
// ledger journals (Debit / Credit), the status timeline, payments and refunds, stock
// movements, and every invariant check.
//
// Money is DISPLAY-only: every amount is integer cents from the server, formatted at
// the last moment. Totals come from the order fields, and the journal sum and each
// invariant result come from the server (entrySumCents, sumsToZero, invariants.checks) -
// nothing is recomputed here. Putting a ledger entry in the Debit or Credit column by its
// sign is display placement only.
import { onMounted, ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiRequest, ApiError } from '../../api/client'
import type { AuditResponse, AuditJournal, AuditLedgerEntry, InvariantCheck, PatientView } from '@cerbo/contracts'
import CopyLink from '../../components/order/CopyLink.vue'
import PageHeader from '../../components/ui/PageHeader.vue'
import Card from '../../components/ui/Card.vue'
import Money from '../../components/ui/Money.vue'
import StatusChip from '../../components/ui/StatusChip.vue'
import UiAlert from '../../components/ui/UiAlert.vue'
import UiTabs from '../../components/ui/UiTabs.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import { formatMoney } from '../../utils/money'

const route = useRoute()
const router = useRouter() as ReturnType<typeof useRouter> | undefined
const orderId = computed(() => String(route.params.id))

const audit = ref<AuditResponse | null>(null)
const patientName = ref<string | null>(null)
const loading = ref(true)
const notFound = ref(false)
const error = ref<string | null>(null)
const tab = ref('split')

async function loadPatientName(patientId: string): Promise<void> {
  try {
    const res = await apiRequest<{ patients: PatientView[] }>('/patients')
    patientName.value = res.patients.find((p) => p.id === patientId)?.name ?? null
  } catch {
    patientName.value = null
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  notFound.value = false
  audit.value = null
  try {
    audit.value = await apiRequest<AuditResponse>(`/orders/${orderId.value}/audit`)
    // The audit carries the patient name; fall back to the roster only if it is absent.
    if (audit.value.order.patientName) patientName.value = audit.value.order.patientName
    else void loadPatientName(audit.value.order.patientId)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound.value = true
    else error.value = err instanceof ApiError ? err.message : 'Failed to load the audit.'
  } finally {
    loading.value = false
  }
}

onMounted(load)

function goOrders(e: Event): void {
  if (router?.push) {
    e.preventDefault()
    void router.push('/orders')
  }
}

const title = computed(() => (patientName.value ? `Order for ${patientName.value}` : 'Order audit'))
const invariants = computed(() => audit.value?.invariants ?? null)
const failedChecks = computed(() => invariants.value?.checks.filter((c) => !c.pass).length ?? 0)

const tabs = computed(() => {
  const a = audit.value
  return [
    { id: 'split', label: 'Money split' },
    { id: 'ledger', label: 'Ledger', badge: a?.journals.length ?? 0 },
    { id: 'timeline', label: 'Timeline' },
    { id: 'payments', label: 'Payments & refunds' },
    { id: 'stock', label: 'Stock' },
    { id: 'checks', label: 'Checks', badge: failedChecks.value ? `${failedChecks.value} failed` : undefined }
  ]
})

// ---- Formatting helpers (display only) ----

function shortDate(value: string | null): string {
  if (!value) return '-'
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
function dateTime(value: string | null): string {
  if (!value) return '-'
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}
function humanize(code: string): string {
  const s = code.replace(/[._]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const ACCOUNT_LABELS: Record<string, string> = {
  CASH_CLEARING: 'Cash clearing',
  COGS_RECOVERY: 'COGS recovery (Cerbo)',
  PROVIDER_PAYABLE: 'Provider payable',
  PLATFORM_FEE_REVENUE: 'Platform fee revenue'
}
const accountLabel = (a: string): string => ACCOUNT_LABELS[a] ?? humanize(a)

/** Formatted amount without its sign: the Debit/Credit column already says the side. */
function unsigned(cents: number): string {
  return formatMoney(cents).replace(/^-/, '')
}

const lineLabel = computed<(e: AuditLedgerEntry) => string>(() => {
  const byId = new Map((audit.value?.lines ?? []).map((l) => [l.id, l]))
  return (e) => {
    if (!e.lineId) return 'Whole order'
    const line = byId.get(e.lineId)
    return line ? `${line.name} (line ${line.position})` : e.lineId
  }
})

/** Journals grouped by type (Payment, Refund), in the server's order. */
const journalGroups = computed(() => {
  const groups: Array<{ type: string; label: string; journals: AuditJournal[] }> = []
  for (const j of audit.value?.journals ?? []) {
    let g = groups.find((x) => x.type === j.type)
    if (!g) {
      g = { type: j.type, label: j.type === 'PAYMENT' ? 'Payment' : j.type === 'REFUND' ? 'Refund' : humanize(j.type), journals: [] }
      groups.push(g)
    }
    g.journals.push(j)
  }
  return groups
})

// ---- Invariant checks ----

const CHECK_LABELS: Record<string, string> = {
  'order.split_balances': 'Order total equals COGS + fee + margin',
  'order.margin_nonnegative': 'Order margin is not negative',
  'lines.split_balances': 'Every line balances (total = COGS + fee + margin)',
  'lines.fee_allocation_sums_to_order_fee': 'Line fees add up to the order fee',
  'payment.amount_matches_subtotal': 'Payment equals the order subtotal',
  'ledger.cash_clearing_matches_subtotal': 'Cash recorded in the ledger equals the subtotal'
}
function checkLabel(c: InvariantCheck): string {
  if (CHECK_LABELS[c.name]) return CHECK_LABELS[c.name]
  if (/^journal\..+\.sums_to_zero$/.test(c.name)) {
    const type = typeof c.detail?.type === 'string' ? ` (${humanize(c.detail.type)})` : ''
    return `Journal balances to zero${type}`
  }
  return humanize(c.name)
}

const DETAIL_LABELS: Record<string, string> = {
  subtotal: 'Subtotal',
  cogs: 'COGS',
  fee: 'Fee',
  margin: 'Margin',
  lineFeeSum: 'Sum of line fees',
  orderFee: 'Order fee',
  paidTotal: 'Paid',
  cashClearing: 'Cash clearing',
  entrySumCents: 'Entry sum',
  offendingPositions: 'Lines out of balance',
  type: 'Journal type'
}
const MONEY_KEY = /(cents$|subtotal|cogs|fee|margin|total|sum|clearing)/i

function detailRows(c: InvariantCheck): Array<{ key: string; label: string; value: string; negative: boolean }> {
  return Object.entries(c.detail ?? {}).map(([key, v]) => {
    const label = DETAIL_LABELS[key] ?? humanize(key)
    if (typeof v === 'number' && MONEY_KEY.test(key)) {
      return { key, label, value: formatMoney(v), negative: v < 0 }
    }
    let value: string
    if (Array.isArray(v)) value = v.length ? v.map(String).join(', ') : 'None'
    else if (typeof v === 'string') value = key === 'type' ? humanize(v) : v
    else if (v === null || v === undefined) value = '-'
    else if (typeof v === 'object') value = JSON.stringify(v)
    else value = String(v)
    return { key, label, value, negative: false }
  })
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}
</script>

<template>
  <section class="audit">
    <PageHeader :title="title">
      <template #back><a href="/orders" data-testid="back-to-orders" @click="goOrders">← All orders</a></template>
      <template v-if="audit" #subtitle>
        <span class="sub">
          <StatusChip :status="audit.order.status" />
          <span>Created {{ shortDate(audit.order.createdAt) }}</span>
          <span v-if="audit.order.subtotalCents !== null">Patient pays <Money :cents="audit.order.subtotalCents" strong /></span>
          <span class="subtle">Order <code>{{ orderId }}</code></span>
        </span>
      </template>
    </PageHeader>

    <Skeleton v-if="loading" :lines="5" height="2.5rem" label="Loading order audit" />

    <EmptyState
      v-else-if="notFound"
      title="Order not found"
      message="It may not be one of your orders, or it no longer exists."
      data-testid="audit-not-found"
    >
      <a href="/orders" class="btn" @click="goOrders">Back to orders</a>
    </EmptyState>

    <UiAlert v-else-if="error" tone="danger" title="Could not load this audit">
      {{ error }}
      <template #actions><button type="button" class="btn-sm" data-testid="audit-retry" @click="load">Try again</button></template>
    </UiAlert>

    <template v-else-if="audit">
      <!-- Summary strip: invariants verdict + the order's split (server figures) -->
      <div class="summary" :class="invariants?.ok ? 'summary-ok' : 'summary-bad'">
        <div class="verdict">
          <span class="verdict-label">Invariants</span>
          <span
            v-if="invariants"
            class="badge"
            :class="invariants.ok ? 'badge-success' : 'badge-danger'"
            data-test="invariants-overall"
            data-testid="invariants-overall"
          >{{ invariants.ok ? '✓ All checks pass' : `✕ ${failedChecks} check${failedChecks === 1 ? '' : 's'} failed` }}</span>
          <button v-if="invariants && !invariants.ok" type="button" class="btn-link" data-testid="see-checks" @click="tab = 'checks'">See checks</button>
        </div>
        <dl class="amounts">
          <div><dt>Subtotal</dt><dd><Money :cents="audit.order.subtotalCents" /></dd></div>
          <div><dt>COGS</dt><dd><Money :cents="audit.order.cogsCents" /></dd></div>
          <div><dt>Platform fee</dt><dd><Money :cents="audit.order.feeCents" /></dd></div>
          <div><dt>Net margin</dt><dd><Money :cents="audit.order.marginCents" strong /></dd></div>
        </dl>
      </div>

      <CopyLink v-if="audit.order.payPath" :payUrl="audit.order.payPath" class="pay-link" />

      <UiTabs v-model="tab" :tabs="tabs">
        <!-- Money split per line; totals are the order's own fields -->
        <template #split>
          <EmptyState v-if="audit.lines.length === 0" title="No lines" message="This order has no items." />
          <div v-else class="table-wrap">
            <table class="table table-stack">
              <caption class="sr-only">Money split per line</caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" class="num">Qty</th>
                  <th scope="col" class="num">Unit price</th>
                  <th scope="col" class="num">Line total</th>
                  <th scope="col" class="num">COGS</th>
                  <th scope="col" class="num">Fee</th>
                  <th scope="col" class="num">Net margin</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="l in audit.lines" :key="l.id">
                  <td data-label="Item"><span class="item-name">{{ l.name }}</span> <span class="subtle">{{ l.sku }}</span></td>
                  <td data-label="Qty" class="num">{{ l.qty }}</td>
                  <td data-label="Unit price" class="num"><Money :cents="l.unitPriceCents" /></td>
                  <td data-label="Line total" class="num"><Money :cents="l.lineTotalCents" /></td>
                  <td data-label="COGS" class="num"><Money :cents="l.lineCogsCents" /></td>
                  <td data-label="Fee" class="num"><Money :cents="l.lineFeeCents" /></td>
                  <td data-label="Net margin" class="num"><Money :cents="l.lineMarginCents" /></td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="3">Order totals</td>
                  <td data-label="Line total" class="num"><Money :cents="audit.order.subtotalCents" /></td>
                  <td data-label="COGS" class="num"><Money :cents="audit.order.cogsCents" /></td>
                  <td data-label="Fee" class="num"><Money :cents="audit.order.feeCents" /></td>
                  <td data-label="Net margin" class="num"><Money :cents="audit.order.marginCents" /></td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p class="subtle help">Totals are the order's recorded figures from the server, not added up here.</p>
        </template>

        <!-- Ledger: journals grouped by type, Debit / Credit columns -->
        <template #ledger>
          <EmptyState v-if="audit.journals.length === 0" title="No journals yet" message="Journals are posted when the order is paid or refunded." />
          <div v-else class="stack">
            <p class="subtle help">Positive entries are debits and negative entries are credits. Every journal must balance to zero.</p>
            <section v-for="g in journalGroups" :key="g.type" class="stack" :aria-label="`${g.label} journals`">
              <h2 class="group-title">{{ g.label }}</h2>
              <Card v-for="j in g.journals" :key="j.id" data-testid="journal">
                <template #header>
                  <h3 class="journal-title">{{ g.label }} journal</h3>
                  <p class="subtle journal-meta">
                    Posted {{ dateTime(j.postedAt) }}
                    <span v-if="j.isSynthetic" class="badge badge-neutral">Synthetic</span>
                  </p>
                </template>
                <template #actions>
                  <span class="badge" :class="j.sumsToZero ? 'badge-success' : 'badge-danger'" data-test="journal-sum" data-testid="journal-sum">
                    {{ j.sumsToZero ? '✓ Balanced' : '✕ Not balanced' }}
                    <span class="sum">(sum {{ formatMoney(j.entrySumCents) }})</span>
                  </span>
                </template>
                <div class="table-wrap">
                  <table class="table table-stack">
                    <caption class="sr-only">{{ g.label }} journal entries</caption>
                    <thead>
                      <tr>
                        <th scope="col">Account</th>
                        <th scope="col">Line</th>
                        <th scope="col">Memo</th>
                        <th scope="col" class="num">Debit</th>
                        <th scope="col" class="num">Credit</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="e in j.entries" :key="e.id">
                        <td data-label="Account">{{ accountLabel(e.account) }}</td>
                        <td data-label="Line">{{ lineLabel(e) }}</td>
                        <td data-label="Memo">{{ e.memo ?? '-' }}</td>
                        <td data-label="Debit" class="num money">{{ e.amountCents >= 0 ? unsigned(e.amountCents) : '' }}</td>
                        <td data-label="Credit" class="num money">{{ e.amountCents < 0 ? unsigned(e.amountCents) : '' }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </Card>
            </section>
          </div>
        </template>

        <!-- Timeline -->
        <template #timeline>
          <EmptyState v-if="audit.statusHistory.length === 0" title="No status changes yet" />
          <ol v-else class="timeline">
            <li v-for="(e, i) in audit.statusHistory" :key="i" class="tl-item">
              <span class="tl-dot" aria-hidden="true" />
              <div class="tl-body">
                <div class="tl-head">
                  <StatusChip :status="e.toStatus" />
                  <span v-if="e.fromStatus" class="subtle">from <StatusChip :status="e.fromStatus" /></span>
                </div>
                <time class="subtle" :datetime="e.at">{{ dateTime(e.at) }}</time>
                <p v-if="e.note" class="tl-note">{{ e.note }}</p>
              </div>
            </li>
          </ol>
        </template>

        <!-- Payments & refunds -->
        <template #payments>
          <div class="stack">
            <section aria-labelledby="pay-title">
              <h2 id="pay-title" class="group-title">Payments</h2>
              <EmptyState v-if="audit.payments.length === 0" title="No payments yet" />
              <div v-else class="table-wrap">
                <table class="table table-stack">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Gateway reference</th>
                      <th scope="col">Idempotency key</th>
                      <th scope="col" class="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="p in audit.payments" :key="p.id">
                      <td data-label="Date">{{ dateTime(p.createdAt) }} <span v-if="p.isSynthetic" class="badge badge-neutral">Synthetic</span></td>
                      <td data-label="Gateway reference">{{ p.gatewayRef ?? '-' }}</td>
                      <td data-label="Idempotency key"><code>{{ p.idempotencyKey }}</code></td>
                      <td data-label="Amount" class="num"><Money :cents="p.amountCents" /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
            <section aria-labelledby="refund-title">
              <h2 id="refund-title" class="group-title">Refunds</h2>
              <EmptyState v-if="audit.refunds.length === 0" title="No refunds" />
              <div v-else class="table-wrap">
                <table class="table table-stack">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Reason</th>
                      <th scope="col">Restocked</th>
                      <th scope="col" class="num">Amount</th>
                      <th scope="col" class="num">Fee retained</th>
                      <th scope="col" class="num">Written-off COGS</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="r in audit.refunds" :key="r.id">
                      <td data-label="Date">{{ dateTime(r.createdAt) }}</td>
                      <td data-label="Reason">{{ humanize(r.reasonCode) }}</td>
                      <td data-label="Restocked">{{ r.restocked ? 'Yes' : 'No' }}</td>
                      <td data-label="Amount" class="num"><Money :cents="r.amountCents" /></td>
                      <td data-label="Fee retained" class="num"><Money :cents="r.feeRetainedCents" /></td>
                      <td data-label="Written-off COGS" class="num"><Money :cents="r.writeoffCogsCents" /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </template>

        <!-- Stock movements -->
        <template #stock>
          <EmptyState v-if="audit.inventoryMovements.length === 0" title="No stock movements" message="Stock is reserved when the order is sent." />
          <div v-else class="table-wrap">
            <table class="table table-stack">
              <caption class="sr-only">Inventory movements</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">SKU</th>
                  <th scope="col">Reason</th>
                  <th scope="col" class="num">On hand</th>
                  <th scope="col" class="num">Reserved</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in audit.inventoryMovements" :key="m.id">
                  <td data-label="Date">{{ dateTime(m.createdAt) }}</td>
                  <td data-label="SKU">{{ m.sku }}</td>
                  <td data-label="Reason">{{ humanize(m.reason) }}</td>
                  <td data-label="On hand" class="num">{{ signed(m.deltaOnHand) }}</td>
                  <td data-label="Reserved" class="num">{{ signed(m.deltaReserved) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <!-- Invariant checks -->
        <template #checks>
          <EmptyState v-if="!invariants || invariants.checks.length === 0" title="No checks reported" />
          <ul v-else class="checks">
            <li v-for="(c, i) in invariants.checks" :key="i" class="check" :class="{ failed: !c.pass }" data-testid="check">
              <div class="check-head">
                <span class="badge" :class="c.pass ? 'badge-success' : 'badge-danger'" data-testid="check-result">{{ c.pass ? '✓ Pass' : '✕ Fail' }}</span>
                <span class="check-name">{{ checkLabel(c) }}</span>
              </div>
              <dl v-if="c.detail && Object.keys(c.detail).length" class="check-detail">
                <div v-for="d in detailRows(c)" :key="d.key">
                  <dt>{{ d.label }}</dt>
                  <dd :class="{ 'money-negative': d.negative }">{{ d.value }}</dd>
                </div>
              </dl>
            </li>
          </ul>
        </template>
      </UiTabs>
    </template>
  </section>
</template>

<style scoped>
.sub {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  align-items: center;
}
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4) var(--space-8);
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) var(--space-5);
  margin-bottom: var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-left-width: 4px;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}
.summary-ok {
  border-left-color: var(--success);
}
.summary-bad {
  border-left-color: var(--danger);
  background: var(--danger-tint);
}
.verdict {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
  align-items: center;
}
.verdict-label {
  font-weight: 650;
}
.verdict .badge {
  font-size: var(--text-sm);
}
.amounts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-6);
  margin: 0;
}
.amounts div {
  display: flex;
  flex-direction: column;
}
.amounts dt {
  font-size: var(--text-xs);
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.amounts dd {
  margin: 0;
  font-size: var(--text-lg);
}
.pay-link {
  margin-bottom: var(--space-4);
}
.help {
  margin: var(--space-3) 0 0;
}
.item-name {
  font-weight: 600;
}
.group-title {
  font-size: var(--text-lg);
  margin: 0;
}
.journal-title {
  font-size: var(--text-md);
  margin: 0;
}
.journal-meta {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin: var(--space-1) 0 0;
}
.sum {
  font-weight: 500;
}
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  border-left: 2px solid var(--border-strong);
  margin-left: var(--space-2);
}
.tl-item {
  position: relative;
  padding: 0 0 var(--space-5) var(--space-5);
}
.tl-item:last-child {
  padding-bottom: 0;
}
.tl-dot {
  position: absolute;
  left: calc(-1 * var(--space-2) + 1px);
  top: 0.35rem;
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 50%;
  background: var(--brand);
  border: 2px solid var(--surface);
}
.tl-head {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}
.tl-body time {
  display: block;
  margin-top: var(--space-1);
}
.tl-note {
  margin: var(--space-1) 0 0;
}
.checks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.check {
  padding: var(--space-3) var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.check.failed {
  border-color: var(--danger-border);
  border-left: 4px solid var(--danger);
  background: var(--danger-tint);
}
.check-head {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
}
.check-name {
  font-weight: 600;
}
.check-detail {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-6);
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
}
.check-detail div {
  display: flex;
  gap: var(--space-2);
}
.check-detail dt {
  color: var(--muted);
}
.check-detail dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
</style>
