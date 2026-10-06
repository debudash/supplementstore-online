<script setup lang="ts">
// Per-order audit view (FR-7 AC2). Renders GET /api/orders/:id/audit: order snapshot,
// lines with every amount, status history, payments, refunds, journals with per-line
// ledger entries, inventory movements, and the INVARIANTS block (each check pass/fail)
// - the point of this screen (cogs + fee + margin = total per order and per line, and
// every journal sums to zero; money rules 5 and 7).
//
// Money is DISPLAY-only: every amount is integer cents from the server, formatted at
// the last moment. The journal sum and each invariant result come from the server
// (entrySumCents, sumsToZero, invariants.checks) - nothing is recomputed in JS.
import { onMounted, ref, computed } from 'vue'
import { useRoute } from 'vue-router'
import { apiRequest, ApiError } from '../../api/client'
import type { AuditResponse, AuditJournal, AuditLedgerEntry } from '@cerbo/contracts'
import { formatCents } from '../../components/order/format'
import CopyLink from '../../components/order/CopyLink.vue'

const route = useRoute()
const orderId = computed(() => String(route.params.id))

const audit = ref<AuditResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  audit.value = null
  try {
    audit.value = await apiRequest<AuditResponse>(`/orders/${orderId.value}/audit`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      error.value = 'Order not found, or it is not one of yours.'
    } else {
      error.value = err instanceof ApiError ? err.message : 'Failed to load the audit.'
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)

const invariants = computed(() => audit.value?.invariants ?? null)

/** Label a ledger entry's line by its SKU and position for readability. */
const lineLabel = computed<(e: AuditLedgerEntry) => string>(() => {
  const byId = new Map((audit.value?.lines ?? []).map((l) => [l.id, l]))
  return (e) => {
    if (!e.lineId) return 'order'
    const line = byId.get(e.lineId)
    return line ? `${line.sku} #${line.position}` : e.lineId
  }
})

/** Format a cents value that may be null (unset until send). */
function money(value: number | null): string {
  return value === null ? '-' : formatCents(value)
}
function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '-'
}
function journalRef(j: AuditJournal): string {
  return `${j.type}${j.isSynthetic ? ' (synthetic)' : ''}`
}
</script>

