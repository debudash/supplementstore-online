<script setup lang="ts">
// Cerbo Admin operations console (FR-9 UI, admin refund) - T11.
//
// Look up first, act second: the operator enters an order id and the view loads the
// read-only admin audit (GET /api/admin/orders/:id/audit) so they can see the order's
// status, amount and timestamps before doing anything. Then:
//  - Fulfill  POST /api/admin/orders/:id/fulfill
//  - Refund   POST /api/admin/orders/:id/refund   { reasonCode } - reason required
//  - Expire reservations  POST /api/admin/jobs/expire-reservations
//  - Run due schedules    POST /api/admin/jobs/run-due-schedules (button disabled: route returns 501, FR-12 AC6)
// Every irreversible action goes through a ConfirmDialog that states the consequence,
// and the server's actual response is shown in a result card.
//
// Money is DISPLAY-only (AGENTS.md money rule 2): amounts come from the audit or the
// action response and are formatted, never computed. The cerbo_admin role is enforced
// server-side on every /api/admin/* route (RT-09).
import { computed, ref } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import type { AuditResponse, RefundReasonCode, RefundResult, FulfillResult } from '@cerbo/contracts'
import { formatMoney, formatBps } from '../../utils/money'
import DemoBadge from '../../components/DemoBadge.vue'
import PageHeader from '../../components/ui/PageHeader.vue'
import Card from '../../components/ui/Card.vue'
import Money from '../../components/ui/Money.vue'
import StatusChip from '../../components/ui/StatusChip.vue'
import UiAlert from '../../components/ui/UiAlert.vue'
import UiField from '../../components/ui/UiField.vue'
import UiButton from '../../components/ui/UiButton.vue'
import ConfirmDialog from '../../components/ui/ConfirmDialog.vue'

// Readable labels for the refund reason codes. Typed as a Record over the contract
// union so tsc fails the build if the union ever changes.
const REASON_LABELS: Record<RefundReasonCode, string> = {
  damaged: 'Damaged',
  wrong_item: 'Wrong item',
  patient_request: 'Patient request',
  provider_error: 'Provider error',
  other: 'Other'
}
const REASON_CODES = Object.keys(REASON_LABELS) as RefundReasonCode[]

type ActionKind = 'fulfill' | 'refund' | 'expire' | 'schedules'

interface ActionResult {
  kind: ActionKind
  title: string
  ok: boolean
  /** HTTP status and error code when the server rejected the call. */
  status?: number
  code?: string
  message?: string
  /** The JSON body the server returned on success. */
  body?: unknown
}

const orderIdInput = ref('')
const lookupBusy = ref(false)
const lookupError = ref<string | null>(null)
const audit = ref<AuditResponse | null>(null)

const reasonCode = ref<RefundReasonCode | ''>('')
const reasonError = ref<string | null>(null)

const pending = ref<ActionKind | null>(null)
const busy = ref<ActionKind | null>(null)
const result = ref<ActionResult | null>(null)

const order = computed(() => audit.value?.order ?? null)
const canFulfill = computed(() => order.value?.status === 'paid' && !order.value.fulfilledAt)
const canRefund = computed(() => order.value?.status === 'paid')
const fulfillBlockedReason = computed(() => {
  if (!order.value) return ''
  if (order.value.fulfilledAt) return 'Already fulfilled.'
  if (order.value.status !== 'paid') return 'Only a paid order can be fulfilled.'
  return ''
})

const fmtDate = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : '-')

async function fetchAudit(id: string): Promise<void> {
  audit.value = await apiRequest<AuditResponse>(`/admin/orders/${encodeURIComponent(id)}/audit`)
}

async function lookup(): Promise<void> {
  const id = orderIdInput.value.trim()
  lookupError.value = null
  result.value = null
  reasonCode.value = ''
  reasonError.value = null
  if (!id) {
    lookupError.value = 'Enter an order id.'
    return
  }
  lookupBusy.value = true
  audit.value = null
  try {
    await fetchAudit(id)
  } catch (err) {
    lookupError.value =
      err instanceof ApiError && err.status === 404
        ? 'No order with that id.'
        : err instanceof ApiError
          ? err.message
          : 'Could not load the order.'
  } finally {
    lookupBusy.value = false
  }
}

function askRefund(): void {
  if (!reasonCode.value) {
    reasonError.value = 'Choose a reason before refunding.'
    return
  }
  reasonError.value = null
  pending.value = 'refund'
}

