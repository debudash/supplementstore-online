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
import CopyLink from '../../components/order/CopyLink.vue'

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

// Which orders have their pay link expanded (UI-only state). The pay link is stored on
// the order and surfaced here so a provider can recover it after send (payPath is
// non-null only for sent/non-draft orders - we show the control off that, not status).
const expanded = ref<Set<string>>(new Set())
function toggleLink(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

// Delete a draft (drafts hold no stock, so its items are already available to others).
const deletingId = ref<string | null>(null)
async function deleteDraft(o: OrderSummary): Promise<void> {
  if (!window.confirm(`Delete this draft order for ${patientName(o.patientId)}? This cannot be undone.`)) return
  deletingId.value = o.id
  error.value = null
  try {
    await apiRequest(`/orders/${o.id}`, { method: 'DELETE' })
    orders.value = orders.value.filter((x) => x.id !== o.id)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Failed to delete the draft.'
  } finally {
    deletingId.value = null
  }
}

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
          <th>Pay link</th>
          <th>Audit</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="o in orders" :key="o.id">
          <tr>
            <td>{{ patientName(o.patientId) }}</td>
            <td><span class="badge" :class="statusClass(o.status)">{{ o.status }}</span></td>
            <td class="num">{{ o.subtotalCents === null ? '-' : formatCents(o.subtotalCents) }}</td>
            <td>{{ new Date(o.createdAt).toLocaleString() }}</td>
            <td>{{ o.sentAt ? new Date(o.sentAt).toLocaleString() : '-' }}</td>
            <td>
              <button v-if="o.payPath" type="button" class="btn-link" @click="toggleLink(o.id)">
                {{ expanded.has(o.id) ? 'Hide link' : 'Show link' }}
              </button>
              <span v-else class="dash">-</span>
            </td>
            <td class="actions">
              <RouterLink
                v-if="o.status === 'draft'"
                class="resume-link"
                :to="{ name: 'order-new', query: { orderId: o.id } }"
                data-test="resume-draft"
              >Resume</RouterLink>
              <RouterLink :to="{ name: 'order-audit', params: { id: o.id } }">View audit</RouterLink>
              <button
                v-if="o.status === 'draft'"
                type="button"
                class="btn-link delete-link"
                :disabled="deletingId === o.id"
                data-test="delete-draft"
                @click="deleteDraft(o)"
              >{{ deletingId === o.id ? 'Deleting...' : 'Delete' }}</button>
            </td>
          </tr>
          <tr v-if="o.payPath && expanded.has(o.id)" class="link-row">
            <td colspan="7"><CopyLink :payUrl="o.payPath" /></td>
          </tr>
        </template>
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
.dash {
  color: var(--subtle);
}
.actions {
  display: flex;
  gap: 0.9rem;
  align-items: baseline;
}
.resume-link {
  font-weight: 600;
}
.delete-link {
  color: var(--danger);
}
.link-row td {
  background: var(--surface-2);
  padding: 0 0.7rem 0.6rem;
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
