<script setup lang="ts">
// Provider payable report (FR-11). Reads GET /api/reports/payables: opening balance,
// credits (margins earned), debits (margin reversals + fee retentions), closing balance,
// and the contributing orders. Balances are derived from PROVIDER_PAYABLE ledger entries
// by the API; the UI only displays them (the "+ - =" layout is labels, not arithmetic).
// Monthly by default (current UTC month); last month or a custom range on demand.
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { apiRequest, ApiError } from '../../api/client'
import type { PayableReport, OrderSummary, PatientView } from '@cerbo/contracts'
import PageHeader from '../../components/ui/PageHeader.vue'
import Money from '../../components/ui/Money.vue'
import UiAlert from '../../components/ui/UiAlert.vue'
import UiButton from '../../components/ui/UiButton.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import { formatMoney } from '../../utils/money'

type Preset = 'this' | 'last' | 'custom'

const report = ref<PayableReport | null>(null)
const preset = ref<Preset>('this')
const from = ref('')
const to = ref('')
const loading = ref(true)
const error = ref<string | null>(null)
const rangeError = ref<string | null>(null)
const patientByOrder = ref<Record<string, string>>({})

/** YYYY-MM-DD for a UTC date (calendar dates, not money). */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function lastMonthRange(): { from: string; to: string } {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  return { from: isoDate(new Date(Date.UTC(y, m - 1, 1))), to: isoDate(new Date(Date.UTC(y, m, 0))) }
}

function validateRange(): string | null {
  if (preset.value !== 'custom') return null
  if (!from.value || !to.value) return 'Choose both a From and a To date.'
  if (from.value > to.value) return 'The From date must be on or before the To date.'
  return null
}

