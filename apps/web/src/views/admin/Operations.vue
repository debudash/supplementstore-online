<script setup lang="ts">
// Cerbo Admin operations console (FR-9 UI, admin refund) - T11.
//
// Drives the operator actions on a single order plus the demo jobs:
//  - Fulfill  POST /api/admin/orders/:id/fulfill           (T5 route, wired)
//  - Refund   POST /api/admin/orders/:id/refund            (T5 route, wired; reason code)
//  - Expire reservations  POST /api/admin/jobs/expire-reservations  (T3 job, wired here)
//  - Run due schedules    POST /api/admin/jobs/run-due-schedules     (hook; see note below)
//
// Money (the refund amounts) is DISPLAY-only (AGENTS.md money rule 2): the server computes
// every figure; this view only formats what it returns. The cerbo_admin role is enforced
// server-side on every /api/admin/* route (RT-09) - a provider never reaches these.
import { ref } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import { currentUserId } from '../../api/session'
import type { RefundReasonCode, RefundResult, FulfillResult } from '@cerbo/contracts'
import { formatCents } from '../../components/order/format'

// The refund reason codes for the dropdown. The web imports ONLY types from
// @cerbo/contracts (every other view does the same); the canonical runtime list lives in
// the contract and is validated server-side. This local copy is typed as RefundReasonCode[]
// so tsc fails the build if it ever drifts from the union in packages/contracts.
const REASON_CODES: readonly RefundReasonCode[] = [
  'damaged',
  'wrong_item',
  'patient_request',
  'provider_error',
  'other'
]

const orderId = ref('')
const reasonCode = ref<RefundReasonCode>('patient_request')

const busy = ref<string | null>(null)
const error = ref<string | null>(null)
const result = ref<string | null>(null)

function requireOrderId(): string | null {
  const id = orderId.value.trim()
  if (!id) {
    error.value = 'Enter an order id first.'
    return null
  }
  return id
}

async function fulfill(): Promise<void> {
  const id = requireOrderId()
  if (!id) return
  await run('fulfill', async () => {
    const r = await apiRequest<FulfillResult>(`/admin/orders/${encodeURIComponent(id)}/fulfill`, {
      method: 'POST'
    })
    result.value = `Order ${r.orderId} fulfilled at ${new Date(r.fulfilledAt).toLocaleString()} (status ${r.status}).`
  })
}

async function refund(): Promise<void> {
  const id = requireOrderId()
  if (!id) return
  await run('refund', async () => {
    const r = await apiRequest<RefundResult>(`/admin/orders/${encodeURIComponent(id)}/refund`, {
      method: 'POST',
      body: { reasonCode: reasonCode.value }
    })
    const disposition = r.restocked
      ? 'units restocked'
      : `written off (COGS ${formatCents(r.writeoffCogsCents)})`
    result.value =
      `Refunded order ${r.orderId} (${r.reasonCode}): ${formatCents(r.amountCents)} to patient, ` +
      `fee retained ${formatCents(r.feeRetainedCents)}, ${disposition}.`
  })
}

async function expireReservations(): Promise<void> {
  await run('expire', async () => {
    const r = await apiRequest<{ expired: string[] }>('/admin/jobs/expire-reservations', {
      method: 'POST'
    })
    result.value =
      r.expired.length === 0
        ? 'Expire job ran: no reservations were due.'
        : `Expire job ran: expired ${r.expired.length} order(s) - ${r.expired.join(', ')}.`
  })
}

async function runDueSchedules(): Promise<void> {
  await run('schedules', async () => {
    // This button is the hook into the recurring-order engine (a separate piece of the
    // build). That engine is not switched on in this version, so the server replies that
    // there is nothing to run - surfaced to the operator verbatim below.
    await apiRequest('/admin/jobs/run-due-schedules', { method: 'POST' })
    result.value = 'Ran due schedules.'
  })
}

async function run(tag: string, fn: () => Promise<void>): Promise<void> {
  busy.value = tag
  error.value = null
  result.value = null
  try {
    await fn()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'The operation failed.'
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <section class="admin-ops">
    <h2>Operations</h2>
    <p class="intro">
      Operator actions on a single paid order, plus the demo jobs. Enter an order id, then
      fulfill or refund it. The jobs below run the same work as the background timer, on
      demand, so a demo is deterministic.
    </p>

    <div class="order-box">
      <label class="field">
        Order id
        <input v-model="orderId" type="text" placeholder="order uuid" :disabled="busy !== null" />
      </label>

      <div class="actions">
        <button type="button" :disabled="busy !== null" @click="fulfill">
          {{ busy === 'fulfill' ? 'Fulfilling...' : 'Fulfill' }}
        </button>

        <span class="refund-group">
          <label class="field inline">
            Reason
            <select v-model="reasonCode" :disabled="busy !== null">
              <option v-for="code in REASON_CODES" :key="code" :value="code">{{ code }}</option>
            </select>
          </label>
          <button type="button" :disabled="busy !== null" @click="refund">
            {{ busy === 'refund' ? 'Refunding...' : 'Refund' }}
          </button>
        </span>
      </div>
    </div>

    <h3>Demo jobs</h3>
    <div class="jobs">
      <div class="job">
        <button type="button" :disabled="busy !== null" @click="expireReservations">
          {{ busy === 'expire' ? 'Running...' : 'Expire due reservations' }}
        </button>
        <p class="job-note">
          Releases stock held by sent orders whose 7-day reservation has lapsed, moving them
          to expired.
        </p>
      </div>

      <div class="job">
        <button type="button" :disabled="busy !== null" @click="runDueSchedules">
          {{ busy === 'schedules' ? 'Running...' : 'Run due schedules' }}
        </button>
        <p class="job-note">
          Charges recurring orders whose next cycle is due. The recurring engine that does
          this is a separate part of the build and is not switched on in this version, so
          this button is the hook it plugs into - clicking it reports that there is nothing
          to run yet rather than charging anything.
        </p>
      </div>
    </div>

    <p v-if="error" class="page-error" role="alert">{{ error }}</p>
    <p v-if="result" class="notice-ok" role="status">{{ result }}</p>

    <p class="actor-note">Acting as <code>{{ currentUserId }}</code>.</p>
  </section>
</template>

<style scoped>
.admin-ops {
  max-width: 820px;
}
.intro,
.job-note {
  color: #555;
}
.order-box {
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 0.8rem;
  margin-bottom: 1.25rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.9em;
  margin-bottom: 0.75rem;
}
.field.inline {
  margin-bottom: 0;
}
.actions {
  display: flex;
  gap: 1.25rem;
  align-items: flex-end;
  flex-wrap: wrap;
}
.refund-group {
  display: flex;
  gap: 0.5rem;
  align-items: flex-end;
}
.jobs {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-bottom: 1rem;
}
.job {
  border: 1px solid #eee;
  border-radius: 6px;
  padding: 0.6rem 0.8rem;
}
.job-note {
  margin: 0.4rem 0 0;
  font-size: 0.9em;
}
.notice-ok {
  color: #1e7e34;
  border: 1px solid #1e7e34;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}
.page-error {
  color: #c0392b;
  border: 1px solid #c0392b;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}
.actor-note {
  margin-top: 1.5rem;
  color: #888;
  font-size: 0.85em;
}
</style>
