<script setup lang="ts">
// Patient recurring-authorization page (T7, FR-12 AC2 UI). Reached by an unguessable
// schedule token in the URL - NO X-Demo-User header (AGENTS.md section 7); requests go
// out with `{ auth: false }`.
//
// SCOPE: FR-12 AC2 is the authorize-once UI only. The recurring backend (T9) is CUT,
// so GET /api/pay/schedule/:token and POST /api/pay/schedule/:token/authorize are still
// 501 stubs (code NOT_IMPLEMENTED). This page is built to the documented shape and
// DEGRADES GRACEFULLY on 501 with a clear "not yet available" state. It does NOT
// fabricate schedule data and does NOT implement the backend. When T9 lands it returns
// the real schedule summary and the page will render it.
//
// PRIVACY: as with the pay page, nothing here surfaces provider economics.
import { onMounted, ref, computed } from 'vue'
import { useRoute } from 'vue-router'
import { apiRequest, ApiError } from '../../api/client'
import { formatCents } from './format'

// Minimal forward-looking view of the schedule as a patient would authorize it. No
// canonical contract exists yet (T9 cut), so this is a local, deliberately narrow shape
// - prices and quantities only, never economics. Replace with the @cerbo/contracts type
// when T9 ships it.
interface ScheduleLineView {
  name: string
  qty: number
  unitPriceCents: number
}
interface ScheduleAuthorizeView {
  patientFirstName: string
  intervalDays: number
  items: ScheduleLineView[]
  perCycleTotalCents: number
  authorized: boolean
}

type Phase = 'loading' | 'review' | 'authorized' | 'unavailable' | 'notFound' | 'error'

const route = useRoute()
const token = String(route.params.token)

const phase = ref<Phase>('loading')
const schedule = ref<ScheduleAuthorizeView | null>(null)
const submitting = ref(false)

const title = computed(() => {
  switch (phase.value) {
    case 'loading':
      return 'Loading your plan'
    case 'review':
      return 'Authorize your recurring order'
    case 'authorized':
      return 'Recurring order authorized'
    case 'unavailable':
      return 'Recurring authorization is not yet available'
    case 'notFound':
      return 'Authorization link not found'
    default:
      return 'Something went wrong'
  }
})

async function load(): Promise<void> {
  phase.value = 'loading'
  try {
    schedule.value = await apiRequest<ScheduleAuthorizeView>(`/pay/schedule/${token}`, { auth: false })
    phase.value = schedule.value.authorized ? 'authorized' : 'review'
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NOT_IMPLEMENTED') phase.value = 'unavailable'
    else if (err instanceof ApiError && err.code === 'NOT_FOUND') phase.value = 'notFound'
    else phase.value = 'error'
  }
}

async function authorize(): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  try {
    await apiRequest(`/pay/schedule/${token}/authorize`, { method: 'POST', auth: false })
    phase.value = 'authorized'
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NOT_IMPLEMENTED') phase.value = 'unavailable'
    else phase.value = 'error'
  } finally {
    submitting.value = false
  }
}

onMounted(load)
</script>

<template>
  <main class="authorize">
    <h1>{{ title }}</h1>

    <p v-if="phase === 'loading'" class="notice">Loading...</p>

    <template v-else-if="phase === 'review' && schedule">
      <p v-if="schedule.patientFirstName" class="greeting">Hi {{ schedule.patientFirstName }},</p>
      <p class="lead">
        You are authorizing a recurring order every {{ schedule.intervalDays }} days. You
        authorize once; you can cancel any time by contacting your provider.
      </p>

      <table class="items">
        <thead>
          <tr>
            <th>Item</th>
            <th class="num">Qty</th>
            <th class="num">Unit price</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, i) in schedule.items" :key="i">
            <td>{{ item.name }}</td>
            <td class="num">{{ item.qty }}</td>
            <td class="num">{{ formatCents(item.unitPriceCents) }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th colspan="2" class="num">Per cycle</th>
            <td class="num total">{{ formatCents(schedule.perCycleTotalCents) }}</td>
          </tr>
        </tfoot>
      </table>

      <button type="button" class="authorize-button" :disabled="submitting" @click="authorize">
        {{ submitting ? 'Authorizing...' : 'Authorize recurring order' }}
      </button>
    </template>

    <p v-else-if="phase === 'authorized'" class="success" role="status">
      Your recurring order is authorized. Your provider will process each cycle on schedule.
    </p>

    <p v-else-if="phase === 'unavailable'" class="notice" role="status">
      Recurring order authorization is not available yet. Please check back later or contact
      your provider.
    </p>

    <p v-else-if="phase === 'notFound'" class="notice" role="status">
      We could not find a recurring plan for this link. Please check the link or contact your
      provider.
    </p>

    <p v-else class="notice" role="status">
      We could not load this page. Please try again in a moment.
    </p>
  </main>
</template>

<style scoped>
.authorize {
  max-width: 560px;
  margin: 2rem auto;
  padding: 0 1rem;
}
.greeting {
  font-weight: 600;
}
.lead {
  color: #555;
}
.items {
  border-collapse: collapse;
  width: 100%;
  margin: 1rem 0;
}
.items th,
.items td {
  border: 1px solid #ddd;
  padding: 0.4rem 0.6rem;
  text-align: left;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.total {
  font-weight: 700;
}
.authorize-button {
  font-size: 1.05rem;
  padding: 0.6rem 1.2rem;
  cursor: pointer;
}
.authorize-button:disabled {
  cursor: default;
  opacity: 0.6;
}
.notice {
  color: #555;
}
.success {
  color: #1e7e34;
  font-weight: 600;
}
</style>