<template>
  <section class="audit">
    <h2>Order Audit</h2>
    <p class="order-id">Order <code>{{ orderId }}</code></p>

    <p v-if="loading" class="notice">Loading audit...</p>
    <p v-else-if="error" class="page-error" role="alert">{{ error }}</p>

    <div v-else-if="audit" class="sections">
      <!-- Invariants (FR-7 AC1) - the point of this screen -->
      <section class="block invariants-block" :class="invariants?.ok ? 'ok-border' : 'bad-border'">
        <h3>
          Invariants
          <span v-if="invariants" :class="invariants.ok ? 'ok' : 'bad'" data-test="invariants-overall">
            {{ invariants.ok ? 'ALL PASS' : 'FAILURES PRESENT' }}
          </span>
        </h3>
        <ul v-if="invariants && invariants.checks.length" class="invariants">
          <li v-for="(c, i) in invariants.checks" :key="i" :class="c.pass ? 'ok' : 'bad'">
            <span class="mark">{{ c.pass ? 'PASS' : 'FAIL' }}</span>
            <span class="iname">{{ c.name }}</span>
            <code v-if="!c.pass && c.detail" class="detail">{{ JSON.stringify(c.detail) }}</code>
          </li>
        </ul>
        <p v-else class="notice">No invariant checks reported.</p>
      </section>

      <!-- Order snapshot -->
      <section class="block">
        <h3>Order</h3>
        <dl class="kv">
          <div><dt>Status</dt><dd>{{ audit.order.status }}</dd></div>
          <div><dt>Kind</dt><dd>{{ audit.order.kind }}</dd></div>
          <div><dt>Subtotal</dt><dd>{{ money(audit.order.subtotalCents) }}</dd></div>
          <div><dt>COGS</dt><dd>{{ money(audit.order.cogsCents) }}</dd></div>
          <div><dt>Fee</dt><dd>{{ money(audit.order.feeCents) }}</dd></div>
          <div><dt>Margin</dt><dd>{{ money(audit.order.marginCents) }}</dd></div>
          <div><dt>Sent</dt><dd>{{ when(audit.order.sentAt) }}</dd></div>
          <div><dt>Paid</dt><dd>{{ when(audit.order.paidAt) }}</dd></div>
          <div v-if="audit.order.refundedAt"><dt>Refunded</dt><dd>{{ when(audit.order.refundedAt) }}</dd></div>
        </dl>
        <CopyLink v-if="audit.order.payPath" :payUrl="audit.order.payPath" />
      </section>

      <!-- Status history -->
      <section class="block">
        <h3>Status history</h3>
        <table v-if="audit.statusHistory.length" class="data">
          <thead><tr><th>From</th><th>To</th><th>At</th><th>Note</th></tr></thead>
          <tbody>
            <tr v-for="(e, i) in audit.statusHistory" :key="i">
              <td>{{ e.fromStatus ?? '-' }}</td>
              <td>{{ e.toStatus }}</td>
              <td>{{ when(e.at) }}</td>
              <td>{{ e.note ?? '-' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="notice">No status events.</p>
      </section>

      <!-- Lines with every amount -->
      <section class="block">
        <h3>Lines</h3>
        <table v-if="audit.lines.length" class="data">
          <thead><tr><th>SKU</th><th>Qty</th><th>Unit price</th><th>Total</th><th>COGS</th><th>Fee</th><th>Margin</th></tr></thead>
          <tbody>
            <tr v-for="l in audit.lines" :key="l.id">
              <td>{{ l.sku }}</td>
              <td class="num">{{ l.qty }}</td>
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

      <!-- Journals with per-line entries (ARCHITECTURE section 5) -->
      <section class="block">
        <h3>Journals</h3>
        <div v-if="audit.journals.length">
          <div v-for="j in audit.journals" :key="j.id" class="journal">
            <h4>
              {{ journalRef(j) }} <small>{{ when(j.postedAt) }}</small>
              <span :class="j.sumsToZero ? 'ok' : 'bad'" data-test="journal-sum">
                sum {{ formatCents(j.entrySumCents) }} {{ j.sumsToZero ? '(balanced)' : '(NOT ZERO)' }}
              </span>
            </h4>
            <table class="data">
              <thead><tr><th>Account</th><th>Line</th><th>Amount</th><th>Memo</th></tr></thead>
              <tbody>
                <tr v-for="e in j.entries" :key="e.id">
                  <td>{{ e.account }}</td>
                  <td>{{ lineLabel(e) }}</td>
                  <td class="num">{{ formatCents(e.amountCents) }}</td>
                  <td>{{ e.memo ?? '-' }}</td>
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
        <table v-if="audit.payments.length" class="data">
          <thead><tr><th>Amount</th><th>Gateway ref</th><th>Idempotency key</th><th>Created</th></tr></thead>
          <tbody>
            <tr v-for="p in audit.payments" :key="p.id">
              <td class="num">{{ money(p.amountCents) }}</td>
              <td>{{ p.gatewayRef ?? '-' }}</td>
              <td><code>{{ p.idempotencyKey }}</code></td>
              <td>{{ when(p.createdAt) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="notice">No payments.</p>
      </section>

      <!-- Refunds -->
      <section class="block">
        <h3>Refunds</h3>
        <table v-if="audit.refunds.length" class="data">
          <thead><tr><th>Amount</th><th>Reason</th><th>Fee retained</th><th>Restocked</th><th>Writeoff COGS</th><th>Created</th></tr></thead>
          <tbody>
            <tr v-for="r in audit.refunds" :key="r.id">
              <td class="num">{{ money(r.amountCents) }}</td>
              <td>{{ r.reasonCode }}</td>
              <td class="num">{{ money(r.feeRetainedCents) }}</td>
              <td>{{ r.restocked ? 'yes' : 'no' }}</td>
              <td class="num">{{ money(r.writeoffCogsCents) }}</td>
              <td>{{ when(r.createdAt) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="notice">No refunds.</p>
      </section>

      <!-- Inventory movements -->
      <section class="block">
        <h3>Inventory movements</h3>
        <table v-if="audit.inventoryMovements.length" class="data">
          <thead><tr><th>SKU</th><th>On-hand delta</th><th>Reserved delta</th><th>Reason</th><th>At</th></tr></thead>
          <tbody>
            <tr v-for="m in audit.inventoryMovements" :key="m.id">
              <td>{{ m.sku }}</td>
              <td class="num">{{ m.deltaOnHand }}</td>
              <td class="num">{{ m.deltaReserved }}</td>
              <td>{{ m.reason }}</td>
              <td>{{ when(m.createdAt) }}</td>
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
  color: var(--muted);
}
.block {
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: var(--radius);
  padding: 0.85rem 1.1rem;
  margin-bottom: 1rem;
  box-shadow: var(--shadow-sm);
}
.block h3 {
  margin-top: 0;
}
/* The invariants block must read unmistakably as PASS or FAIL. */
.invariants-block {
  border-width: 2px;
}
.invariants-block.ok-border {
  border-color: var(--success);
  background: var(--success-tint);
}
.invariants-block.bad-border {
  border-color: var(--danger);
  background: var(--danger-tint);
}
.invariants-block h3 {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.invariants-block h3 span {
  font-size: 0.85rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
}
.invariants-block h3 span.ok {
  background: var(--success);
  color: #fff;
}
.invariants-block h3 span.bad {
  background: var(--danger);
  color: #fff;
}
.data {
  border-collapse: collapse;
  width: 100%;
}
.data th,
.data td {
  border-bottom: 1px solid var(--border);
  padding: 0.4rem 0.6rem;
  text-align: left;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.kv {
  display: flex;
  flex-wrap: wrap;
  gap: 1.4rem;
  margin: 0;
}
.kv div {
  display: flex;
  flex-direction: column;
}
.kv dt {
  color: var(--muted);
  font-size: 0.78em;
}
.kv dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.invariants {
  list-style: none;
  padding: 0;
  margin: 0;
}
.invariants li {
  padding: 0.25rem 0;
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
}
.mark {
  font-weight: 700;
  font-family: var(--font-mono);
  font-size: 0.8rem;
  min-width: 2.8rem;
}
.iname {
  flex: 0 0 auto;
}
.detail {
  color: var(--muted);
  font-size: 0.85em;
}
.ok {
  color: var(--success);
}
.bad {
  color: var(--danger);
}
.journal h4 {
  margin: 0.8rem 0 0.4rem;
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
  flex-wrap: wrap;
}
.notice {
  color: var(--muted);
}
</style>
