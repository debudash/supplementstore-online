<script setup lang="ts">
// Provider recurring schedules (FR-12, ADR-017, ADR-028). Create a schedule for a patient
// (products, quantities, a per-unit markup, interval), share the patient authorize link,
// then run a cycle on demand and watch each cycle land as a child order - Paid, or On hold
// with a reason the provider can act on. Each cycle charges Cerbo's CURRENT cost + the
// markup + the platform fee, so the per-cycle price shown here is indicative.
//
// The UI only DISPLAYS money; every figure comes from the server (AGENTS.md money rule 2).
import { onMounted, ref, reactive, computed } from 'vue'
import { RouterLink } from 'vue-router'
import { apiRequest, ApiError } from '../../api/client'
import type { ProductView, PatientView, ScheduleView, ScheduleCycleView, RunCycleResult, HoldReason } from '@cerbo/contracts'
import DemoBadge from '../../components/DemoBadge.vue'
import PageHeader from '../../components/ui/PageHeader.vue'
import Card from '../../components/ui/Card.vue'
import Money from '../../components/ui/Money.vue'
import StatusChip from '../../components/ui/StatusChip.vue'
import UiAlert from '../../components/ui/UiAlert.vue'
import UiField from '../../components/ui/UiField.vue'
import UiButton from '../../components/ui/UiButton.vue'
import QuantityStepper from '../../components/ui/QuantityStepper.vue'
import ConfirmDialog from '../../components/ui/ConfirmDialog.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import { toast } from '../../components/ui/toast'
import { formatMoney } from '../../utils/money'
import { dollarsToCents } from '../../components/order/format'

const COGS_REASON =
  "COGS is Cerbo's wholesale cost, shown in this list only to make the economics demonstrable. A prescribing doctor would not normally see it."

/** Each hold reason in plain words, with what the provider can do about it. */
const HOLD_REASONS: Record<HoldReason, { label: string; fix: string }> = {
  INSUFFICIENT_STOCK: {
    label: 'Not enough stock',
    fix: 'One or more items ran short. Run the cycle again once stock is back.'
  },
  MARGIN_NEGATIVE: {
    label: 'Margin would be negative',
    fix: "This cycle's price no longer covers Cerbo's cost plus the platform fee. Run the cycle again; if it is still held, contact Cerbo."
  },
  NOT_AUTHORIZED: {
    label: 'Patient has not authorized',
    fix: 'Send the patient the authorize link below. Once they authorize, run the cycle again.'
  },
  PAYMENT_DECLINED: {
    label: 'Payment was declined',
    fix: 'Ask the patient to update their payment method, then run the cycle again.'
  }
}
function holdLabel(reason: HoldReason | null): string {
  if (!reason) return '-'
  return HOLD_REASONS[reason]?.label ?? reason.replace(/_/g, ' ').toLowerCase()
}
function holdFix(reason: HoldReason | null): string {
  if (!reason) return 'Check the schedule, then run the cycle again.'
  return HOLD_REASONS[reason]?.fix ?? 'Check the schedule, then run the cycle again.'
}

const schedules = ref<ScheduleView[]>([])
const products = ref<ProductView[]>([])
const patients = ref<PatientView[]>([])
const patientsUnavailable = ref(false)
const loading = ref(true)
const loadError = ref<string | null>(null)
const formError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const busy = ref(false)
const rowBusyId = ref<string | null>(null)
const cancelTarget = ref<ScheduleView | null>(null)
const copiedId = ref<string | null>(null)
const origin = typeof location !== 'undefined' ? location.origin : ''

interface DraftLine {
  sku: string
  qty: number | string
  /** Per-unit markup in dollars as typed, e.g. "10" or "12.50" (ADR-028). */
  markup: string
}

const form = reactive<{ patientId: string; intervalDays: number | string; lines: DraftLine[] }>({
  patientId: '',
  intervalDays: 30,
  lines: [{ sku: '', qty: 1, markup: '' }]
})

