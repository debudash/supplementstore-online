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
// PRIVACY: as with the pay page, nothing here surfaces provider economics. Money is
// display only: the per-cycle total and unit prices are shown as the API returns them;
// no line totals are computed here.
import { onMounted, ref, computed, watch, watchEffect, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { apiRequest, ApiError } from '../../api/client'
import { formatCents } from './format'
import Card from '../../components/ui/Card.vue'
import Money from '../../components/ui/Money.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import UiButton from '../../components/ui/UiButton.vue'

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
const consent = ref(false)
const heading = ref<HTMLHeadingElement | null>(null)

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

const message = computed(() => {
  switch (phase.value) {
    case 'authorized':
      return 'Your recurring order is authorized. Your provider will process each cycle on schedule.'
    case 'unavailable':
      return 'Recurring order authorization is not available yet. Please check back later or contact your provider.'
    case 'notFound':
      return 'We could not find a recurring plan for this link. Please check the link or contact your provider.'
    case 'error':
      return 'We could not load this page. Please try again in a moment.'
    default:
      return ''
  }
})

const tone = computed<'default' | 'success' | 'danger'>(() =>
  phase.value === 'authorized' ? 'success' : phase.value === 'error' ? 'danger' : 'default'
)
const icon = computed(() => (tone.value === 'success' ? '✓' : tone.value === 'danger' ? '!' : phase.value === 'notFound' ? '?' : 'i'))
const isTerminal = computed(() => phase.value !== 'loading' && phase.value !== 'review')

watchEffect(() => {
  if (typeof document !== 'undefined') document.title = `${title.value} - Cerbo`
})

// Move focus to the heading on every phase change so the new state is announced.
watch(phase, async () => {
  await nextTick()
  heading.value?.focus()
})

// Who the patient is authorizing (separate token endpoint; names only). Best-effort.
const payeeLine = ref('')
async function loadPractice(): Promise<void> {
  try {
    const p = await apiRequest<{ practiceName: string | null; providerName: string | null }>(`/pay/schedule/${token}/practice`, { auth: false })
    payeeLine.value = p && typeof p === 'object' ? [p.providerName, p.practiceName].filter(Boolean).join(' · ') : ''
  } catch {
    payeeLine.value = ''
  }
}

async function load(): Promise<void> {
  phase.value = 'loading'
  try {
    schedule.value = await apiRequest<ScheduleAuthorizeView>(`/pay/schedule/${token}`, { auth: false })
    void loadPractice() // only once the link is known to be valid
    phase.value = schedule.value.authorized ? 'authorized' : 'review'
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NOT_IMPLEMENTED') phase.value = 'unavailable'
    else if (err instanceof ApiError && err.code === 'NOT_FOUND') phase.value = 'notFound'
    else phase.value = 'error'
  }
}

async function authorize(): Promise<void> {
  if (submitting.value || !consent.value) return
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
  <div class="authorize-page">
    <p class="sr-only" role="status" aria-live="polite">{{ submitting ? 'Authorizing your recurring order' : '' }}</p>

    <Card :tone="tone" class="authorize-card" :data-phase="phase">
      <span v-if="isTerminal" class="state-icon" :class="`state-icon-${tone}`" aria-hidden="true">{{ icon }}</span>

      <p v-if="payeeLine && phase === 'review'" class="payee" data-testid="payee">{{ payeeLine }}</p>
      <p v-if="phase === 'review' && schedule?.patientFirstName" class="greeting">Hi {{ schedule.patientFirstName }},</p>
      <h1 ref="heading" tabindex="-1" class="authorize-title" :class="{ centered: isTerminal }">{{ title }}</h1>

      <Skeleton v-if="phase === 'loading'" :lines="4" height="1.25rem" label="Loading your plan" />

      <template v-else-if="phase === 'review' && schedule">
        <p class="summary" data-testid="schedule-summary">
          Each order is currently <Money :cents="schedule.perCycleTotalCents" strong />, charged every {{ schedule.intervalDays }} days, for:
        </p>

        <table class="table items">
          <caption class="sr-only">Items in each recurring order</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" class="num">Qty</th>
              <th scope="col" class="num">Unit price</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, i) in schedule.items" :key="i">
              <td>{{ item.name }}</td>
              <td class="num">{{ item.qty }}</td>
              <td class="num"><Money :cents="item.unitPriceCents" /></td>
            </tr>
          </tbody>
        </table>

        <p class="cancel-note" data-testid="price-change-note">The price of each order can change if product costs change.</p>
        <p class="cancel-note">How to cancel: contact your provider. You authorize once; there is nothing to do each cycle.</p>

        <label class="consent">
          <input v-model="consent" type="checkbox" data-testid="consent" />
          <span>
            I authorize recurring charges every {{ schedule.intervalDays }} days for the items above,
            currently {{ formatCents(schedule.perCycleTotalCents) }} per order, until I cancel.
          </span>
        </label>

        <UiButton
          variant="primary"
          block
          class="authorize-button"
          data-testid="authorize-button"
          :disabled="!consent"
          :busy="submitting"
          busy-label="Authorizing..."
          @click="authorize"
        >
          Authorize recurring order
        </UiButton>
      </template>

      <template v-else>
        <p class="message centered" data-testid="authorize-message">{{ message }}</p>
        <div v-if="phase === 'error'" class="retry">
          <UiButton variant="primary" data-testid="retry" @click="load">Retry</UiButton>
        </div>
      </template>
    </Card>
  </div>
</template>

<style scoped>
.authorize-page {
  max-width: 30rem;
  margin: 0 auto;
}
.authorize-card {
  padding: var(--space-6);
}
.payee {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--brand-strong);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-bottom: var(--space-3);
}
.greeting {
  font-weight: 600;
  margin-bottom: var(--space-1);
}
.authorize-title {
  margin-bottom: var(--space-3);
}
/* Focus is moved here programmatically for screen readers; a heading is not
   interactive, so no visible ring. */
.authorize-title:focus,
.authorize-title:focus-visible {
  outline: none;
  box-shadow: none;
}
.centered {
  text-align: center;
}
.state-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 3rem;
  height: 3rem;
  margin: 0 auto var(--space-3);
  border-radius: 50%;
  font-size: var(--text-xl);
  font-weight: 800;
  color: var(--brand-strong);
  background: var(--info-tint);
  border: 2px solid var(--info-border);
}
.state-icon-success {
  color: var(--success);
  background: var(--success-tint);
  border-color: var(--success-border);
}
.state-icon-danger {
  color: var(--danger);
  background: var(--danger-tint);
  border-color: var(--danger-border);
}
.summary {
  font-size: var(--text-lg);
}
.items {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: var(--space-4);
}
.cancel-note {
  color: var(--muted);
  font-size: var(--text-sm);
}
.consent {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-4);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
}
.consent input {
  flex: none;
  margin-top: 0.2rem;
}
.authorize-button {
  min-height: 3rem;
  font-size: var(--text-lg);
}
.retry {
  display: flex;
  justify-content: center;
  margin-top: var(--space-2);
}
@media (max-width: 640px) {
  .authorize-card {
    padding: var(--space-5) var(--space-4);
  }
}
</style>
