<script setup lang="ts">
// Patient "My Orders" view (owner request: patients had no navigation, and a sent
// order was unreachable once the pay link was lost). Lists the patient's own orders
// from GET /api/patient/orders, each linking to its pay page.
//
// PRIVACY: this is a patient surface. Every field here comes from the server's patient
// whitelist serializer (PatientOrderListItem) - item name/qty/unit price/line total,
// the order subtotal, status and the pay path. COGS, fee, margin and provider economics
// never appear. Money is integer cents from the server, formatted at display only.
//
// Eligibility to pay is taken from the server's `isPayable`, and the link from
// `payPath` - neither is re-derived in the client.
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { apiRequest } from '../../api/client'
import { currentUser } from '../../api/session'
import type { PatientOrdersResponse, PatientOrderListItem, OrderStatus } from '@cerbo/contracts'
import { formatCents } from './format'
import DemoBadge from '../../components/DemoBadge.vue'

type Phase = 'loading' | 'ready' | 'empty' | 'error'

const phase = ref<Phase>('loading')
const orders = ref<PatientOrderListItem[]>([])
const patientName = currentUser()?.displayName ?? ''

function statusClass(status: OrderStatus): string {
  switch (status) {
    case 'paid':
      return 'badge-success'
    case 'sent':
      return 'badge-info'
    case 'refunded':
      return 'badge-warning'
    case 'expired':
    case 'cancelled':
      return 'badge-neutral'
    default:
      return 'badge-neutral'
  }
}

function when(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : '-'
}

async function load(): Promise<void> {
  phase.value = 'loading'
  try {
    const res = await apiRequest<PatientOrdersResponse>('/patient/orders')
    orders.value = res.orders
    phase.value = res.orders.length === 0 ? 'empty' : 'ready'
  } catch {
    phase.value = 'error'
  }
}

onMounted(load)
</script>

<template>
  <section class="my-orders">
    <div class="head">
      <h2>My Orders</h2>
      <DemoBadge reason="Demo affordance - in production a patient reaches their order from an emailed or texted pay link, not by browsing a list." />
    </div>
    <p class="lead" v-if="patientName">Signed in as {{ patientName }}.</p>

    <p v-if="phase === 'loading'" class="notice">Loading your orders...</p>

    <p v-else-if="phase === 'error'" class="page-error" role="alert">
      We could not load your orders. Please try again in a moment.
    </p>

    <p v-else-if="phase === 'empty'" class="notice" role="status">
      You have no orders yet. When your provider sends you one, it will appear here.
    </p>

    <ul v-else class="order-list">
      <li v-for="o in orders" :key="o.orderId" class="order-card">
        <div class="order-top">
          <span class="badge" :class="statusClass(o.status)">{{ o.status }}</span>
          <span class="amount">{{ formatCents(o.amountCents) }}</span>
          <span class="dates">
            Sent {{ when(o.sentAt) }}<template v-if="o.paidAt"> · Paid {{ when(o.paidAt) }}</template>
          </span>
          <span class="spacer" />
          <RouterLink v-if="o.isPayable && o.payPath" class="pay-cta" :to="o.payPath">Review and pay</RouterLink>
        </div>

        <table class="items">
          <thead>
            <tr>
              <th>Item</th>
              <th class="num">Qty</th>
              <th class="num">Unit price</th>
              <th class="num">Line total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, i) in o.items" :key="i">
              <td>{{ item.name }}</td>
              <td class="num">{{ item.qty }}</td>
              <td class="num">{{ formatCents(item.unitPriceCents) }}</td>
              <td class="num">{{ formatCents(item.lineTotalCents) }}</td>
            </tr>
          </tbody>
        </table>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.my-orders {
  max-width: 760px;
  margin: 0 auto;
}
.head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.head h2 {
  margin-bottom: 0;
}
.lead {
  color: var(--muted);
  margin-top: 0.4rem;
}
.order-list {
  list-style: none;
  padding: 0;
  margin: 1rem 0 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.order-card {
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: var(--radius);
  padding: 0.85rem 1rem;
  box-shadow: var(--shadow-sm);
}
.order-top {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.6rem;
}
.amount {
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.dates {
  color: var(--muted);
  font-size: 0.88rem;
}
.spacer {
  flex: 1;
}
.pay-cta {
  display: inline-block;
  padding: 0.4rem 0.9rem;
  border-radius: var(--radius-sm);
  background: var(--brand);
  color: #fff;
  font-weight: 600;
}
.pay-cta:hover {
  background: var(--brand-strong);
  text-decoration: none;
}
.items {
  border-collapse: collapse;
  width: 100%;
}
.items th,
.items td {
  border-bottom: 1px solid var(--border);
  padding: 0.4rem 0.6rem;
  text-align: left;
}
.items tbody tr:last-child td {
  border-bottom: none;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.notice {
  color: var(--muted);
}
</style>