const dialog = computed(() => {
  const amount = formatMoney(order.value?.subtotalCents)
  switch (pending.value) {
    case 'fulfill':
      return { title: 'Fulfill this order?', confirmLabel: 'Fulfill order', tone: 'primary' as const }
    case 'refund':
      return { title: `Refund ${amount}?`, confirmLabel: 'Refund order', tone: 'danger' as const }
    case 'expire':
      return { title: 'Expire due reservations?', confirmLabel: 'Run expire job', tone: 'primary' as const }
    case 'schedules':
      return { title: 'Run due schedules?', confirmLabel: 'Run schedules job', tone: 'primary' as const }
    default:
      return { title: '', confirmLabel: 'Confirm', tone: 'primary' as const }
  }
})

const TITLES: Record<ActionKind, string> = {
  fulfill: 'Fulfill',
  refund: 'Refund',
  expire: 'Expire due reservations',
  schedules: 'Run due schedules'
}

async function confirmAction(): Promise<void> {
  const kind = pending.value
  if (!kind) return
  // Guard again: a refund can never be sent without a reason.
  if (kind === 'refund' && !reasonCode.value) {
    reasonError.value = 'Choose a reason before refunding.'
    pending.value = null
    return
  }
  const id = order.value?.id ?? ''
  busy.value = kind
  try {
    let body: unknown
    if (kind === 'fulfill') {
      body = await apiRequest<FulfillResult>(`/admin/orders/${encodeURIComponent(id)}/fulfill`, { method: 'POST' })
    } else if (kind === 'refund') {
      body = await apiRequest<RefundResult>(`/admin/orders/${encodeURIComponent(id)}/refund`, {
        method: 'POST',
        body: { reasonCode: reasonCode.value }
      })
    } else if (kind === 'expire') {
      body = await apiRequest<{ expired: string[] }>('/admin/jobs/expire-reservations', { method: 'POST' })
    } else {
      body = await apiRequest('/admin/jobs/run-due-schedules', { method: 'POST' })
    }
    result.value = { kind, title: TITLES[kind], ok: true, body }
    if ((kind === 'fulfill' || kind === 'refund') && id) await fetchAudit(id).catch(() => undefined)
  } catch (err) {
    result.value =
      err instanceof ApiError
        ? { kind, title: TITLES[kind], ok: false, status: err.status, code: err.code, message: err.message }
        : { kind, title: TITLES[kind], ok: false, message: 'The request failed.' }
  } finally {
    busy.value = null
    pending.value = null
  }
}

const refundBody = computed(() => (result.value?.ok && result.value.kind === 'refund' ? (result.value.body as RefundResult) : null))
const fulfillBody = computed(() => (result.value?.ok && result.value.kind === 'fulfill' ? (result.value.body as FulfillResult) : null))
const expireBody = computed(() => (result.value?.ok && result.value.kind === 'expire' ? (result.value.body as { expired: string[] }) : null))
const rawBody = computed(() => (result.value?.ok ? JSON.stringify(result.value.body, null, 2) : ''))
</script>