const intervalError = computed(() => {
  const n = Number(form.intervalDays)
  return Number.isInteger(n) && n >= 7 && n <= 90 ? null : 'Enter a whole number of days from 7 to 90.'
})

function productOf(sku: string): ProductView | null {
  return products.value.find((p) => p.sku === sku) ?? null
}


function patientName(id: string): string {
  return patients.value.find((p) => p.id === id)?.name ?? 'Patient'
}

function shortDate(value: string | null): string {
  if (!value) return '-'
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
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

async function initialLoad(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    await loadAll()
  } catch (err) {
    loadError.value = messageFor(err)
  } finally {
    loading.value = false
  }
}

onMounted(initialLoad)

function addDraftLine(): void {
  form.lines.push({ sku: '', qty: 1, markup: '' })
}
function removeDraftLine(i: number): void {
  form.lines.splice(i, 1)
}
function lineName(line: DraftLine, i: number): string {
  const p = line.sku ? productOf(line.sku) : null
  return p ? `line ${i + 1}, ${p.name}` : `line ${i + 1}`
}

async function createSchedule(): Promise<void> {
  formError.value = null
  const draftLines = form.lines.filter((l) => l.sku)
  if (!form.patientId || draftLines.length === 0) {
    formError.value = 'Choose a patient and at least one product.'
    return
  }
  if (intervalError.value) {
    formError.value = intervalError.value
    return
  }
  for (const l of draftLines) {
    const qty = Math.trunc(Number(l.qty))
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) {
      formError.value = 'Quantity must be a whole number from 1 to 100.'
      return
    }
    const markupCents = dollarsToCents(l.markup)
    if (markupCents === null || markupCents > 100000) {
      formError.value = 'Enter your markup per unit in dollars, from 0 to 1000, for every product.'
      return
    }
  }
  // Each line carries the provider's markup; the server derives every cycle's price (ADR-028).
  const lines = draftLines.map((l) => ({
    sku: l.sku,
    qty: Math.trunc(Number(l.qty)),
    markupCents: dollarsToCents(l.markup) as number
  }))
  busy.value = true
  try {
    await apiRequest<ScheduleView>('/schedules', {
      method: 'POST',
      body: { patientId: form.patientId, intervalDays: Number(form.intervalDays), lines }
    })
    const name = patientName(form.patientId)
    form.patientId = ''
    form.intervalDays = 30
    form.lines = [{ sku: '', qty: 1, markup: '' }]
    await loadAll()
    toast(`Schedule created for ${name}.`)
  } catch (err) {
    formError.value = messageFor(err)
  } finally {
    busy.value = false
  }
}

function runResultMessage(res: RunCycleResult): { text: string; tone: 'success' | 'warning' | 'info' } {
  const c = res.cycle
  if (!c) return { text: res.note || 'Nothing was due, so no cycle ran.', tone: 'info' }
  if (c.status === 'paid') return { text: `Cycle ${c.cycleNumber} paid (${formatMoney(c.subtotalCents)}).`, tone: 'success' }
  if (c.status === 'on_hold') return { text: `Cycle ${c.cycleNumber} is on hold: ${holdLabel(c.holdReason)}.`, tone: 'warning' }
  return { text: `Cycle ${c.cycleNumber}: ${c.status}.`, tone: 'info' }
}

async function act(s: ScheduleView, action: 'pause' | 'resume' | 'cancel' | 'run'): Promise<void> {
  rowBusyId.value = s.id
  actionError.value = null
  try {
    if (action === 'run') {
      const res = await apiRequest<RunCycleResult>(`/schedules/${s.id}/run`, { method: 'POST' })
      const msg = runResultMessage(res)
      toast(msg.text, msg.tone)
    } else {
      await apiRequest<ScheduleView>(`/schedules/${s.id}/${action}`, { method: 'POST' })
      toast(action === 'pause' ? 'Schedule paused.' : action === 'resume' ? 'Schedule resumed.' : 'Schedule cancelled.')
    }
    await loadAll()
  } catch (err) {
    actionError.value = messageFor(err)
  } finally {
    rowBusyId.value = null
  }
}

