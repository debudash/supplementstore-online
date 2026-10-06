<script setup lang="ts">
// Provider orders list with links to the per-order audit view (FR-7 AC2). Lists the
// signed-in provider's own orders (the API scopes by provider), with an optional
// status filter. Patient names are shown when the patients endpoint is available and
// fall back to the patient id otherwise.
import { onMounted, ref, computed } from 'vue'
import { RouterLink } from 'vue-router'
import { apiRequest, ApiError } from '../../api/client'
import { currentUserId } from '../../api/session'
import type { OrderSummary, OrderStatus, PatientView } from '@cerbo/contracts'
import { formatCents } from '../../components/order/format'

const STATUSES: OrderStatus[] = ['draft', 'sent', 'paid', 'cancelled', 'expired', 'refunded', 'on_hold']

const orders = ref<OrderSummary[]>([])
const patientNames = ref<Record<string, string>>({})
const statusFilter = ref<string>('')
const loading = ref(false)
const error = ref<string | null>(null)

const patientName = (id: string): string => patientNames.value[id] ?? id

// Map an order status to a semantic badge class (colour means a data state).
function statusClass(status: OrderStatus): string {
  switch (status) {
    case 'paid':
      return 'badge-success'
    case 'sent':
      return 'badge-info'
    case 'on_hold':
    case 'refunded':
      return 'badge-warning'
    case 'expired':
      return 'badge-danger'
    default:
      return 'badge-neutral'
  }
}

async function loadPatients(): Promise<void> {
  try {
    const res = await apiRequest<{ patients: PatientView[] }>('/patients')
    patientNames.value = Object.fromEntries(res.patients.map((p) => [p.id, p.name]))
  } catch {
    // Non-fatal: the patients endpoint may still be a 501 stub, or otherwise fail.
    // The order list is the primary content, so names just fall back to patient ids.
    patientNames.value = {}
  }
}

async function loadOrders(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const path = statusFilter.value ? `/orders?status=${encodeURIComponent(statusFilter.value)}` : '/orders'
    const res = await apiRequest<{ orders: OrderSummary[] }>(path)
    orders.value = res.orders
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Failed to load orders.'
  } finally {
    loading.value = false
  }
}

const empty = computed(() => !loading.value && orders.value.length === 0)

onMounted(async () => {
  await Promise.all([loadPatients(), loadOrders()])
})
</script>

<template>
  <section class="orders">
    <h2>Orders</h2>

    <div class="toolbar">
      <label class="field">
        Status
        <select v-model="statusFilter" :disabled="loading" @change="loadOrders">
          <option value="">All</option>
          <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <button type="button" :disabled="loading" @click="loadOrders">Refresh</button>
    </div>

    <p v-if="error" class="page-error" role="alert">{{ error }}</p>
    <p v-if="loading" class="notice">Loading...</p>
    <p v-else-if="empty" class="notice">No orders yet.</p>

    <table v-else class="order-table">
      <thead>
        <tr>
          <th>Patient</th>
          <th>Status</th>
          <th>Subtotal</th>
          <th>Created</th>
          <th>Sent</th>
          <th>Audit</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="o in orders" :key="o.id">
          <td>{{ patientName(o.patientId) }}</td>
          <td><span class="badge" :class="statusClass(o.status)">{{ o.status }}</span></td>
          <td class="num">{{ o.subtotalCents === null ? '-' : formatCents(o.subtotalCents) }}</td>
          <td>{{ new Date(o.createdAt).toLocaleString() }}</td>
          <td>{{ o.sentAt ? new Date(o.sentAt).toLocaleString() : '-' }}</td>
          <td>
            <RouterLink :to="{ name: 'order-audit', params: { id: o.id } }">View audit</RouterLink>
          </td>
        </tr>
      </tbody>
    </table>

    <p class="actor-note">Acting as <code>{{ currentUserId }}</code>.</p>
  </section>
</template>

<style scoped>
.orders {
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
.order-table {
  border-collapse: collapse;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.order-table th,
.order-table td {
  border-bottom: 1px solid var(--border);
  padding: 0.5rem 0.7rem;
  text-align: left;
}
.order-table tbody tr:last-child td {
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
