<script setup lang="ts">
// Provider payable report (FR-11). Reads GET /api/reports/payables: opening balance,
// credits (margins earned), debits (margin reversals + fee retentions), closing
// balance, and the contributing orders. Balances are derived from PROVIDER_PAYABLE
// ledger entries by the API (owed = -sum of PROVIDER_PAYABLE); the UI only displays.
// Monthly by default (current UTC month); a custom from/to range is supported.
import { onMounted, ref } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import { currentUserId } from '../../api/session'
import type { PayableReport } from '@cerbo/contracts'
import { formatCents } from '../../components/order/format'

const report = ref<PayableReport | null>(null)
const from = ref('')
const to = ref('')
const loading = ref(false)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const params = new URLSearchParams()
    if (from.value && to.value) {
      params.set('from', from.value)
      params.set('to', to.value)
    }
    const qs = params.toString()
    report.value = await apiRequest<PayableReport>(`/reports/payables${qs ? `?${qs}` : ''}`)
    from.value = report.value.period.from
    to.value = report.value.period.to
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Failed to load the payable report.'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="payables">
    <h2>Payables</h2>

    <div class="toolbar">
      <label class="field">From <input v-model="from" type="date" :disabled="loading" /></label>
      <label class="field">To <input v-model="to" type="date" :disabled="loading" /></label>
      <button type="button" :disabled="loading" @click="load">Apply</button>
    </div>

    <p v-if="error" class="page-error" role="alert">{{ error }}</p>
    <p v-if="loading" class="notice">Loading...</p>

    <template v-if="report && !loading">
      <p class="period">
        Period <strong>{{ report.period.from }}</strong> to <strong>{{ report.period.to }}</strong> (UTC).
      </p>

      <table class="report-table balance">
        <tbody>
          <tr><th>Opening balance</th><td class="num">{{ formatCents(report.openingCents) }}</td></tr>
          <tr><th>Credits (margins earned)</th><td class="num">{{ formatCents(report.creditsCents) }}</td></tr>
          <tr><th>Debits (reversals + fee retention)</th><td class="num">{{ formatCents(report.debitsCents) }}</td></tr>
          <tr class="closing"><th>Closing balance</th><td class="num">{{ formatCents(report.closingCents) }}</td></tr>
        </tbody>
      </table>

      <h3>Contributing orders</h3>
      <table class="report-table">
        <thead>
          <tr><th>Order</th><th class="num">Credits</th><th class="num">Debits</th><th class="num">Net</th></tr>
        </thead>
        <tbody>
          <tr v-for="o in report.contributingOrders" :key="o.orderId">
            <td><code>{{ o.orderId }}</code></td>
            <td class="num">{{ formatCents(o.creditsCents) }}</td>
            <td class="num">{{ formatCents(o.debitsCents) }}</td>
            <td class="num">{{ formatCents(o.netCents) }}</td>
          </tr>
          <tr v-if="report.contributingOrders.length === 0">
            <td colspan="4" class="notice">No payable movement in this period.</td>
          </tr>
        </tbody>
      </table>
    </template>

    <p class="actor-note">Acting as <code>{{ currentUserId }}</code>.</p>
  </section>
</template>

<style scoped>
.payables {
  max-width: 920px;
}
.toolbar {
  display: flex;
  gap: 1rem;
  align-items: flex-end;
  margin-bottom: 0.75rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.9em;
}
.period {
  color: #555;
}
.report-table {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 1rem;
}
.report-table th,
.report-table td {
  border: 1px solid #ddd;
  padding: 0.4rem 0.6rem;
  text-align: left;
}
.balance {
  max-width: 28rem;
}
.closing th,
.closing td {
  font-weight: 700;
  border-top: 2px solid #999;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.notice {
  color: #555;
}
.page-error {
  color: #c0392b;
  border: 1px solid #c0392b;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}
.actor-note {
  margin-top: 1.5rem;
  color: #888;
  font-size: 0.85em;
}
</style>
