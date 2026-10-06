<script setup lang="ts">
// Provider sales dashboard (FR-10). Reads GET /api/reports/sales; every money figure
// comes from the ledger (the API aggregates ledger_entries / refunds - the UI only
// DISPLAYS, it never computes money; AGENTS.md money rule 2). Default window is the
// current UTC month; a custom from/to range is supported. Basic table layout only.
import { onMounted, ref } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import { currentUserId } from '../../api/session'
import type { SalesReport } from '@cerbo/contracts'
import { formatCents } from '../../components/order/format'

const report = ref<SalesReport | null>(null)
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
    report.value = await apiRequest<SalesReport>(`/reports/sales${qs ? `?${qs}` : ''}`)
    // Reflect the resolved period back into the inputs (e.g. the default month).
    from.value = report.value.period.from
    to.value = report.value.period.to
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Failed to load the sales dashboard.'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="dashboard">
    <h2>Dashboard</h2>

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

      <div class="cards">
        <div class="card">
          <span class="label">GMV</span><span class="value">{{ formatCents(report.gmvCents) }}</span>
        </div>
        <div class="card">
          <span class="label">Refunded GMV</span><span class="value">{{ formatCents(report.refundedGmvCents) }}</span>
        </div>
        <div class="card">
          <span class="label">Settled GMV</span><span class="value">{{ formatCents(report.settledGmvCents) }}</span>
        </div>
        <div class="card">
          <span class="label">Platform fees</span><span class="value">{{ formatCents(report.platformFeeCents) }}</span>
        </div>
        <div class="card">
          <span class="label">Net margin (settled)</span>
          <span class="value">{{ formatCents(report.providerNetMarginCents) }}</span>
        </div>
      </div>

      <h3>Orders by status</h3>
      <table class="report-table">
        <thead>
          <tr><th>Status</th><th class="num">Count</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in report.ordersByStatus" :key="row.status">
            <td>{{ row.status }}</td>
            <td class="num">{{ row.count }}</td>
          </tr>
          <tr v-if="report.ordersByStatus.length === 0">
            <td colspan="2" class="notice">No orders in this period.</td>
          </tr>
        </tbody>
      </table>

      <h3>Units sold by SKU</h3>
      <table class="report-table">
        <thead>
          <tr><th>SKU</th><th>Name</th><th class="num">Units</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in report.unitsBySku" :key="row.sku">
            <td>{{ row.sku }}</td>
            <td>{{ row.name }}</td>
            <td class="num">{{ row.units }}</td>
          </tr>
          <tr v-if="report.unitsBySku.length === 0">
            <td colspan="3" class="notice">No units sold in this period.</td>
          </tr>
        </tbody>
      </table>
    </template>

    <p class="actor-note">Acting as <code>{{ currentUserId }}</code>.</p>
  </section>
</template>

<style scoped>
.dashboard {
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
  color: var(--muted);
}
.cards {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 1rem 0 1.5rem;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: var(--radius);
  padding: 0.75rem 1rem;
  min-width: 9.5rem;
  box-shadow: var(--shadow-sm);
}
.card .label {
  font-size: 0.78em;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.card .value {
  font-size: 1.3em;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.report-table {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.report-table th,
.report-table td {
  border-bottom: 1px solid var(--border);
  padding: 0.5rem 0.7rem;
  text-align: left;
}
.report-table tbody tr:last-child td {
  border-bottom: none;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.notice {
  color: var(--muted);
}
.actor-note {
  margin-top: 1.5rem;
  color: var(--subtle);
  font-size: 0.85em;
}
</style>