async function load(): Promise<void> {
  rangeError.value = validateRange()
  if (rangeError.value) return
  loading.value = true
  error.value = null
  try {
    const params = new URLSearchParams()
    if (preset.value === 'last') {
      const r = lastMonthRange()
      params.set('from', r.from)
      params.set('to', r.to)
    } else if (preset.value === 'custom') {
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

/** Best-effort patient names for the contributing orders (falls back to the order id). */
async function loadPatientNames(): Promise<void> {
  try {
    const [o, p] = await Promise.all([
      apiRequest<{ orders: OrderSummary[] }>('/orders'),
      apiRequest<{ patients: PatientView[] }>('/patients')
    ])
    const names = Object.fromEntries(p.patients.map((x) => [x.id, x.name]))
    patientByOrder.value = Object.fromEntries(o.orders.filter((x) => names[x.patientId]).map((x) => [x.id, names[x.patientId]]))
  } catch {
    patientByOrder.value = {}
  }
}

function choose(p: Preset): void {
  preset.value = p
  rangeError.value = null
  if (p !== 'custom') void load()
}

onMounted(async () => {
  await Promise.all([load(), loadPatientNames()])
})
</script>

<template>
  <section class="payables">
    <PageHeader title="Payables" subtitle="What Cerbo owes you, and which orders moved it.">
      <template v-if="report" #subtitle>
        What Cerbo owes you for <strong>{{ report.period.from }}</strong> to <strong>{{ report.period.to }}</strong> (UTC).
      </template>
    </PageHeader>

    <div class="period">
      <div class="presets" role="group" aria-label="Period">
        <button type="button" :class="{ 'btn-primary': preset === 'this' }" :aria-pressed="preset === 'this'" :disabled="loading" data-testid="period-this" @click="choose('this')">This month</button>
        <button type="button" :class="{ 'btn-primary': preset === 'last' }" :aria-pressed="preset === 'last'" :disabled="loading" data-testid="period-last" @click="choose('last')">Last month</button>
        <button type="button" :class="{ 'btn-primary': preset === 'custom' }" :aria-pressed="preset === 'custom'" :disabled="loading" data-testid="period-custom" @click="choose('custom')">Custom</button>
      </div>
      <form v-if="preset === 'custom'" class="range" aria-label="Custom period" novalidate @submit.prevent="load">
        <div class="filter">
          <label for="pay-from">From</label>
          <input id="pay-from" v-model="from" type="date" :aria-invalid="rangeError ? 'true' : undefined" aria-describedby="pay-range-msg" data-testid="pay-from" />
        </div>
        <div class="filter">
          <label for="pay-to">To</label>
          <input id="pay-to" v-model="to" type="date" :aria-invalid="rangeError ? 'true' : undefined" aria-describedby="pay-range-msg" data-testid="pay-to" />
        </div>
        <UiButton type="submit" variant="primary" :busy="loading" busy-label="Loading..." data-testid="pay-apply">Apply</UiButton>
      </form>
    </div>
    <p id="pay-range-msg" class="range-msg" aria-live="polite">{{ rangeError ?? '' }}</p>

    <UiAlert v-if="error" tone="danger" title="Could not load payables">
      {{ error }}
      <template #actions><button type="button" class="btn-sm" data-testid="pay-retry" @click="load">Try again</button></template>
    </UiAlert>

    <Skeleton v-if="loading" :lines="4" height="2.5rem" label="Loading payables" />

    <template v-else-if="report">
      <!-- Opening + Credits - Debits = Closing. Every figure is the server's. -->
      <section class="equation" aria-label="Balance summary">
        <div class="term">
          <span class="term-label">Opening</span>
          <Money :cents="report.openingCents" class="term-value" />
          <span class="term-hint">Owed at the start</span>
        </div>
        <span class="op" aria-hidden="true">+</span>
        <div class="term">
          <span class="term-label">Credits</span>
          <Money :cents="report.creditsCents" class="term-value" />
          <span class="term-hint">Margins earned</span>
        </div>
        <span class="op" aria-hidden="true">-</span>
        <div class="term">
          <span class="term-label"><span class="sr-only">minus </span>Debits</span>
          <span class="money term-value" :class="{ 'money-negative': report.debitsCents !== 0 }" data-testid="pay-debits">{{ formatMoney(report.debitsCents) }}</span>
          <span class="term-hint">Refund reversals and fees kept</span>
        </div>
        <span class="op" aria-hidden="true">=</span>
        <div class="term closing">
          <span class="term-label">Closing</span>
          <Money :cents="report.closingCents" class="term-value" strong />
          <span class="term-hint">Owed at the end</span>
        </div>
      </section>

      <section aria-labelledby="contrib-title">
        <h2 id="contrib-title" class="section-title">Contributing orders</h2>
        <EmptyState v-if="report.contributingOrders.length === 0" title="No payable movement in this period" message="Paid or refunded orders in this period will show here." />
        <div v-else class="table-wrap">
          <table class="table table-stack">
            <thead>
              <tr>
                <th scope="col">Patient</th>
                <th scope="col">Order</th>
                <th scope="col" class="num">Credits</th>
                <th scope="col" class="num">Debits</th>
                <th scope="col" class="num">Net</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in report.contributingOrders" :key="o.orderId">
                <td data-label="Patient">{{ patientByOrder[o.orderId] ?? '-' }}</td>
                <td data-label="Order">
                  <RouterLink :to="{ name: 'order-audit', params: { id: o.orderId } }">
                    View audit <span class="subtle">{{ o.orderId.slice(0, 8) }}</span>
                  </RouterLink>
                </td>
                <td data-label="Credits" class="num"><Money :cents="o.creditsCents" /></td>
                <td data-label="Debits" class="num">
                  <span class="money" :class="{ 'money-negative': o.debitsCents !== 0 }">{{ formatMoney(o.debitsCents) }}</span>
                </td>
                <td data-label="Net" class="num"><Money :cents="o.netCents" strong /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.period {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-6);
  align-items: flex-end;
}
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
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
.equation {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  margin-bottom: var(--space-8);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}
.term {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1 1 9rem;
  min-width: 0;
}
.term.closing {
  padding-left: var(--space-3);
  border-left: 3px solid var(--brand);
}
.term-label {
  font-size: var(--text-xs);
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.term-value {
  font-size: var(--text-xl);
  font-weight: 650;
}
.term-hint {
  font-size: var(--text-sm);
  color: var(--muted);
}
.op {
  font-size: var(--text-2xl);
  font-weight: 700;
  color: var(--subtle);
}
.section-title {
  font-size: var(--text-lg);
  margin: 0 0 var(--space-3);
}
@media (max-width: 640px) {
  .equation {
    flex-direction: column;
    align-items: stretch;
  }
  .op {
    align-self: flex-start;
    line-height: 1;
  }
  .filter {
    flex: 1 1 100%;
  }
  .filter input {
    width: 100%;
  }
}
</style>
