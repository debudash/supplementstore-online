<script setup lang="ts">
// Cerbo Admin metrics (FR-13, docs/METRICS.md). Shows the headline GMV / fee / margin
// figures, the per-order reconciliation line (ADR-015), and the migration-off-
// marketplaces report, with an "include synthetic demo data" switch (default OFF,
// EVAL-13). The UI only DISPLAYS; every figure is aggregated server-side from the ledger
// (AGENTS.md money rule 2) - no money math here.
//
// The window is two inclusive UTC calendar dates (contracts admin.ts), so the From / To
// date inputs map straight onto the endpoint's from / to query params. The default is
// the whole current UTC month, the same window the old month picker produced.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import type { AdminMetricsResponse, MetricsGroupBy } from '@cerbo/contracts'
import { formatMoney, formatBps } from '../../utils/money'
import DemoBadge from '../../components/DemoBadge.vue'
import PageHeader from '../../components/ui/PageHeader.vue'
import Card from '../../components/ui/Card.vue'
import KpiCard from '../../components/ui/KpiCard.vue'
import Money from '../../components/ui/Money.vue'
import UiAlert from '../../components/ui/UiAlert.vue'
import UiField from '../../components/ui/UiField.vue'
import UiButton from '../../components/ui/UiButton.vue'

const pad = (n: number): string => String(n).padStart(2, '0')

