<script setup lang="ts">
// Provider orders list (FR-7 AC2). Lists the signed-in provider's own orders (the API
// scopes by provider) with status and created-date filters (GET /orders?status=&from=&to=).
// A row opens that order's audit; drafts can be resumed or deleted, and sent orders can
// reveal their pay link. Patient names come from GET /patients and fall back to the id.
import { onMounted, ref, computed } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { apiRequest, ApiError } from '../../api/client'
import type { OrderSummary, OrderStatus, PatientView } from '@cerbo/contracts'
import CopyLink from '../../components/order/CopyLink.vue'
import PageHeader from '../../components/ui/PageHeader.vue'
import Money from '../../components/ui/Money.vue'
import StatusChip from '../../components/ui/StatusChip.vue'
import ConfirmDialog from '../../components/ui/ConfirmDialog.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import UiAlert from '../../components/ui/UiAlert.vue'
import { toast } from '../../components/ui/toast'

const STATUSES: Array<{ value: OrderStatus; label: string }> = [
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'paid', label: 'Paid' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'expired', label: 'Expired' },
  { value: 'cancelled', label: 'Cancelled' }
]

// The router may be absent when the view is mounted on its own (component tests).
const router = useRouter() as ReturnType<typeof useRouter> | undefined

const orders = ref<OrderSummary[]>([])
const patientNames = ref<Record<string, string>>({})
const statusFilter = ref('')
const fromDate = ref('')
const toDate = ref('')
const loading = ref(true)
const error = ref<string | null>(null)

const patientName = (id: string): string => patientNames.value[id] ?? id
const filtersActive = computed(() => Boolean(statusFilter.value || fromDate.value || toDate.value))
const rangeInvalid = computed(() => Boolean(fromDate.value && toDate.value && fromDate.value > toDate.value))

