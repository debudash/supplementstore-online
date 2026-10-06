<script setup lang="ts">
// Provider recurring schedules (FR-12, ADR-017). Create a schedule for a patient with
// SKUs, a locked price per line, and an interval; share the patient authorize link;
// then run a cycle on demand ("Run cycle now") and watch each cycle land as a child
// order - PAID, or ON HOLD with a reason when stock is short, margin would go negative,
// or the patient has not authorized yet. The decision (ADR-017) is the teaching point:
// a cost increase is surfaced as on_hold, never silently absorbed.
//
// The UI only DISPLAYS money; every figure comes from the server (AGENTS.md money rule 2).
import { onMounted, ref, reactive } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import { currentUserId } from '../../api/session'
import type { ProductView, PatientView, ScheduleView, RunCycleResult } from '@cerbo/contracts'
import { formatCents as formatCentsRaw } from '../../components/order/format'

const schedules = ref<ScheduleView[]>([])
const products = ref<ProductView[]>([])
const patients = ref<PatientView[]>([])
const patientsUnavailable = ref(false)
const loadError = ref<string | null>(null)
const pageError = ref<string | null>(null)
const busy = ref(false)
const rowBusyId = ref<string | null>(null)
const origin = typeof location !== 'undefined' ? location.origin : ''

interface DraftLine {
  sku: string
  qty: number
  unitPriceCents: number
}

const form = reactive<{ patientId: string; intervalDays: number; lines: DraftLine[] }>({
  patientId: '',
  intervalDays: 30,
  lines: [{ sku: '', qty: 1, unitPriceCents: 0 }]
})

function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '-'
  return formatCentsRaw(cents)
}

function messageFor(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

async function loadAll(): Promise<void> {
  const [prod, sched] = await Promise.all([
    apiRequest<{ products: ProductView[] }>('/products'),
    apiRequest<{ schedules: ScheduleView[] }>('/schedules')
  ])
  products.value = prod.products
  schedules.value = sched.schedules
  try {
    const res = await apiRequest<{ patients: PatientView[] }>('/patients')
    patients.value = res.patients
    patientsUnavailable.value = false
  } catch (err) {
    if (err instanceof ApiError && (err.status === 501 || err.code === 'NOT_IMPLEMENTED')) {
      patientsUnavailable.value = true
    } else throw err
  }
}

onMounted(async () => {
  try {
    await loadAll()
  } catch (err) {
    loadError.value = messageFor(err)
  }
})

function addDraftLine(): void {
  form.lines.push({ sku: '', qty: 1, unitPriceCents: 0 })
}
function removeDraftLine(i: number): void {
  form.lines.splice(i, 1)
}

async function createSchedule(): Promise<void> {
  pageError.value = null
  const lines = form.lines.filter((l) => l.sku)
  if (!form.patientId || lines.length === 0) {
    pageError.value = 'Choose a patient and at least one line.'
    return
  }
  busy.value = true
  try {
    await apiRequest<ScheduleView>('/schedules', {
      method: 'POST',
      body: { patientId: form.patientId, intervalDays: form.intervalDays, lines }
    })
    form.patientId = ''
    form.intervalDays = 30
    form.lines = [{ sku: '', qty: 1, unitPriceCents: 0 }]
    await loadAll()
  } catch (err) {
    pageError.value = messageFor(err)
  } finally {
    busy.value = false
  }
}

async function act(id: string, action: 'pause' | 'resume' | 'cancel' | 'run'): Promise<void> {
  rowBusyId.value = id
  pageError.value = null
  try {
    if (action === 'run') {
      const res = await apiRequest<RunCycleResult>(`/schedules/${id}/run`, { method: 'POST' })
      // The result is reflected in the reloaded schedule's cycles; note surfaced inline.
      void res
    } else {
      await apiRequest<ScheduleView>(`/schedules/${id}/${action}`, { method: 'POST' })
    }
    await loadAll()
  } catch (err) {
    pageError.value = messageFor(err)
  } finally {
    rowBusyId.value = null
  }
}

async function copy(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(`${location.origin}${url}`)
  } catch {
    /* clipboard may be unavailable; the link text is still shown */
  }
}
</script>