async function confirmCancel(): Promise<void> {
  const s = cancelTarget.value
  if (!s) return
  await act(s, 'cancel')
  cancelTarget.value = null
}

async function copy(s: ScheduleView): Promise<void> {
  try {
    await navigator.clipboard.writeText(`${origin}${s.payUrl}`)
    copiedId.value = s.id
  } catch {
    copiedId.value = null
    toast('Copy is unavailable - select the link and copy it manually.', 'warning')
  }
}

const heldCycles = (s: ScheduleView): ScheduleCycleView[] => s.cycles.filter((c) => c.status === 'on_hold')
</script>

<template>
  <section class="recurring">
    <PageHeader title="Recurring" subtitle="Repeat orders that run on a schedule once the patient authorizes them." />

    <UiAlert v-if="loadError" tone="danger" title="Could not load schedules">
      {{ loadError }}
      <template #actions><button type="button" class="btn-sm" data-testid="recurring-retry" @click="initialLoad">Try again</button></template>
    </UiAlert>

    <Skeleton v-if="loading" :lines="4" height="2.5rem" label="Loading schedules" />

    <div v-else class="stack">
      <!-- Create a schedule -->
      <Card title="New schedule" subtitle="Each cycle charges Cerbo's current cost + your markup + the 0.75% platform fee, so you keep your markup.">
        <UiAlert v-if="patientsUnavailable" tone="info">The patient list is not available yet.</UiAlert>
        <form v-else class="create" novalidate @submit.prevent="createSchedule">
          <div class="grid-2">
            <UiField v-slot="f" label="Patient">
              <select :id="f.id" v-model="form.patientId" :disabled="busy" data-testid="schedule-patient">
                <option value="" disabled>Select a patient</option>
                <option v-for="p in patients" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </UiField>
            <UiField v-slot="f" label="Every (days)" hint="Between 7 and 90 days." :error="intervalError">
              <input
                :id="f.id"
                v-model="form.intervalDays"
                type="number"
                inputmode="numeric"
                min="7"
                max="90"
                step="1"
                class="interval"
                :aria-describedby="f.describedby"
                :aria-invalid="f.invalid ? 'true' : undefined"
                :disabled="busy"
                data-testid="schedule-interval"
              />
            </UiField>
          </div>

          <fieldset class="lines">
            <legend>Products</legend>
            <p class="subtle cogs-note">Product options show Cerbo's cost. <DemoBadge label="Demo: COGS" :reason="COGS_REASON" /></p>
            <div v-for="(line, i) in form.lines" :key="i" class="draft-line" data-testid="draft-line">
              <div class="line-field product">
                <label :for="`line-sku-${i}`" class="field-label">Product {{ form.lines.length > 1 ? i + 1 : '' }}</label>
                <select :id="`line-sku-${i}`" v-model="line.sku" :disabled="busy" :data-testid="`line-sku-${i}`">
                  <option value="" disabled>Select a product</option>
                  <option v-for="pr in products" :key="pr.sku" :value="pr.sku">
                    {{ pr.name }} ({{ pr.sku }}) - COGS {{ formatMoney(pr.unitCogsCents) }} -
                    {{ pr.available > 0 ? `${pr.available} available` : 'unavailable' }}
                  </option>
                </select>
              </div>
              <div class="line-field">
                <span class="field-label" aria-hidden="true">Quantity</span>
                <QuantityStepper v-model="line.qty" :label="`Quantity for line ${i + 1}`" :disabled="busy" :input-test-id="`line-qty-${i}`" />
              </div>
              <div class="line-field">
                <label :for="`line-markup-${i}`" class="field-label">Your markup <span class="subtle">($ per unit)</span></label>
                <span class="dollar">
                  <span aria-hidden="true">$</span>
                  <input
                    :id="`line-markup-${i}`"
                    v-model="line.markup"
                    type="text"
                    inputmode="decimal"
                    placeholder="e.g. 10.00"
                    class="markup-input"
                    :disabled="busy"
                    :data-testid="`line-markup-${i}`"
                  />
                </span>
              </div>
              <button
                type="button"
                class="btn-link remove"
                :disabled="busy || form.lines.length === 1"
                :aria-label="`Remove ${lineName(line, i)}`"
                :data-testid="`remove-line-${i}`"
                @click="removeDraftLine(i)"
              >Remove</button>
            </div>
            <button type="button" class="btn-link" :disabled="busy" data-testid="add-line" @click="addDraftLine">+ Add another product</button>
          </fieldset>

          <UiAlert v-if="formError" tone="danger">{{ formError }}</UiAlert>
          <div>
            <UiButton type="submit" variant="primary" :busy="busy" busy-label="Creating..." data-testid="create-schedule">Create schedule</UiButton>
          </div>
        </form>
      </Card>

      <!-- Existing schedules -->
      <section class="stack" aria-labelledby="schedules-title">
        <h2 id="schedules-title" class="section-title">Schedules</h2>
        <UiAlert v-if="actionError" tone="danger">{{ actionError }}</UiAlert>
        <EmptyState v-if="schedules.length === 0" title="No schedules yet" message="Create one above to start a repeat order." />

        <Card v-for="s in schedules" :key="s.id" :title="patientName(s.patientId)" data-testid="schedule">
          <template #actions><StatusChip :status="s.status" /></template>

          <dl class="facts">
            <div><dt>Interval</dt><dd>Every {{ s.intervalDays }} days</dd></div>
            <div><dt>Next run</dt><dd>{{ s.status === 'active' ? shortDate(s.nextRunAt) : '-' }}</dd></div>
            <div><dt>Per cycle (indicative)</dt><dd><Money :cents="s.perCycleSubtotalCents" /></dd></div>
            <div>
              <dt>Authorization</dt>
              <dd>
                <span class="badge" :class="s.authorized ? 'badge-success' : 'badge-warning'">
                  {{ s.authorized ? 'Authorized' : 'Waiting for patient' }}
                </span>
              </dd>
            </div>
          </dl>

          <ul class="items">
            <li v-for="l in s.lines" :key="l.id">
              {{ l.qty }} × {{ l.name }}
              <span class="subtle">- {{ formatMoney(l.unitPriceCents) }} each, incl. your {{ formatMoney(l.unitMarkupCents) }}</span>
            </li>
          </ul>

          <!-- On-hold cycles: what happened and how to fix it -->
          <div v-if="heldCycles(s).length" class="holds">
            <UiAlert
              v-for="c in heldCycles(s)"
              :key="c.orderId"
              tone="warning"
              :title="`Cycle ${c.cycleNumber} is on hold: ${holdLabel(c.holdReason)}`"
              data-testid="hold-alert"
            >
              {{ holdFix(c.holdReason) }}
            </UiAlert>
          </div>

          <div v-if="!s.authorized && s.payUrl" class="auth-link">
            <label :for="`auth-${s.id}`" class="field-label">Patient authorize link</label>
            <div class="auth-row">
              <input :id="`auth-${s.id}`" :value="`${origin}${s.payUrl}`" readonly class="auth-input" @focus="($event.target as HTMLInputElement).select()" />
              <button type="button" class="btn-sm" :data-testid="`copy-auth-${s.id}`" @click="copy(s)">{{ copiedId === s.id ? 'Copied' : 'Copy link' }}</button>
            </div>
            <p class="sr-only" role="status">{{ copiedId === s.id ? 'Link copied.' : '' }}</p>
          </div>

          <div class="actions">
            <UiButton
              v-if="s.status === 'active'"
              variant="primary"
              size="sm"
              :busy="rowBusyId === s.id"
              busy-label="Running..."
              :data-testid="`run-${s.id}`"
              @click="act(s, 'run')"
            >Run cycle now</UiButton>
            <UiButton v-if="s.status === 'active'" size="sm" :disabled="rowBusyId === s.id" :data-testid="`pause-${s.id}`" @click="act(s, 'pause')">Pause</UiButton>
            <UiButton v-if="s.status === 'paused'" size="sm" :disabled="rowBusyId === s.id" :data-testid="`resume-${s.id}`" @click="act(s, 'resume')">Resume</UiButton>
            <UiButton
              v-if="s.status !== 'cancelled'"
              variant="danger-quiet"
              size="sm"
              :disabled="rowBusyId === s.id"
              :data-testid="`cancel-${s.id}`"
              @click="cancelTarget = s"
            >Cancel schedule</UiButton>
          </div>

          <div v-if="s.cycles.length" class="cycles">
            <h3 class="cycles-title">Cycles</h3>
            <div class="table-wrap">
              <table class="table table-stack">
                <thead>
                  <tr>
                    <th scope="col">Cycle</th>
                    <th scope="col">Date</th>
                    <th scope="col">Status</th>
                    <th scope="col">Reason</th>
                    <th scope="col" class="num">Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="c in s.cycles" :key="c.orderId">
                    <td data-label="Cycle"><RouterLink :to="{ name: 'order-audit', params: { id: c.orderId } }">Cycle {{ c.cycleNumber }}</RouterLink></td>
                    <td data-label="Date">{{ shortDate(c.createdAt) }}</td>
                    <td data-label="Status"><StatusChip :status="c.status" /></td>
                    <td data-label="Reason">{{ holdLabel(c.holdReason) }}</td>
                    <td data-label="Subtotal" class="num"><Money :cents="c.subtotalCents" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      </section>
    </div>

    <ConfirmDialog
      :open="cancelTarget !== null"
      title="Cancel this schedule?"
      confirm-label="Cancel schedule"
      cancel-label="Keep schedule"
      tone="danger"
      :busy="rowBusyId !== null"
      @confirm="confirmCancel"
      @cancel="cancelTarget = null"
    >
      <p>
        No more cycles will run for <strong>{{ cancelTarget ? patientName(cancelTarget.patientId) : '' }}</strong>.
        Past cycles stay on record. This cannot be undone.
      </p>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.section-title {
  font-size: var(--text-xl);
  margin: var(--space-2) 0 0;
}
.create {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.interval {
  max-width: 8rem;
}
.lines {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-3) var(--space-4) var(--space-4);
  margin: 0;
  min-width: 0;
}
.lines legend {
  font-weight: 650;
  padding: 0 var(--space-1);
}
.draft-line {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-4);
  align-items: flex-end;
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border);
}
.line-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.line-field.product {
  flex: 1 1 18rem;
}
.field-label {
  font-size: var(--text-sm);
  font-weight: 600;
}
.cogs-note {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  margin: 0;
}
.dollar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.markup-input {
  width: 7rem;
}
.remove {
  min-height: 2.5rem;
}
.lines > .btn-link {
  margin-top: var(--space-3);
}
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-8);
  margin: 0 0 var(--space-3);
}
.facts div {
  display: flex;
  flex-direction: column;
}
.facts dt {
  font-size: var(--text-xs);
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.facts dd {
  margin: 0;
}
.items {
  margin: 0 0 var(--space-3);
  padding-left: var(--space-5);
}
.auth-link {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-3);
}
.auth-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.auth-input {
  flex: 1 1 16rem;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  background: var(--surface-2);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
.cycles {
  margin-top: var(--space-4);
}
.cycles-title {
  font-size: var(--text-md);
  margin: 0 0 var(--space-2);
}
.holds {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
@media (max-width: 640px) {
  .line-field.product {
    flex-basis: 100%;
  }
}
</style>
