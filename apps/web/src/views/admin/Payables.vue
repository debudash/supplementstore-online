<script setup lang="ts">
// Cerbo Admin payables (FR-11 AC3). View a UTC month's payable statements and close the
// month into immutable statements (ADR-016). GET /api/admin/payables?month= returns the
// stored statements once closed, or a live preview before. POST /api/admin/payables/close
// creates the statements; a month already closed returns ALREADY_CLOSED. The UI only
// displays and triggers the close - all money aggregation happens server-side from the
// ledger (AGENTS.md money rule 2).
import { computed, onMounted, ref, watch } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import type { AdminPayablesResponse, ClosePayablesResult } from '@cerbo/contracts'
import PageHeader from '../../components/ui/PageHeader.vue'
import Card from '../../components/ui/Card.vue'
import Money from '../../components/ui/Money.vue'
import UiAlert from '../../components/ui/UiAlert.vue'
import UiField from '../../components/ui/UiField.vue'
import UiButton from '../../components/ui/UiButton.vue'
import ConfirmDialog from '../../components/ui/ConfirmDialog.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import { formatMoney } from '../../utils/money'
import { toast } from '../../components/ui/toast'
import ProviderLabel from '../../components/admin/ProviderLabel.vue'

function currentMonthToken(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

const month = ref(currentMonthToken())
const data = ref<AdminPayablesResponse | null>(null)
const loading = ref(false)
const closing = ref(false)
const confirmOpen = ref(false)
const error = ref<string | null>(null)
const closeResult = ref<ClosePayablesResult | null>(null)

const validMonth = computed(() => /^\d{4}-\d{2}$/.test(month.value))
/** "YYYY-MM" strings compare correctly as text. */
const inProgress = computed(() => month.value >= currentMonthToken())
const monthLabel = computed(() => {
  if (!validMonth.value) return month.value
  const [y, m] = month.value.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
})
const providerCount = computed(() => data.value?.statements.length ?? 0)

let requestSeq = 0

async function load(): Promise<void> {
  if (!validMonth.value) return
  const seq = ++requestSeq
  loading.value = true
  error.value = null
  try {
    const res = await apiRequest<AdminPayablesResponse>(`/admin/payables?month=${encodeURIComponent(month.value)}`)
    if (seq === requestSeq) data.value = res
  } catch (err) {
    if (seq !== requestSeq) return
    error.value = err instanceof ApiError ? err.message : 'Failed to load payables.'
    data.value = null
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

watch(month, () => {
  closeResult.value = null
  void load()
})

async function close(): Promise<void> {
  closing.value = true
  error.value = null
  try {
    const result = await apiRequest<ClosePayablesResult>('/admin/payables/close', {
      method: 'POST',
      body: { month: month.value }
    })
    closeResult.value = result
    toast(`Closed ${monthLabel.value}: ${result.statements.length} statement(s) created.`, 'success')
    confirmOpen.value = false
    await load()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Failed to close the month.'
    confirmOpen.value = false
  } finally {
    closing.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="admin-payables">
    <PageHeader title="Payables" subtitle="What Cerbo owes each provider per UTC month. Closing a month freezes its statements." />

    <Card>
      <div class="toolbar">
        <UiField v-slot="f" label="Month (UTC)">
          <input :id="f.id" v-model="month" type="month" :disabled="closing" data-testid="payables-month" />
        </UiField>
        <div v-if="data" class="state">
          <span class="badge" :class="data.closed ? 'badge-success' : 'badge-warning'" data-testid="payables-state">
            {{ data.closed ? 'Closed' : 'Open - preview' }}
          </span>
          <span class="subtle">{{ data.periodStart }} to {{ data.periodEnd }}</span>
        </div>
        <span class="spacer" />
        <UiButton :busy="loading" busy-label="Loading..." :disabled="closing" data-testid="payables-refresh" @click="load">Refresh</UiButton>
        <UiButton
          variant="primary"
          :disabled="loading || closing || !data || data.closed || inProgress"
          :aria-describedby="inProgress && !data?.closed ? 'close-in-progress' : undefined"
          data-testid="payables-close"
          @click="confirmOpen = true"
        >
          Close month
        </UiButton>
      </div>
      <p v-if="data?.closed" class="subtle closed-note">This month is closed. Its statements are immutable.</p>
      <p v-else-if="inProgress" id="close-in-progress" class="subtle closed-note" data-testid="close-in-progress">
        This month is still in progress. It can be closed once it ends, so its statements are complete.
      </p>
    </Card>

    <div class="section" aria-live="polite">
      <p v-if="error" class="page-error" role="alert">{{ error }}</p>
      <UiAlert v-if="closeResult" tone="success" title="Month closed">
        Created {{ closeResult.statements.length }} immutable statement(s) for {{ closeResult.periodStart }} to {{ closeResult.periodEnd }}.
      </UiAlert>
    </div>

    <Skeleton v-if="loading && !data" :lines="4" height="2.25rem" label="Loading payables" class="section" />

    <template v-else-if="data">
      <EmptyState v-if="data.statements.length === 0" class="section" title="No payable activity" :message="`There are no provider statements for ${monthLabel}.`" />

      <div v-else class="table-wrap section">
        <table class="table table-stack" :aria-busy="loading ? 'true' : undefined">
          <caption class="sr-only">Payable statements for {{ monthLabel }}</caption>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col" class="num">Opening</th>
              <th scope="col" class="num">Credits</th>
              <th scope="col" class="num">Debits</th>
              <th scope="col" class="num">Closing</th>
              <th scope="col">Closed at</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in data.statements" :key="s.providerId">
              <td data-label="Provider">
                <ProviderLabel :id="s.providerId" :name="s.providerName" :practice="s.practiceName" />
              </td>
              <td data-label="Opening" class="num"><Money :cents="s.openingCents" /></td>
              <td data-label="Credits" class="num"><Money :cents="s.creditsCents" /></td>
              <td data-label="Debits" class="num">
                <span class="money" :class="{ 'money-negative': s.debitsCents !== 0 }">{{ formatMoney(s.debitsCents) }}</span>
              </td>
              <td data-label="Closing" class="num"><Money :cents="s.closingCents" strong /></td>
              <td data-label="Closed at">{{ s.closedAt ? new Date(s.closedAt).toLocaleString() : '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <ConfirmDialog
      :open="confirmOpen"
      :title="`Close ${monthLabel}?`"
      confirm-label="Close month"
      tone="danger"
      :busy="closing"
      @confirm="close"
      @cancel="confirmOpen = false"
    >
      <p data-testid="close-consequence">
        Creates immutable statements for {{ providerCount }} provider{{ providerCount === 1 ? '' : 's' }}. This cannot be undone.
      </p>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.admin-payables {
  max-width: 1000px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-4);
  align-items: flex-end;
}
.state {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-bottom: 0.3rem;
}
.closed-note {
  margin: var(--space-3) 0 0;
}
.section {
  margin-top: var(--space-4);
}
.section:empty {
  margin-top: 0;
}
.who {
  display: inline-flex;
  flex-direction: column;
  line-height: 1.3;
}
@media (max-width: 480px) {
  .toolbar > button {
    flex: 1 1 auto;
  }
}
</style>
