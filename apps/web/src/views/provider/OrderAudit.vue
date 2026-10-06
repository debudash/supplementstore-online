<script setup lang="ts">
// Per-order audit view (FR-7 AC2). Renders the audit payload from
// GET /api/orders/:id/audit: order snapshot, lines with every amount, status history,
// payments, refunds, journals with per-line entries, inventory movements, and the
// invariants block (each check pass/fail) - per docs/ARCHITECTURE.md sections 5 and 8
// and FR-7 AC1.
//
// IMPORTANT: this endpoint is owned by T4 and is still a 501 stub at the time of
// writing. The view degrades to a clear "not yet available" state until T4 merges;
// it does NOT fabricate journal data. The audit response contract
// (packages/contracts/src/audit.ts) also lands with T4; the shapes below mirror the
// documented fields defensively and should be replaced by that contract once merged.
import { onMounted, ref, computed } from 'vue'
import { useRoute } from 'vue-router'
import { apiRequest, ApiError } from '../../api/client'
import { formatCents } from '../../components/order/format'

interface LedgerEntry {
  account?: string
  amountCents?: number
  memo?: string | null
  lineId?: string | null
  sku?: string | null
}
interface Journal {
  id?: string
  type?: string
  postedAt?: string | null
  entries?: LedgerEntry[]
}
interface InvariantCheck {
  name?: string
  label?: string
  check?: string
  pass?: boolean
  ok?: boolean
}
interface AuditResponse {
  order?: Record<string, unknown>
  lines?: Array<Record<string, unknown>>
  statusHistory?: Array<Record<string, unknown>>
  events?: Array<Record<string, unknown>>
  payments?: Array<Record<string, unknown>>
  refunds?: Array<Record<string, unknown>>
  journals?: Journal[]
  inventoryMovements?: Array<Record<string, unknown>>
  movements?: Array<Record<string, unknown>>
  invariants?: InvariantCheck[] | Record<string, boolean | string>
}

const route = useRoute()
const orderId = computed(() => String(route.params.id))

const audit = ref<AuditResponse | null>(null)
const loading = ref(false)
const pending = ref(false) // endpoint still 501
const error = ref<string | null>(null)

