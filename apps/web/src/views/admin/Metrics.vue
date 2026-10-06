<script setup lang="ts">
// Cerbo Admin metrics (FR-13, docs/METRICS.md). Shows the headline GMV / fee / margin
// figures, the per-order reconciliation line (ADR-015), and the migration-off-
// marketplaces report, with an "include synthetic demo data" toggle (default OFF,
// EVAL-13). The UI only DISPLAYS; every figure is aggregated server-side from the ledger
// (AGENTS.md money rule 2) - no money math here.
import { onMounted, ref } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import { currentUserId } from '../../api/session'
import type { AdminMetricsResponse } from '@cerbo/contracts'
import { formatCents } from '../../components/order/format'
import DemoBadge from '../../components/DemoBadge.vue'

function currentMonthToken(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

const month = ref(currentMonthToken())
const groupBy = ref<'none' | 'month' | 'provider'>('none')
const includeSynthetic = ref(false)
const data = ref<AdminMetricsResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

/** Render integer basis points as a percent string, e.g. 12345 -> "123.45%". */
function formatBps(bps: number | null): string {
  if (bps === null) return 'n/a'
  const negative = bps < 0
  const abs = Math.abs(Math.trunc(bps))
  const whole = Math.trunc(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  return `${negative ? '-' : ''}${whole}.${frac}%`
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    // A month token -> a from/to range covering that whole UTC month.
    const [y, m] = month.value.split('-').map(Number)
    const from = `${y}-${String(m).padStart(2, '0')}-01`
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    const params = new URLSearchParams({
      from,
      to,
      groupBy: groupBy.value,
      includeSynthetic: String(includeSynthetic.value)
    })
    data.value = await apiRequest<AdminMetricsResponse>(`/admin/metrics?${params.toString()}`)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Failed to load metrics.'
    data.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="admin-metrics">
    <h2>Admin Metrics</h2>

    <div class="toolbar">
      <label class="field">
        Month (UTC)
        <input v-model="month" type="month" :disabled="loading" />
      </label>
      <label class="field">
        Group by
        <select v-model="groupBy" :disabled="loading">
          <option value="none">None</option>
          <option value="month">Month</option>
          <option value="provider">Provider</option>
        </select>
      </label>
      <label class="field checkbox">
        <input v-model="includeSynthetic" type="checkbox" :disabled="loading" />
        Include synthetic demo data
        <DemoBadge reason="Demo affordance - synthetic rows are demonstration data, excluded from metrics by default. This toggle mixes them in to show the demo narrative; real reporting runs with it off." />
      </label>
      <button type="button" :disabled="loading" @click="load">Refresh</button>
    </div>

    <p v-if="error" class="page-error" role="alert">{{ error }}</p>
    <p v-if="loading" class="notice">Loading...</p>

    <template v-if="data && !loading">
      <p class="period">
        <strong>{{ data.period.from }}</strong> to <strong>{{ data.period.to }}</strong> (UTC) -
        synthetic data <strong>{{ data.includeSynthetic ? 'included' : 'excluded' }}</strong>
      </p>

      <h3>Headline</h3>
      <table class="report-table">
        <tbody>
          <tr><th>Total GMV</th><td class="num">{{ formatCents(data.headline.gmvCents) }}</td></tr>
          <tr><th>Refunded GMV</th><td class="num">{{ formatCents(data.headline.refundedGmvCents) }}</td></tr>
          <tr><th>Settled GMV</th><td class="num">{{ formatCents(data.headline.settledGmvCents) }}</td></tr>
          <tr><th>Platform fee revenue</th><td class="num">{{ formatCents(data.headline.platformFeeCents) }}</td></tr>
          <tr><th>Sunk fees on refunded GMV</th><td class="num">{{ formatCents(data.headline.sunkFeeCents) }}</td></tr>
          <tr><th>Provider net margin (settled)</th><td class="num">{{ formatCents(data.headline.providerNetMarginCents) }}</td></tr>
          <tr><th>Provider net after sunk fees</th><td class="num">{{ formatCents(data.headline.providerNetAfterSunkFeesCents) }}</td></tr>
          <tr><th>Paid orders</th><td class="num">{{ data.headline.orderCount }}</td></tr>
          <tr><th>AOV</th><td class="num">{{ formatCents(data.headline.aovCents) }}</td></tr>
          <tr><th>Recurring GMV</th><td class="num">{{ formatCents(data.headline.recurringGmvCents) }}</td></tr>
          <tr><th>Recurring share</th><td class="num">{{ formatBps(data.headline.recurringShareBps) }}</td></tr>
        </tbody>
      </table>

      <p class="recon" :class="data.reconciliation.pass ? 'recon-pass' : 'recon-fail'">
        Reconciliation (per-order formula vs ledger):
        <strong>{{ data.reconciliation.pass ? 'PASS' : 'FAIL' }}</strong>
        - formula {{ formatCents(data.reconciliation.formulaCents) }}, ledger
        {{ formatCents(data.reconciliation.ledgerCents) }}, diff
        {{ data.reconciliation.diffCents }} cent(s) (tolerance {{ data.reconciliation.toleranceCents }}).
      </p>

      <h3>Migration off third-party marketplaces</h3>
      <p class="period">
        Overall migration:
        <strong>{{ formatBps(data.migration.overallMigrationBps) }}</strong>
        (in-house {{ formatCents(data.migration.overallInHouseGmvCents) }} vs baseline monthly
        {{ formatCents(data.migration.overallBaselineMonthlyGmvCents) }}); adoption
        <strong>{{ formatBps(data.migration.adoptionBps) }}</strong>.
      </p>
      <table class="report-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th class="num">Baseline monthly</th>
            <th class="num">In-house GMV</th>
            <th class="num">Migration %</th>
            <th>Adopted</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in data.migration.providers" :key="p.providerId">
            <td><code>{{ p.providerId }}</code></td>
            <td class="num">{{ formatCents(p.baselineMonthlyGmvCents) }}</td>
            <td class="num">{{ formatCents(p.inHouseGmvCents) }}</td>
            <td class="num">{{ formatBps(p.migrationBps) }}</td>
            <td>{{ p.adopted ? 'yes' : 'no' }}</td>
          </tr>
          <tr v-if="data.migration.providers.length === 0">
            <td colspan="5" class="notice">No providers with a baseline in scope.</td>
          </tr>
        </tbody>
      </table>
      <p v-if="data.migration.noBaselineProviderIds.length > 0" class="notice">
        Providers with in-house activity but no baseline (excluded from migration %):
        <code>{{ data.migration.noBaselineProviderIds.join(', ') }}</code>
      </p>

      <template v-if="data.groups.length > 0">
        <h3>Breakdown by {{ data.groupBy }}</h3>
        <table class="report-table">
          <thead>
            <tr>
              <th>{{ data.groupBy === 'month' ? 'Month' : 'Provider' }}</th>
              <th class="num">GMV</th>
              <th class="num">Settled</th>
              <th class="num">Fee rev.</th>
              <th class="num">Net margin</th>
              <th class="num">Orders</th>
              <th>Reconc.</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in data.groups" :key="g.key">
              <td><code>{{ g.key }}</code></td>
              <td class="num">{{ formatCents(g.block.gmvCents) }}</td>
              <td class="num">{{ formatCents(g.block.settledGmvCents) }}</td>
              <td class="num">{{ formatCents(g.block.platformFeeCents) }}</td>
              <td class="num">{{ formatCents(g.block.providerNetMarginCents) }}</td>
              <td class="num">{{ g.block.orderCount }}</td>
              <td :class="g.reconciliation.pass ? 'recon-pass' : 'recon-fail'">
                {{ g.reconciliation.pass ? 'pass' : 'fail' }}
              </td>
            </tr>
          </tbody>
        </table>
      </template>
    </template>

    <p class="actor-note">Acting as <code>{{ currentUserId }}</code>.</p>
  </section>
</template>

<style scoped>
.admin-metrics {
  max-width: 980px;
}
.toolbar {
  display: flex;
  gap: 1rem;
  align-items: flex-end;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85em;
  color: var(--muted);
}
.field.checkbox {
  flex-direction: row;
  align-items: center;
  gap: 0.4rem;
}
.period {
  color: var(--muted);
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
.recon {
  border-radius: var(--radius-sm);
  padding: 0.5rem 0.75rem;
  margin-bottom: 1rem;
  border: 1px solid transparent;
}
.recon-pass {
  color: var(--success);
  background: var(--success-tint);
  border-color: var(--success);
}
.recon-fail {
  color: var(--danger);
  background: var(--danger-tint);
  border-color: var(--danger);
  font-weight: 700;
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
