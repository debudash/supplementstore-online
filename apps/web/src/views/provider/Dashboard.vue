<script setup lang="ts">
// Provider sales dashboard (FR-10). Reads GET /api/reports/sales; every money figure
// comes from the ledger (the API aggregates ledger_entries / refunds - the UI only
// DISPLAYS, it never computes money; AGENTS.md money rule 2). Default window is the
// current UTC month; a custom From/To range is supported.
import { onMounted, ref, computed } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import type { SalesReport } from '@cerbo/contracts'
import PageHeader from '../../components/ui/PageHeader.vue'
import KpiCard from '../../components/ui/KpiCard.vue'
import StatusChip from '../../components/ui/StatusChip.vue'
import UiAlert from '../../components/ui/UiAlert.vue'
import UiButton from '../../components/ui/UiButton.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import { formatMoney, isNegative } from '../../utils/money'

const report = ref<SalesReport | null>(null)
const from = ref('')
const to = ref('')
const loading = ref(true)
const error = ref<string | null>(null)
const rangeError = ref<string | null>(null)

function validateRange(): string | null {
  if (Boolean(from.value) !== Boolean(to.value)) return 'Choose both a From and a To date, or clear both to see this month.'
  if (from.value && to.value && from.value > to.value) return 'The From date must be on or before the To date.'
  return null
}

async function load(): Promise<void> {
  rangeError.value = validateRange()
  if (rangeError.value) return
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

function thisMonth(): void {
  from.value = ''
  to.value = ''
  void load()
}

onMounted(load)

/** Refunds reduce GMV: shown with negative styling. A server value that is already
 * negative is styled by <Money>; a positive one keeps its sign and gets the style here. */
const refundedPositive = computed(() => {
  const v = report.value?.refundedGmvCents
  return typeof v === 'number' && !isNegative(v) && v !== 0
})
const showKpis = computed(() => loading.value || report.value !== null)
</script>

<template>
  <section class="dashboard">
    <PageHeader title="Dashboard" subtitle="Your sales, refunds and earnings for a period (UTC).">
      <template v-if="report" #subtitle>
        Your sales for <strong>{{ report.period.from }}</strong> to <strong>{{ report.period.to }}</strong> (UTC).
      </template>
    </PageHeader>

    <form class="range" aria-label="Report period" novalidate @submit.prevent="load">
      <div class="filter">
        <label for="dash-from">From</label>
        <input id="dash-from" v-model="from" type="date" :aria-invalid="rangeError ? 'true' : undefined" aria-describedby="dash-range-msg" data-testid="dash-from" />
      </div>
      <div class="filter">
        <label for="dash-to">To</label>
        <input id="dash-to" v-model="to" type="date" :aria-invalid="rangeError ? 'true' : undefined" aria-describedby="dash-range-msg" data-testid="dash-to" />
      </div>
      <UiButton type="submit" variant="primary" :busy="loading" busy-label="Loading..." data-testid="dash-apply">Apply</UiButton>
      <button type="button" class="btn-link" :disabled="loading" data-testid="dash-this-month" @click="thisMonth">This month</button>
    </form>
    <p id="dash-range-msg" class="range-msg" aria-live="polite">{{ rangeError ?? '' }}</p>

    <UiAlert v-if="error" tone="danger" title="Could not load the dashboard">
      {{ error }}
      <template #actions><button type="button" class="btn-sm" data-testid="dash-retry" @click="load">Try again</button></template>
    </UiAlert>

    <div v-if="showKpis" class="kpis" aria-live="polite" :aria-busy="loading ? 'true' : undefined">
      <KpiCard
        label="GMV"
        primary
        :cents="report?.gmvCents"
        :loading="loading"
        hint="Gross sales: everything patients paid in the period."
      />
      <KpiCard
        v-if="refundedPositive && !loading"
        class="kpi-refunded"
        label="Refunded"
        :value="formatMoney(report?.refundedGmvCents)"
        hint="Money returned to patients. Reduces GMV."
        data-testid="kpi-refunded"
      />
      <KpiCard
        v-else
        label="Refunded"
        :cents="report?.refundedGmvCents"
        :loading="loading"
        hint="Money returned to patients. Reduces GMV."
        data-testid="kpi-refunded"
      />
      <KpiCard label="Settled" :cents="report?.settledGmvCents" :loading="loading" hint="GMV after refunds - the sales that stuck." />
      <KpiCard label="Platform fees" :cents="report?.platformFeeCents" :loading="loading" hint="Cerbo's fee on your sales, including fees kept on refunds." />
      <KpiCard label="Net margin" :cents="report?.providerNetMarginCents" :loading="loading" hint="What you earn on settled sales, after cost and fees." />
    </div>

    <Skeleton v-if="loading && !report" :lines="4" height="2rem" label="Loading report tables" />

    <div v-else-if="report" class="grid-2 tables">
      <section aria-labelledby="units-title">
        <h2 id="units-title" class="section-title">Units sold by product</h2>
        <EmptyState v-if="report.unitsBySku.length === 0" title="No units sold in this period" />
        <div v-else class="table-wrap">
          <table class="table table-stack">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">SKU</th>
                <th scope="col" class="num">Units</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in report.unitsBySku" :key="row.sku">
                <td data-label="Product">{{ row.name }}</td>
                <td data-label="SKU" class="subtle">{{ row.sku }}</td>
                <td data-label="Units" class="num">{{ row.units }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="status-title">
        <h2 id="status-title" class="section-title">Orders by status</h2>
        <EmptyState v-if="report.ordersByStatus.length === 0" title="No orders in this period" />
        <div v-else class="table-wrap">
          <table class="table table-stack">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col" class="num">Orders</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in report.ordersByStatus" :key="row.status">
                <td data-label="Status"><StatusChip :status="row.status" /></td>
                <td data-label="Orders" class="num">{{ row.count }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.range {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-4);
  align-items: flex-end;
}
.filter {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.filter label {
  font-size: var(--text-sm);
  font-weight: 600;
}
.range-msg {
  min-height: 1.25rem;
  margin: var(--space-1) 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--danger);
}
.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
  gap: var(--space-4);
  margin: var(--space-4) 0 var(--space-8);
}
.kpi-refunded :deep(.kpi-value) {
  color: var(--money-negative);
}
.section-title {
  font-size: var(--text-lg);
  margin: 0 0 var(--space-3);
}
@media (max-width: 640px) {
  .filter {
    flex: 1 1 100%;
  }
  .filter input {
    width: 100%;
  }
}
</style>