<template>
  <section class="admin-ops">
    <PageHeader title="Operations" subtitle="Look up an order, then fulfill or refund it. Demo jobs run background work on demand." />

    <Card title="Find an order">
      <form class="lookup" novalidate @submit.prevent="lookup">
        <UiField v-slot="f" label="Order id" :error="lookupError" class="lookup-field">
          <input
            :id="f.id"
            v-model="orderIdInput"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="Order uuid"
            :aria-describedby="f.describedby"
            :aria-invalid="f.invalid ? 'true' : undefined"
            data-testid="order-id-input"
          />
        </UiField>
        <UiButton type="submit" variant="primary" :busy="lookupBusy" busy-label="Looking up..." data-testid="order-lookup">
          Look up
        </UiButton>
      </form>

      <div v-if="order" class="summary" data-testid="order-summary" aria-live="polite">
        <div class="summary-head">
          <StatusChip :status="order.status" />
          <span v-if="order.fulfilledAt" class="badge badge-success">Fulfilled</span>
          <span v-if="order.isSynthetic" class="badge demo-badge">Synthetic</span>
          <code class="order-code">{{ order.id }}</code>
        </div>
        <dl class="facts">
          <div><dt>Order total</dt><dd><Money :cents="order.subtotalCents" strong /></dd></div>
          <div><dt>Platform fee</dt><dd>{{ formatBps(order.feeBps) }}</dd></div>
          <div>
            <dt>Patient</dt>
            <dd>
              <span v-if="order.patientName" :title="order.patientId">{{ order.patientName }}</span>
              <code v-else :title="order.patientId">{{ order.patientId }}</code>
            </dd>
          </div>
          <div v-if="order.providerName">
            <dt>Provider</dt>
            <dd>{{ order.providerName }}<span v-if="order.practiceName" class="subtle"> · {{ order.practiceName }}</span></dd>
          </div>
          <div><dt>Paid</dt><dd>{{ fmtDate(order.paidAt) }}</dd></div>
          <div><dt>Fulfilled</dt><dd>{{ fmtDate(order.fulfilledAt) }}</dd></div>
          <div v-if="order.refundedAt"><dt>Refunded</dt><dd>{{ fmtDate(order.refundedAt) }}</dd></div>
          <div><dt>Items</dt><dd>{{ audit?.lines.length ?? 0 }} line(s)</dd></div>
        </dl>
        <!-- The provider's markup per line (ADR-028): Cerbo tracks it, it never sets it. -->
        <ul v-if="audit?.lines.length" class="markups" data-testid="order-markups">
          <li v-for="l in audit.lines" :key="l.id">
            {{ l.qty }} × {{ l.name }} -
            <template v-if="l.unitMarkupCents !== null">provider markup <Money :cents="l.unitMarkupCents" /> per unit</template>
            <span v-else class="subtle">priced before markup tracking</span>
          </li>
        </ul>
      </div>
    </Card>

    <Card v-if="order" title="Actions" class="section">
      <div class="action-block">
        <div>
          <UiButton variant="primary" :disabled="!canFulfill || busy !== null" data-testid="fulfill-open" @click="pending = 'fulfill'">
            Fulfill
          </UiButton>
          <p class="subtle">{{ fulfillBlockedReason || 'Marks the order shipped from the shared pool.' }}</p>
        </div>
      </div>

      <div class="refund-block">
        <h3 class="block-title">Refund</h3>
        <p class="subtle">Whole-order refund. The patient gets back everything they paid.</p>
        <div class="row">
          <UiField v-slot="f" label="Reason" :error="reasonError" class="reason-field">
            <select
              :id="f.id"
              v-model="reasonCode"
              required
              :disabled="!canRefund"
              :aria-describedby="f.describedby"
              :aria-invalid="f.invalid ? 'true' : undefined"
              data-testid="refund-reason"
              @change="reasonError = null"
            >
              <option value="" disabled>Choose a reason</option>
              <option v-for="code in REASON_CODES" :key="code" :value="code">{{ REASON_LABELS[code] }}</option>
            </select>
          </UiField>
          <UiButton variant="danger" :disabled="!canRefund || busy !== null" data-testid="refund-open" @click="askRefund">
            Refund
          </UiButton>
        </div>
        <p v-if="!canRefund" class="subtle">Only a paid order can be refunded.</p>
      </div>
    </Card>

    <Card class="section" title="Demo jobs" subtitle="Run on demand what a background scheduler does in production, so a demo is deterministic.">
      <template #actions>
        <DemoBadge reason="Demo affordance - runs on demand what a background scheduler does automatically in production, so a demo is deterministic." />
      </template>
      <div class="jobs">
        <div class="job">
          <UiButton :disabled="busy !== null" :busy="busy === 'expire'" busy-label="Running..." data-testid="job-expire" @click="pending = 'expire'">
            Expire due reservations
          </UiButton>
          <p class="subtle">Releases stock held by sent orders whose 7-day reservation has lapsed.</p>
        </div>
        <div class="job">
          <UiButton disabled data-testid="job-schedules">
            Run due schedules
          </UiButton>
          <p class="subtle">Not wired yet: the recurring sweep exists but this route returns 501 until a real scheduler owns it. Run a cycle from the provider's Recurring page ("Run cycle now").</p>
        </div>
      </div>
    </Card>

    <div aria-live="polite" class="section">
      <Card v-if="result" :title="`${result.title}: ${result.ok ? 'done' : 'not completed'}`" :tone="result.ok ? 'success' : result.status === 501 ? 'warning' : 'danger'" data-testid="action-result">
        <template v-if="result.ok">
          <dl v-if="refundBody" class="facts">
            <div><dt>Refunded to patient</dt><dd><Money :cents="refundBody.amountCents" strong /></dd></div>
            <div><dt>Platform fee kept</dt><dd><Money :cents="refundBody.feeRetainedCents" /></dd></div>
            <div><dt>Reason</dt><dd>{{ REASON_LABELS[refundBody.reasonCode] ?? refundBody.reasonCode }}</dd></div>
            <div>
              <dt>Stock</dt>
              <dd>
                <template v-if="refundBody.restocked">Units returned to stock</template>
                <template v-else>Written off (cost <Money :cents="refundBody.writeoffCogsCents" />)</template>
              </dd>
            </div>
          </dl>
          <dl v-else-if="fulfillBody" class="facts">
            <div><dt>Status</dt><dd><StatusChip :status="fulfillBody.status" /></dd></div>
            <div><dt>Fulfilled at</dt><dd>{{ fmtDate(fulfillBody.fulfilledAt) }}</dd></div>
          </dl>
          <p v-else-if="expireBody">
            <template v-if="expireBody.expired.length === 0">No reservations were due.</template>
            <template v-else>
              Expired {{ expireBody.expired.length }} order(s):
              <code v-for="id in expireBody.expired" :key="id" class="id-chip">{{ id }}</code>
            </template>
          </p>
          <details class="raw" :open="!refundBody && !fulfillBody && !expireBody">
            <summary>Server response</summary>
            <pre data-testid="action-result-raw">{{ rawBody }}</pre>
          </details>
        </template>
        <template v-else>
          <p class="error-line" role="alert">
            <template v-if="result.status">Server replied {{ result.status }} <code>{{ result.code }}</code>: </template>{{ result.message }}
          </p>
        </template>
      </Card>
    </div>

    <ConfirmDialog
      :open="pending !== null"
      :title="dialog.title"
      :confirm-label="dialog.confirmLabel"
      :tone="dialog.tone"
      :busy="busy !== null"
      @confirm="confirmAction"
      @cancel="pending = null"
    >
      <template v-if="pending === 'fulfill'">
        <p>Marks order <code>{{ order?.id }}</code> as fulfilled. This cannot be undone.</p>
        <p class="subtle">A refund after fulfillment writes off the cost of goods instead of restocking.</p>
      </template>
      <template v-else-if="pending === 'refund'">
        <p data-testid="refund-consequence">
          Refunds {{ formatMoney(order?.subtotalCents) }} to the patient in full. The {{ formatBps(order?.feeBps) }} platform
          fee is kept. This cannot be undone.
        </p>
        <p class="subtle">Reason: <strong>{{ reasonCode ? REASON_LABELS[reasonCode] : '' }}</strong></p>
      </template>
      <template v-else-if="pending === 'expire'">
        <p>Moves every sent order whose 7-day reservation has lapsed to Expired and releases its held stock. This cannot be undone.</p>
      </template>
      <template v-else-if="pending === 'schedules'">
        <p>Charges every recurring order whose next cycle is due. Charges cannot be undone.</p>
      </template>
      <UiAlert v-if="pending && pending !== 'fulfill' && pending !== 'refund'" tone="info">
        <DemoBadge reason="Demo affordance - in production this job runs on a timer." /> Runs the background job now.
      </UiAlert>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.admin-ops {
  max-width: 920px;
}
.section {
  margin-top: var(--space-4);
}
.lookup {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: flex-start;
}
.lookup-field {
  flex: 1 1 18rem;
}
.lookup > button {
  margin-top: 1.55rem;
}
.summary {
  margin-top: var(--space-5);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border);
}
.summary-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.order-code {
  font-size: var(--text-sm);
}
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr));
  gap: var(--space-3);
  margin: 0;
}
.facts dt {
  font-size: var(--text-xs);
  color: var(--muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.facts dd {
  margin: var(--space-1) 0 0;
  overflow-wrap: anywhere;
}
.subtle {
  margin: var(--space-1) 0 0;
}
.refund-block {
  margin-top: var(--space-5);
  padding-top: var(--space-4);
  border-top: 2px solid var(--danger-border);
}
.block-title {
  font-size: var(--text-md);
  margin: 0;
  color: var(--danger);
}
.refund-block .row {
  margin-top: var(--space-3);
}
.reason-field {
  flex: 1 1 14rem;
}
.jobs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
  gap: var(--space-4);
}
.id-chip {
  margin-right: var(--space-1);
}
.raw {
  margin-top: var(--space-3);
}
.raw summary {
  cursor: pointer;
  font-weight: 600;
  font-size: var(--text-sm);
}
.raw pre {
  margin: var(--space-2) 0 0;
  padding: var(--space-3);
  background: var(--surface-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.error-line {
  margin: 0;
  color: var(--danger-strong);
}
@media (max-width: 480px) {
  .lookup > button {
    margin-top: 0;
    width: 100%;
  }
}
.markups {
  margin: var(--space-3) 0 0;
  padding-left: var(--space-5);
  font-size: var(--text-sm);
}
</style>