function shortDate(value: string | null): string {
  if (!value) return '-'
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

async function loadPatients(): Promise<void> {
  try {
    const res = await apiRequest<{ patients: PatientView[] }>('/patients')
    patientNames.value = Object.fromEntries(res.patients.map((p) => [p.id, p.name]))
  } catch {
    // Non-fatal: names fall back to patient ids.
    patientNames.value = {}
  }
}

function ordersPath(): string {
  const params = new URLSearchParams()
  if (statusFilter.value) params.set('status', statusFilter.value)
  if (fromDate.value) params.set('from', fromDate.value)
  // The API compares created_at <= to, so send the end of that day to include it.
  if (toDate.value) params.set('to', toDate.value) // server includes the whole day
  const qs = params.toString()
  return qs ? `/orders?${qs}` : '/orders'
}

async function loadOrders(): Promise<void> {
  if (rangeInvalid.value) return
  loading.value = true
  error.value = null
  try {
    const res = await apiRequest<{ orders: OrderSummary[] }>(ordersPath())
    orders.value = res.orders
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Failed to load orders.'
  } finally {
    loading.value = false
  }
}

function clearFilters(): void {
  statusFilter.value = ''
  fromDate.value = ''
  toDate.value = ''
  void loadOrders()
}

function openAudit(o: OrderSummary): void {
  void router?.push({ name: 'order-audit', params: { id: o.id } })
}

// Which orders have their pay link expanded (UI-only state). payPath is non-null only
// for orders that have been sent, so the control keys off that, not the status.
const expanded = ref<Set<string>>(new Set())
function toggleLink(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

// Delete a draft via a confirmation dialog (drafts hold no stock).
const deleteTarget = ref<OrderSummary | null>(null)
const deleting = ref(false)
async function confirmDelete(): Promise<void> {
  const o = deleteTarget.value
  if (!o) return
  deleting.value = true
  error.value = null
  try {
    await apiRequest(`/orders/${o.id}`, { method: 'DELETE' })
    orders.value = orders.value.filter((x) => x.id !== o.id)
    toast('Draft deleted.')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Failed to delete the draft.'
  } finally {
    deleting.value = false
    deleteTarget.value = null
  }
}

onMounted(async () => {
  await Promise.all([loadPatients(), loadOrders()])
})
</script>

<template>
  <section class="orders">
    <PageHeader title="Orders" subtitle="Every order you have started, newest first.">
      <template #actions>
        <RouterLink :to="{ name: 'order-new' }" class="btn btn-primary" data-testid="new-order-link">New order</RouterLink>
      </template>
    </PageHeader>

    <form class="filters" aria-label="Filter orders" @submit.prevent="loadOrders">
      <div class="filter">
        <label for="orders-status">Status</label>
        <select id="orders-status" v-model="statusFilter" data-testid="filter-status" @change="loadOrders">
          <option value="">All statuses</option>
          <option v-for="s in STATUSES" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
      </div>
      <div class="filter">
        <label for="orders-from">From</label>
        <input id="orders-from" v-model="fromDate" type="date" data-testid="filter-from" :aria-invalid="rangeInvalid ? 'true' : undefined" aria-describedby="orders-range-msg" @change="loadOrders" />
      </div>
      <div class="filter">
        <label for="orders-to">To</label>
        <input id="orders-to" v-model="toDate" type="date" data-testid="filter-to" :aria-invalid="rangeInvalid ? 'true' : undefined" aria-describedby="orders-range-msg" @change="loadOrders" />
      </div>
      <button v-if="filtersActive" type="button" class="btn-link" data-testid="clear-filters" @click="clearFilters">Clear filters</button>
    </form>
    <p id="orders-range-msg" class="range-msg" aria-live="polite">
      <template v-if="rangeInvalid">The From date must be on or before the To date.</template>
    </p>

    <UiAlert v-if="error" tone="danger">
      {{ error }}
      <template #actions><button type="button" class="btn-sm" data-testid="orders-retry" @click="loadOrders">Try again</button></template>
    </UiAlert>

    <Skeleton v-if="loading" :lines="5" height="2.5rem" label="Loading orders" />

    <template v-else-if="orders.length === 0">
      <EmptyState
        v-if="filtersActive"
        title="No orders match these filters"
        message="Try a different status or date range."
        data-testid="orders-empty-filtered"
      >
        <button type="button" @click="clearFilters">Clear filters</button>
      </EmptyState>
      <EmptyState v-else title="No orders yet" message="Start an order for a patient and it will show up here." data-testid="orders-empty">
        <RouterLink :to="{ name: 'order-new' }" class="btn btn-primary">New order</RouterLink>
      </EmptyState>
    </template>

    <div v-else class="table-wrap">
      <table class="table table-stack">
        <caption class="sr-only">Orders. Select a row to open its audit.</caption>
        <thead>
          <tr>
            <th scope="col">Patient</th>
            <th scope="col">Status</th>
            <th scope="col" class="num">Subtotal</th>
            <th scope="col">Created</th>
            <th scope="col">Sent</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="o in orders" :key="o.id">
            <tr
              class="row-link"
              tabindex="0"
              data-testid="order-row"
              @click="openAudit(o)"
              @keydown.enter.self="openAudit(o)"
            >
              <td data-label="Patient" class="patient">{{ patientName(o.patientId) }}</td>
              <td data-label="Status">
                <span class="status-cell">
                  <StatusChip :status="o.status" />
                  <span
                    v-if="o.refundRequestStatus === 'pending'"
                    class="badge badge-warning"
                    :data-testid="`refund-requested-${o.id}`"
                  >Refund requested</span>
                </span>
              </td>
              <td data-label="Subtotal" class="num"><Money :cents="o.subtotalCents" /></td>
              <td data-label="Created">{{ shortDate(o.createdAt) }}</td>
              <td data-label="Sent">{{ shortDate(o.sentAt) }}</td>
              <td class="actions-cell" @click.stop @keydown.stop>
                <div class="actions">
                <RouterLink
                  v-if="o.status === 'draft'"
                  class="btn btn-sm"
                  :to="{ name: 'order-new', query: { orderId: o.id } }"
                  data-test="resume-draft"
                  data-testid="resume-draft"
                >Resume</RouterLink>
                <button
                  v-if="o.payPath"
                  type="button"
                  class="btn-link"
                  :aria-expanded="expanded.has(o.id)"
                  data-testid="toggle-link"
                  @click="toggleLink(o.id)"
                >{{ expanded.has(o.id) ? 'Hide link' : 'Show link' }}</button>
                <button
                  v-if="o.status === 'draft'"
                  type="button"
                  class="btn-sm btn-danger-quiet"
                  :aria-label="`Delete draft for ${patientName(o.patientId)}`"
                  data-test="delete-draft"
                  data-testid="delete-draft"
                  @click="deleteTarget = o"
                >Delete</button>
                </div>
              </td>
            </tr>
            <tr v-if="o.payPath && expanded.has(o.id)" class="link-row">
              <td colspan="6"><CopyLink :payUrl="o.payPath" compact /></td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <ConfirmDialog
      :open="deleteTarget !== null"
      title="Delete this draft?"
      confirm-label="Delete draft"
      tone="danger"
      :busy="deleting"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    >
      <p>
        The draft order for <strong>{{ deleteTarget ? patientName(deleteTarget.patientId) : '' }}</strong>
        will be deleted. This cannot be undone. Drafts hold no stock, so nothing is released.
      </p>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-4);
  align-items: flex-end;
}
.filter {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.filter label {
  font-size: var(--text-sm);
  font-weight: 600;
}
.filter select {
  min-width: 11rem;
}
.range-msg {
  min-height: 1.25rem;
  margin: var(--space-1) 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--danger);
}
.patient {
  font-weight: 600;
}
.status-cell {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  align-items: center;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  justify-content: flex-end;
}
.link-row td {
  background: var(--surface-2);
}
@media (max-width: 640px) {
  .filter {
    flex: 1 1 100%;
  }
  .filter select,
  .filter input {
    width: 100%;
  }
  .actions {
    justify-content: flex-start;
  }
}
</style>