/** First and last day of the current UTC month as YYYY-MM-DD. */
function currentMonthRange(): { from: string; to: string } {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() + 1
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay)}` }
}

const initial = currentMonthRange()
const from = ref(initial.from)
const to = ref(initial.to)
const groupBy = ref<MetricsGroupBy>('none')
const includeSynthetic = ref(false)
const data = ref<AdminMetricsResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const rangeError = computed<string | null>(() => {
  if (!ISO_DATE.test(from.value) || !ISO_DATE.test(to.value)) return 'Enter both a From and a To date.'
  if (from.value > to.value) return 'From must be on or before To.'
  return null
})

/** Provider ids are UUIDs; show a short prefix (full id on hover). */
const shortId = (id: string): string => (id.length > 10 ? id.slice(0, 8) : id)

// Only the newest request may write the result, so a slow earlier response never
// overwrites a later one when controls change quickly.
let requestSeq = 0

async function load(): Promise<void> {
  if (rangeError.value) return
  const seq = ++requestSeq
  loading.value = true
  error.value = null
  try {
    const params = new URLSearchParams({
      from: from.value,
      to: to.value,
      groupBy: groupBy.value,
      includeSynthetic: String(includeSynthetic.value)
    })
    const res = await apiRequest<AdminMetricsResponse>(`/admin/metrics?${params.toString()}`)
    if (seq === requestSeq) data.value = res
  } catch (err) {
    if (seq !== requestSeq) return
    error.value = err instanceof ApiError ? err.message : 'Failed to load metrics.'
    data.value = null
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

// Date typing is debounced; the select and the switch reload at once.
let timer: ReturnType<typeof setTimeout> | undefined
watch([from, to], () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(load, 400)
})
watch([groupBy, includeSynthetic], () => {
  if (timer) clearTimeout(timer)
  void load()
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
onMounted(load)
</script>

<template>
  <section class="admin-metrics">
    <PageHeader title="Metrics" subtitle="Marketplace volume, fees and provider economics, read from the ledger.">
      <template #actions>
        <UiButton :busy="loading" busy-label="Refreshing..." data-testid="metrics-refresh" :disabled="!!rangeError" @click="load">
          Refresh
        </UiButton>
      </template>
    </PageHeader>

    <UiAlert v-if="includeSynthetic" tone="warning" title="Demo data included" class="demo-banner" data-testid="demo-data-banner">
      These figures mix in synthetic demonstration rows. Real reporting runs with the switch off.
    </UiAlert>

    <Card class="controls" title="Report settings">
      <div class="controls-grid">
        <UiField v-slot="f" label="From (UTC)" :error="rangeError">
          <input
            :id="f.id"
            v-model="from"
            type="date"
            :aria-describedby="f.describedby"
            :aria-invalid="f.invalid ? 'true' : undefined"
            data-testid="metrics-from"
          />
        </UiField>
        <UiField v-slot="f" label="To (UTC)">
          <input :id="f.id" v-model="to" type="date" :aria-invalid="rangeError ? 'true' : undefined" data-testid="metrics-to" />
        </UiField>
        <UiField v-slot="f" label="Group by">
          <select :id="f.id" v-model="groupBy" data-testid="metrics-group-by">
            <option value="none">No grouping</option>
            <option value="month">Month</option>
            <option value="provider">Provider</option>
          </select>
        </UiField>
      </div>

      <div class="synthetic" :class="{ on: includeSynthetic }">
        <label class="switch-label">
          <input v-model="includeSynthetic" type="checkbox" role="switch" class="switch" data-testid="include-synthetic" />
          <span class="switch-text">
            <strong>Include synthetic demo data</strong>
            <span class="subtle">{{ includeSynthetic ? 'On - demo rows are mixed in' : 'Off - real data only (default)' }}</span>
          </span>
        </label>
        <DemoBadge reason="Demo affordance - synthetic rows are demonstration data, excluded from metrics by default. This switch mixes them in to show the demo narrative; real reporting runs with it off." />
      </div>
    </Card>

    <p v-if="error" class="page-error" role="alert">{{ error }}</p>

    <p class="sr-only" aria-live="polite">{{ loading ? 'Loading metrics' : data ? 'Metrics updated' : '' }}</p>

    <template v-if="data || loading">
      <p v-if="data" class="period">
        <strong>{{ data.period.from }}</strong> to <strong>{{ data.period.to }}</strong> (UTC) - synthetic data
        <strong>{{ data.includeSynthetic ? 'included' : 'excluded' }}</strong>
      </p>

      <div class="kpi-groups" :aria-busy="loading ? 'true' : undefined">
        <Card title="Volume" subtitle="What patients paid for in this window.">
          <div class="kpi-grid">
            <KpiCard primary label="Total GMV" :cents="data?.headline.gmvCents" :loading="loading && !data" />
            <KpiCard label="Settled GMV" :cents="data?.headline.settledGmvCents" hint="Total GMV less refunds" :loading="loading && !data" />
            <KpiCard label="Refunded GMV" :cents="data?.headline.refundedGmvCents" :loading="loading && !data" />
            <KpiCard label="Paid orders" :value="data?.headline.orderCount" :loading="loading && !data" />
            <KpiCard label="Average order value" :cents="data?.headline.aovCents" :loading="loading && !data" />
            <KpiCard
              label="Recurring share"
              :value="data ? formatBps(data.headline.recurringShareBps) : undefined"
              :hint="data ? `Recurring GMV ${formatMoney(data.headline.recurringGmvCents)}` : undefined"
              :loading="loading && !data"
            />
          </div>
        </Card>

        <Card title="Fees" subtitle="Cerbo platform fee revenue.">
          <div class="kpi-grid">
            <KpiCard label="Platform fee" :cents="data?.headline.platformFeeCents" hint="Includes fees on orders later refunded" :loading="loading && !data" />
            <KpiCard
              label="Sunk fees on refunded orders"
              :cents="data?.headline.sunkFeeCents"
              hint="The platform fee is kept when an order is refunded, so the provider bears it."
              :loading="loading && !data"
            />
          </div>
        </Card>

        <Card title="Provider net" subtitle="What providers keep after cost of goods and fees.">
          <div class="kpi-grid">
            <KpiCard label="Net margin (settled)" :cents="data?.headline.providerNetMarginCents" :loading="loading && !data" />
            <KpiCard label="Net after sunk fees" :cents="data?.headline.providerNetAfterSunkFeesCents" :loading="loading && !data" />
          </div>
        </Card>
      </div>
    </template>

    <template v-if="data">
      <Card title="Reconciliation" subtitle="Per-order formula against the ledger, within 1 cent per order." class="section">
        <template #actions>
          <span class="badge recon-badge" :class="data.reconciliation.pass ? 'badge-success' : 'badge-danger'" data-testid="recon-badge">
            {{ data.reconciliation.pass ? 'Pass' : 'Fail' }}
          </span>
        </template>
        <dl class="facts">
          <div><dt>Per-order formula</dt><dd><Money :cents="data.reconciliation.formulaCents" /></dd></div>
          <div><dt>Ledger</dt><dd><Money :cents="data.reconciliation.ledgerCents" /></dd></div>
          <div><dt>Difference</dt><dd><Money :cents="data.reconciliation.diffCents" /></dd></div>
          <div><dt>Tolerance</dt><dd><Money :cents="data.reconciliation.toleranceCents" /></dd></div>
        </dl>
      </Card>

      <Card title="Migration off third-party marketplaces" class="section">
        <p class="period">
          Overall migration <strong>{{ formatBps(data.migration.overallMigrationBps) }}</strong>
          (in-house <Money :cents="data.migration.overallInHouseGmvCents" /> against a baseline of
          <Money :cents="data.migration.overallBaselineMonthlyGmvCents" /> a month). Adoption
          <strong>{{ formatBps(data.migration.adoptionBps) }}</strong>.
        </p>
        <div class="table-wrap">
          <table class="table table-stack">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col" class="num">Baseline monthly</th>
                <th scope="col" class="num">In-house GMV</th>
                <th scope="col" class="num">Migration</th>
                <th scope="col">Adopted</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in data.migration.providers" :key="p.providerId">
                <td data-label="Provider"><code :title="p.providerId">{{ shortId(p.providerId) }}</code></td>
                <td data-label="Baseline monthly" class="num"><Money :cents="p.baselineMonthlyGmvCents" /></td>
                <td data-label="In-house GMV" class="num"><Money :cents="p.inHouseGmvCents" /></td>
                <td data-label="Migration" class="num">{{ formatBps(p.migrationBps) }}</td>
                <td data-label="Adopted">
                  <span class="badge" :class="p.adopted ? 'badge-success' : 'badge-neutral'">{{ p.adopted ? 'Yes' : 'No' }}</span>
                </td>
              </tr>
              <tr v-if="data.migration.providers.length === 0">
                <td colspan="5" class="notice">No providers with a baseline in this window.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="data.migration.noBaselineProviderIds.length > 0" class="notice small">
          Providers with in-house activity but no baseline (left out of migration):
          <code v-for="id in data.migration.noBaselineProviderIds" :key="id" :title="id" class="id-chip">{{ shortId(id) }}</code>
        </p>
      </Card>

      <Card v-if="data.groups.length > 0" :title="`Breakdown by ${data.groupBy}`" class="section">
        <div class="table-wrap">
          <table class="table table-stack">
            <thead>
              <tr>
                <th scope="col">{{ data.groupBy === 'month' ? 'Month' : 'Provider' }}</th>
                <th scope="col" class="num">GMV</th>
                <th scope="col" class="num">Settled</th>
                <th scope="col" class="num">Platform fee</th>
                <th scope="col" class="num">Net margin</th>
                <th scope="col" class="num">Orders</th>
                <th scope="col">Reconciliation</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in data.groups" :key="g.key">
                <td :data-label="data.groupBy === 'month' ? 'Month' : 'Provider'">
                  <code v-if="data.groupBy === 'provider'" :title="g.key">{{ shortId(g.key) }}</code>
                  <template v-else>{{ g.key }}</template>
                </td>
                <td data-label="GMV" class="num"><Money :cents="g.block.gmvCents" /></td>
                <td data-label="Settled" class="num"><Money :cents="g.block.settledGmvCents" /></td>
                <td data-label="Platform fee" class="num"><Money :cents="g.block.platformFeeCents" /></td>
                <td data-label="Net margin" class="num"><Money :cents="g.block.providerNetMarginCents" /></td>
                <td data-label="Orders" class="num">{{ g.block.orderCount }}</td>
                <td data-label="Reconciliation">
                  <span class="badge" :class="g.reconciliation.pass ? 'badge-success' : 'badge-danger'">
                    {{ g.reconciliation.pass ? 'Pass' : 'Fail' }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </template>
  </section>
</template>

<style scoped>
.admin-metrics {
  max-width: 1120px;
}
.demo-banner {
  position: sticky;
  top: 0;
  z-index: 5;
  margin-bottom: var(--space-4);
  font-size: var(--text-md);
}
.controls {
  margin-bottom: var(--space-4);
}
.controls-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr));
  gap: var(--space-4);
}
.synthetic {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 2px solid var(--demo-border);
  border-radius: var(--radius);
  background: var(--surface);
}
.synthetic.on {
  background: var(--demo-tint);
  border-color: var(--demo);
}
.switch-label {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  cursor: pointer;
  flex: 1 1 16rem;
}
.switch-text {
  display: flex;
  flex-direction: column;
  font-size: var(--text-lg);
}
.switch-text .subtle {
  font-size: var(--text-sm);
}
input.switch {
  appearance: none;
  flex: none;
  position: relative;
  width: 3rem;
  height: 1.6rem;
  border-radius: 999px;
  border: 2px solid var(--border-strong);
  background: var(--n-200);
  cursor: pointer;
  transition: background-color 0.15s ease;
}
input.switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 1.1rem;
  height: 1.1rem;
  border-radius: 50%;
  background: #fff;
  box-shadow: var(--shadow-sm);
  transition: transform 0.15s ease;
}
input.switch:checked {
  background: var(--demo);
  border-color: var(--demo);
}
input.switch:checked::after {
  transform: translateX(1.4rem);
}
input.switch:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.period {
  color: var(--muted);
}
.kpi-groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
  gap: var(--space-3);
}
.section {
  margin-top: var(--space-4);
}
.recon-badge {
  font-size: var(--text-sm);
  padding: 0.2rem 0.75rem;
}
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
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
}
.small {
  font-size: var(--text-sm);
  margin-top: var(--space-3);
}
.id-chip {
  margin-right: var(--space-1);
}
</style>