async function load(): Promise<void> {
  loading.value = true
  pending.value = false
  error.value = null
  audit.value = null
  try {
    audit.value = await apiRequest<AuditResponse>(`/orders/${orderId.value}/audit`)
  } catch (err) {
    if (err instanceof ApiError && (err.status === 501 || err.code === 'NOT_IMPLEMENTED')) {
      pending.value = true
    } else {
      error.value = err instanceof ApiError ? err.message : 'Failed to load the audit.'
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)

/** Normalise the invariants block (array or object map) into a uniform list. */
const invariantList = computed<Array<{ label: string; pass: boolean }>>(() => {
  const inv = audit.value?.invariants
  if (!inv) return []
  if (Array.isArray(inv)) {
    return inv.map((c) => ({
      label: c.label ?? c.name ?? c.check ?? 'check',
      pass: (c.pass ?? c.ok) === true
    }))
  }
  return Object.entries(inv).map(([label, v]) => ({
    label,
    pass: v === true || v === 'pass'
  }))
})
const allPass = computed(() => invariantList.value.length > 0 && invariantList.value.every((c) => c.pass))

const statusHistory = computed(() => audit.value?.statusHistory ?? audit.value?.events ?? [])
const movements = computed(() => audit.value?.inventoryMovements ?? audit.value?.movements ?? [])
const linesC = computed(() => audit.value?.lines ?? [])
const journalsC = computed(() => audit.value?.journals ?? [])
const paymentsC = computed(() => audit.value?.payments ?? [])
const refundsC = computed(() => audit.value?.refunds ?? [])

/** Format a value that is a money cents number, otherwise echo it as text. */
function cell(value: unknown): string {
  if (typeof value === 'number') return String(value)
  if (value === null || value === undefined) return '-'
  return String(value)
}
function money(value: unknown): string {
  return typeof value === 'number' ? formatCents(value) : '-'
}
function journalSum(j: Journal): number {
  return (j.entries ?? []).reduce((acc, e) => acc + (typeof e.amountCents === 'number' ? e.amountCents : 0), 0)
}
</script>

<template>
  <section class="audit">
    <h2>Order Audit</h2>
    <p class="order-id">Order <code>{{ orderId }}</code></p>

    <p v-if="loading" class="notice">Loading audit...</p>

    <div v-else-if="pending" class="pending" role="status">
      <h3>Audit not yet available</h3>
      <p>
        The audit endpoint (GET /api/orders/:id/audit) is not implemented yet - it is
        delivered by the payment and ledger task (T4). Once that lands, this view will
        show the order snapshot, journals, and invariant checks. Nothing is fabricated
        here in the meantime.
      </p>
      <button type="button" @click="load">Retry</button>
    </div>

    <p v-else-if="error" class="page-error" role="alert">{{ error }}</p>

    <div v-else-if="audit" class="sections">
      <!-- Invariants (FR-7 AC1): each check pass/fail explicitly -->
      <section class="block">
        <h3>Invariants <span v-if="invariantList.length" :class="allPass ? 'ok' : 'bad'">{{ allPass ? 'all pass' : 'FAILURES' }}</span></h3>
        <ul v-if="invariantList.length" class="invariants">
          <li v-for="(c, i) in invariantList" :key="i" :class="c.pass ? 'ok' : 'bad'">
            <span class="mark">{{ c.pass ? 'PASS' : 'FAIL' }}</span> {{ c.label }}
          </li>
        </ul>
        <p v-else class="notice">No invariant checks reported.</p>
      </section>

      <!-- Status history -->
      <section class="block">
        <h3>Status history</h3>
        <table v-if="statusHistory.length" class="data">
          <thead><tr><th>From</th><th>To</th><th>At</th><th>Note</th></tr></thead>
          <tbody>
            <tr v-for="(e, i) in statusHistory" :key="i">
              <td>{{ cell(e.fromStatus ?? e.from_status) }}</td>
              <td>{{ cell(e.toStatus ?? e.to_status) }}</td>
              <td>{{ cell(e.at) }}</td>
              <td>{{ cell(e.note) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="notice">No status events.</p>
      </section>

      <!-- Lines with every amount -->
      <section class="block">
        <h3>Lines</h3>
        <table v-if="linesC.length" class="data">
          <thead><tr><th>SKU</th><th>Qty</th><th>Price</th><th>Total</th><th>COGS</th><th>Fee</th><th>Margin</th></tr></thead>
          <tbody>
            <tr v-for="(l, i) in linesC" :key="i">
              <td>{{ cell(l.sku) }}</td>
              <td class="num">{{ cell(l.qty) }}</td>
              <td class="num">{{ money(l.unitPriceCents) }}</td>
              <td class="num">{{ money(l.lineTotalCents) }}</td>
              <td class="num">{{ money(l.lineCogsCents) }}</td>
              <td class="num">{{ money(l.lineFeeCents) }}</td>
              <td class="num">{{ money(l.lineMarginCents) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="notice">No lines.</p>
      </section>

      <!-- Journals with per-line entries (section 5) -->
      <section class="block">
        <h3>Journals</h3>
        <div v-if="journalsC.length">
          <div v-for="(j, i) in journalsC" :key="j.id ?? i" class="journal">
            <h4>{{ cell(j.type) }} <small>{{ cell(j.postedAt) }}</small> - sum {{ formatCents(journalSum(j)) }}</h4>
            <table class="data">
              <thead><tr><th>Account</th><th>SKU/Line</th><th>Amount</th><th>Memo</th></tr></thead>
              <tbody>
                <tr v-for="(e, k) in (j.entries ?? [])" :key="k">
                  <td>{{ cell(e.account) }}</td>
                  <td>{{ cell(e.sku ?? e.lineId) }}</td>
                  <td class="num">{{ money(e.amountCents) }}</td>
                  <td>{{ cell(e.memo) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <p v-else class="notice">No journals posted yet.</p>
      </section>

      <!-- Payments -->
      <section class="block">
        <h3>Payments</h3>
        <table v-if="paymentsC.length" class="data">
          <thead><tr><th>Amount</th><th>Gateway ref</th><th>Created</th></tr></thead>
          <tbody>
            <tr v-for="(p, i) in paymentsC" :key="i">
              <td class="num">{{ money(p.amountCents) }}</td>
              <td>{{ cell(p.gatewayRef ?? p.gateway_ref) }}</td>
              <td>{{ cell(p.createdAt ?? p.created_at) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="notice">No payments.</p>
      </section>

      <!-- Refunds -->
      <section class="block">
        <h3>Refunds</h3>
        <table v-if="refundsC.length" class="data">
          <thead><tr><th>Amount</th><th>Reason</th><th>Restocked</th><th>Created</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in refundsC" :key="i">
              <td class="num">{{ money(r.amountCents) }}</td>
              <td>{{ cell(r.reasonCode ?? r.reason_code) }}</td>
              <td>{{ cell(r.restocked) }}</td>
              <td>{{ cell(r.createdAt ?? r.created_at) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="notice">No refunds.</p>
      </section>

      <!-- Inventory movements -->
      <section class="block">
        <h3>Inventory movements</h3>
        <table v-if="movements.length" class="data">
          <thead><tr><th>SKU</th><th>On-hand delta</th><th>Reserved delta</th><th>Reason</th><th>At</th></tr></thead>
          <tbody>
            <tr v-for="(m, i) in movements" :key="i">
              <td>{{ cell(m.sku) }}</td>
              <td class="num">{{ cell(m.deltaOnHand ?? m.delta_on_hand) }}</td>
              <td class="num">{{ cell(m.deltaReserved ?? m.delta_reserved) }}</td>
              <td>{{ cell(m.reason) }}</td>
              <td>{{ cell(m.createdAt ?? m.created_at) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="notice">No inventory movements.</p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.audit {
  max-width: 920px;
}
.order-id {
  color: #555;
}
.block {
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
}
.block h3 {
  margin-top: 0;
}
.pending {
  border: 1px solid #b9770e;
  border-radius: 6px;
  padding: 1rem;
  background: #fff8ec;
}
.data {
  border-collapse: collapse;
  width: 100%;
}
.data th,
.data td {
  border: 1px solid #e0e0e0;
  padding: 0.3rem 0.5rem;
  text-align: left;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.invariants {
  list-style: none;
  padding: 0;
  margin: 0;
}
.invariants li {
  padding: 0.15rem 0;
}
.mark {
  font-weight: 700;
  font-family: monospace;
}
.ok {
  color: #2d7d46;
}
.bad {
  color: #c0392b;
}
.journal h4 {
  margin: 0.5rem 0 0.3rem;
}
.notice {
  color: #666;
}
.page-error {
  color: #c0392b;
  border: 1px solid #c0392b;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}
</style>
