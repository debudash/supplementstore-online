<script setup lang="ts">
// Patient "My Orders" view (owner request: patients had no navigation, and a sent
// order was unreachable once the pay link was lost). This is the patient's own list of
// orders, each linking to its pay page.
//
// PRIVACY: this is a patient surface. It shows ONLY whitelisted fields the server
// returns (item name/qty/price, order total, status, pay link). COGS, fee, margin and
// any provider economics must never appear here. Money is integer cents from the
// server, formatted at display only - nothing is computed in JS.
//
// API DEPENDENCY: GET /api/patient/orders ({ orders: PatientOrderListItem[] }, using
// payPath and isPayable) is still landing. Until the endpoint and its @cerbo/contracts
// types merge, this view degrades to a clear "not yet available" state and never
// fabricates order data. When it merges, the order list renders here (follow-up).
import { onMounted, ref } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import { currentUser } from '../../api/session'
import DemoBadge from '../../components/DemoBadge.vue'

type Phase = 'loading' | 'ready' | 'empty' | 'unavailable' | 'error'

const phase = ref<Phase>('loading')
const patientName = currentUser()?.displayName ?? ''

async function load(): Promise<void> {
  phase.value = 'loading'
  try {
    // Response rendering is wired to the @cerbo/contracts PatientOrdersResponse type
    // once the endpoint merges; until then a successful call is treated as ready.
    const res = await apiRequest<{ orders: unknown[] }>('/patient/orders')
    phase.value = res.orders.length === 0 ? 'empty' : 'ready'
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 501 || err.code === 'NOT_IMPLEMENTED')) {
      phase.value = 'unavailable'
    } else {
      phase.value = 'error'
    }
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

    <p v-else-if="phase === 'unavailable'" class="notice" role="status">
      Your orders list is not available yet. In the meantime, open the pay link your
      provider sent you to review and pay an order.
    </p>

    <p v-else-if="phase === 'error'" class="page-error" role="alert">
      We could not load your orders. Please try again in a moment.
    </p>

    <p v-else-if="phase === 'empty'" class="notice" role="status">
      You have no orders yet. When your provider sends you one, it will appear here.
    </p>

    <p v-else class="notice" role="status">
      Your orders are ready. The order list appears here.
    </p>
  </section>
</template>

<style scoped>
.my-orders {
  max-width: 720px;
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
</style>