<template>
  <section class="recurring">
    <h2>Recurring</h2>
    <p v-if="loadError" class="page-error" role="alert">{{ loadError }}</p>

    <!-- Create a schedule -->
    <section class="create">
      <h3>New schedule</h3>
      <p v-if="patientsUnavailable" class="notice" role="status">
        The patient list is not available yet.
      </p>
      <template v-else>
        <label class="field">
          Patient
          <select v-model="form.patientId" :disabled="busy">
            <option value="" disabled>Select a patient</option>
            <option v-for="p in patients" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
        <label class="field">
          Interval (days, 7-90)
          <input v-model.number="form.intervalDays" type="number" min="7" max="90" :disabled="busy" />
        </label>

        <div class="lines">
          <div v-for="(line, i) in form.lines" :key="i" class="line-row">
            <select v-model="line.sku" :disabled="busy">
              <option value="" disabled>Select SKU</option>
              <option v-for="pr in products" :key="pr.sku" :value="pr.sku">{{ pr.name }} ({{ pr.sku }})</option>
            </select>
            <input v-model.number="line.qty" type="number" min="1" max="100" :disabled="busy" title="qty" />
            <input v-model.number="line.unitPriceCents" type="number" min="1" :disabled="busy" title="unit price (cents)" />
            <button type="button" class="link" :disabled="busy || form.lines.length === 1" @click="removeDraftLine(i)">remove</button>
          </div>
          <button type="button" class="link" :disabled="busy" @click="addDraftLine">+ add line</button>
        </div>

        <button type="button" :disabled="busy" @click="createSchedule">Create schedule</button>
      </template>
      <p v-if="pageError" class="page-error" role="alert">{{ pageError }}</p>
    </section>

    <!-- Existing schedules -->
    <section class="list">
      <h3>Schedules</h3>
      <p v-if="schedules.length === 0" class="notice">No schedules yet.</p>
      <article v-for="s in schedules" :key="s.id" class="schedule">
        <header class="schedule-head">
          <span class="status" :class="s.status">{{ s.status }}</span>
          <span>every {{ s.intervalDays }} days</span>
          <span>per cycle: {{ formatCents(s.perCycleSubtotalCents) }}</span>
          <span :class="s.authorized ? 'auth-yes' : 'auth-no'">
            {{ s.authorized ? 'authorized' : 'awaiting patient authorization' }}
          </span>
        </header>

        <ul class="items">
          <li v-for="l in s.lines" :key="l.id">{{ l.qty }} x {{ l.name }} @ {{ formatCents(l.unitPriceCents) }}</li>
        </ul>

        <p v-if="!s.authorized && s.payUrl" class="paylink">
          Authorize link: <code>{{ origin }}{{ s.payUrl }}</code>
          <button type="button" class="link" @click="copy(s.payUrl)">copy</button>
        </p>

        <div class="actions">
          <button type="button" :disabled="rowBusyId === s.id || s.status !== 'active'" @click="act(s.id, 'run')">Run cycle now</button>
          <button type="button" class="link" :disabled="rowBusyId === s.id || s.status !== 'active'" @click="act(s.id, 'pause')">pause</button>
          <button type="button" class="link" :disabled="rowBusyId === s.id || s.status !== 'paused'" @click="act(s.id, 'resume')">resume</button>
          <button type="button" class="link" :disabled="rowBusyId === s.id || s.status === 'cancelled'" @click="act(s.id, 'cancel')">cancel</button>
        </div>

        <div v-if="s.cycles.length" class="cycles">
          <h4>Cycles</h4>
          <table>
            <thead><tr><th>#</th><th>status</th><th>reason</th><th>subtotal</th></tr></thead>
            <tbody>
              <tr v-for="c in s.cycles" :key="c.orderId" :class="{ held: c.status === 'on_hold' }">
                <td>{{ c.cycleNumber }}</td>
                <td>{{ c.status }}</td>
                <td>{{ c.holdReason ?? '-' }}</td>
                <td>{{ formatCents(c.subtotalCents) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>
    </section>

    <p class="actor-note">Acting as <code>{{ currentUserId }}</code>.</p>
  </section>
</template>

<style scoped>
.recurring { max-width: 920px; }
.field { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.9em; max-width: 20rem; margin-bottom: 0.6rem; }
.create, .list { margin-bottom: 1.5rem; }
.line-row { display: flex; gap: 0.4rem; align-items: center; margin-bottom: 0.3rem; }
.line-row select { min-width: 16rem; }
.line-row input { width: 7rem; }
.schedule { border: 1px solid #ddd; border-radius: 6px; padding: 0.75rem; margin-bottom: 0.75rem; }
.schedule-head { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.4rem; }
.status { text-transform: uppercase; font-size: 0.8em; font-weight: 700; }
.status.active { color: #1e7e34; }
.status.paused { color: #b8860b; }
.status.cancelled { color: #777; }
.auth-yes { color: #1e7e34; }
.auth-no { color: #b8860b; }
.items { margin: 0.3rem 0; padding-left: 1.2rem; }
.paylink code { font-size: 0.85em; }
.actions { display: flex; gap: 0.8rem; align-items: center; margin: 0.5rem 0; }
.cycles table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
.cycles th, .cycles td { border: 1px solid #ddd; padding: 0.3rem 0.5rem; text-align: left; }
.cycles tr.held { background: #fff4e5; }
.link { background: none; border: none; color: #2a5db0; cursor: pointer; text-decoration: underline; padding: 0; }
.notice { color: #555; }
.page-error { color: #c0392b; border: 1px solid #c0392b; border-radius: 6px; padding: 0.5rem 0.75rem; }
.actor-note { margin-top: 1.5rem; color: #888; font-size: 0.85em; }
</style>
