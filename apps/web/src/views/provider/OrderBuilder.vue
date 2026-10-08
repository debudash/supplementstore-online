<script setup lang="ts">
// Provider order builder (FR-1..FR-4): pick a patient, add products with a per-unit
// dollar markup, watch the live server quote, review and send, then share the patient
// pay link.
//
// The UI only DISPLAYS money; every figure comes from GET /api/orders/:id/quote
// (AGENTS.md money rule 2). The server derives the price from COGS + markup (ADR-028).
//
// Uses only useRoute().query and useRouter().replace from vue-router (its tests mock
// exactly those), so links out of this view are plain anchors.
import { onMounted, ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiRequest, ApiError } from '../../api/client'
import type { ProductView, OrderView, OrderStatus, QuoteResponse, SendResponse, PatientView, PricePreview } from '@cerbo/contracts'
import { insufficientStockMessage, formatCents } from '../../components/order/format'
import AddLineForm from '../../components/order/AddLineForm.vue'
import LineRow from '../../components/order/LineRow.vue'
import QuoteSummary from '../../components/order/QuoteSummary.vue'
import CopyLink from '../../components/order/CopyLink.vue'
import PageHeader from '../../components/ui/PageHeader.vue'
import Card from '../../components/ui/Card.vue'
import UiAlert from '../../components/ui/UiAlert.vue'
import ConfirmDialog from '../../components/ui/ConfirmDialog.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import UiButton from '../../components/ui/UiButton.vue'
import { toast } from '../../components/ui/toast'
import { formatMoney } from '../../utils/money'

const route = useRoute()
const router = useRouter()

const products = ref<ProductView[]>([])
const patients = ref<PatientView[]>([])
const patientsUnavailable = ref(false)
const loading = ref(true)
const loadError = ref<string | null>(null)

const selectedPatientId = ref<string>('')
const orderPatientId = ref<string | null>(null)
const orderId = ref<string | null>(null)
const orderStatus = ref<OrderStatus | null>(null)
const quote = ref<QuoteResponse | null>(null)
const resumeError = ref<string | null>(null)

const busy = ref(false)
const lineBusyId = ref<string | null>(null)
const addError = ref<string | null>(null)
const lineErrors = ref<Record<string, string>>({})
const pageError = ref<string | null>(null)
const sendResult = ref<SendResponse | null>(null)

const confirmSendOpen = ref(false)
const removeTarget = ref<{ id: string; name: string } | null>(null)

const hasOrder = computed(() => orderId.value !== null)
const lines = computed(() => quote.value?.lines ?? [])
const isDraft = computed(() => orderStatus.value === 'draft')
const canSend = computed(() => isDraft.value && lines.value.length > 0)
const onOrderBySku = computed<Record<string, number>>(() => {
  const map: Record<string, number> = {}
  for (const l of lines.value) map[l.sku] = l.qty
  return map
})
const patientName = computed(() => {
  const id = orderPatientId.value ?? selectedPatientId.value
  return patients.value.find((p) => p.id === id)?.name ?? null
})

const step = computed(() => (!hasOrder.value ? 1 : sendResult.value || !isDraft.value ? 3 : 2))
const STEPS = ['Patient', 'Items', 'Review & send']

const title = computed(() => {
  if (!hasOrder.value) return 'New order'
  if (sendResult.value || orderStatus.value === 'sent') return patientName.value ? `Sent to ${patientName.value}` : 'Order sent'
  return patientName.value ? `Draft order for ${patientName.value}` : 'Draft order'
})

/** Turn an API error into a provider-facing message (exact copy for known codes). */
function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'INSUFFICIENT_STOCK') {
      // Prefer the server-computed remaining headroom; never subtract in the browser.
      const details = err.details as { available?: unknown; remaining?: unknown }
      const n = Number(details.remaining ?? details.available ?? 0)
      return insufficientStockMessage(n)
    }
    return err.message
  }
  return 'Something went wrong. Please try again.'
}

function lineIdAtErrorPosition(err: unknown): string | null {
  if (err instanceof ApiError && typeof (err.details as { position?: unknown }).position === 'number') {
    const position = (err.details as { position: number }).position
    return lines.value.find((l) => l.position === position)?.id ?? null
  }
  return null
}

async function loadCatalog(): Promise<void> {
  const res = await apiRequest<{ products: ProductView[] }>('/products')
  products.value = res.products
}

async function loadPatients(): Promise<void> {
  try {
    const res = await apiRequest<{ patients: PatientView[] }>('/patients')
    patients.value = res.patients
    patientsUnavailable.value = false
  } catch (err) {
    if (err instanceof ApiError && (err.status === 501 || err.code === 'NOT_IMPLEMENTED')) {
      patientsUnavailable.value = true
      patients.value = []
    } else {
      throw err
    }
  }
}

/** Best-effort lookup of a resumed draft's patient (for the title). Never fatal. */
async function loadOrderPatient(id: string): Promise<void> {
  try {
    const res = await apiRequest<{ orders?: Array<{ id: string; patientId: string }> }>('/orders?status=draft')
    orderPatientId.value = res?.orders?.find((o) => o.id === id)?.patientId ?? null
  } catch {
    orderPatientId.value = null
  }
}

function queryString(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0] !== '') return value[0]
  return null
}

onMounted(async () => {
  try {
    await Promise.all([loadCatalog(), loadPatients()])
  } catch (err) {
    loadError.value = messageFor(err)
  }
  const resumeId = queryString(route.query.orderId)
  if (resumeId) await resumeOrder(resumeId)
  loading.value = false
})

async function refreshQuote(): Promise<void> {
  if (!orderId.value) return
  quote.value = await apiRequest<QuoteResponse>(`/orders/${orderId.value}/quote`)
  orderStatus.value = quote.value.status
}

async function startOrder(): Promise<void> {
  if (!selectedPatientId.value) return
  pageError.value = null
  resumeError.value = null
  busy.value = true
  try {
    const created = await apiRequest<OrderView>('/orders', { method: 'POST', body: { patientId: selectedPatientId.value } })
    orderId.value = created.id
    orderStatus.value = created.status
    orderPatientId.value = selectedPatientId.value
    sendResult.value = null
    lineErrors.value = {}
    await refreshQuote()
  } catch (err) {
    pageError.value = messageFor(err)
  } finally {
    busy.value = false
  }
}

/**
 * Resume an existing draft by id from GET /orders/:id/quote. A 404 is the ownership
 * check (existence is not leaked) and a non-draft order is read-only; both are shown
 * as a message rather than a crash or a silent blank draft.
 */
async function resumeOrder(id: string): Promise<void> {
  pageError.value = null
  resumeError.value = null
  busy.value = true
  try {
    const q = await apiRequest<QuoteResponse>(`/orders/${id}/quote`)
    if (q.status !== 'draft') {
      resumeError.value = `That order is ${q.status} and can no longer be edited. Start a new order instead.`
      return
    }
    orderId.value = q.orderId
    orderStatus.value = q.status
    quote.value = q
    sendResult.value = null
    lineErrors.value = {}
    void loadOrderPatient(q.orderId)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      resumeError.value = 'That order was not found. It may not be one of your orders, or it no longer exists.'
    } else {
      resumeError.value = messageFor(err)
    }
  } finally {
    busy.value = false
  }
}

async function addLine(payload: { sku: string; qty: number; markupCents: number }): Promise<void> {
  if (!orderId.value) return
  addError.value = null
  busy.value = true
  try {
    await apiRequest<OrderView>(`/orders/${orderId.value}/lines`, { method: 'POST', body: payload })
    await refreshQuote()
    const name = products.value.find((p) => p.sku === payload.sku)?.name ?? payload.sku
    toast(`Added ${name}.`)
  } catch (err) {
    addError.value = messageFor(err)
  } finally {
    busy.value = false
  }
}

async function patchLine(lineId: string, body: { qty?: number; markupCents?: number }): Promise<void> {
  if (!orderId.value) return
  const next = { ...lineErrors.value }
  delete next[lineId]
  lineErrors.value = next
  lineBusyId.value = lineId
  try {
    await apiRequest<OrderView>(`/orders/${orderId.value}/lines/${lineId}`, { method: 'PATCH', body })
    await refreshQuote()
    toast(body.markupCents !== undefined ? 'Markup applied - price updated.' : 'Quantity updated.')
  } catch (err) {
    const targetId = lineIdAtErrorPosition(err) ?? lineId
    lineErrors.value = { ...lineErrors.value, [targetId]: messageFor(err) }
  } finally {
    lineBusyId.value = null
  }
}

async function confirmRemove(): Promise<void> {
  const target = removeTarget.value
  if (!orderId.value || !target) return
  lineBusyId.value = target.id
  try {
    await apiRequest<OrderView>(`/orders/${orderId.value}/lines/${target.id}`, { method: 'DELETE' })
    const next = { ...lineErrors.value }
    delete next[target.id]
    lineErrors.value = next
    await refreshQuote()
    toast(`Removed ${target.name}.`)
  } catch (err) {
    lineErrors.value = { ...lineErrors.value, [target.id]: messageFor(err) }
  } finally {
    lineBusyId.value = null
    removeTarget.value = null
  }
}

async function send(): Promise<void> {
  if (!orderId.value) return
  pageError.value = null
  busy.value = true
  try {
    const result = await apiRequest<SendResponse>(`/orders/${orderId.value}/send`, { method: 'POST' })
    sendResult.value = result
    orderStatus.value = result.order.status
    await refreshQuote()
  } catch (err) {
    const targetId = lineIdAtErrorPosition(err)
    if (targetId) lineErrors.value = { ...lineErrors.value, [targetId]: messageFor(err) }
    else pageError.value = messageFor(err)
  } finally {
    busy.value = false
    confirmSendOpen.value = false
  }
}

function newOrder(): void {
  orderId.value = null
  orderStatus.value = null
  orderPatientId.value = null
  quote.value = null
  sendResult.value = null
  lineErrors.value = {}
  addError.value = null
  pageError.value = null
  resumeError.value = null
  selectedPatientId.value = ''
  if (route.query.orderId) void router.replace({ name: 'order-new' })
}

/** Server-side price preview for a markup (ADR-028); the UI never computes a price. */
function previewPrice(sku: string, markupCents: number): Promise<PricePreview> {
  return apiRequest<PricePreview>(`/products/${encodeURIComponent(sku)}/price-preview?markupCents=${markupCents}`)
}

function goOrders(e: Event): void {
  const r = router as unknown as { push?: (to: string) => unknown }
  if (r.push) {
    e.preventDefault()
    void r.push('/orders')
  }
}
</script>

<template>
  <section class="order-builder">
    <PageHeader :title="title">
      <template #back><a href="/orders" @click="goOrders">← All orders</a></template>
      <template v-if="hasOrder" #actions>
        <UiButton variant="secondary" size="sm" :disabled="busy" data-testid="new-order" @click="newOrder">Start another order</UiButton>
      </template>
    </PageHeader>

    <ol class="steps" aria-label="Progress">
      <li v-for="(s, i) in STEPS" :key="s" :class="{ done: step > i + 1, current: step === i + 1 }" :aria-current="step === i + 1 ? 'step' : undefined">
        <span class="step-num" aria-hidden="true">{{ step > i + 1 ? '✓' : i + 1 }}</span>
        <span class="step-label">{{ s }}</span>
      </li>
    </ol>

    <UiAlert v-if="loadError" tone="danger" title="Could not load the catalog">{{ loadError }}</UiAlert>

    <Skeleton v-if="loading" :lines="4" height="2.5rem" label="Loading order builder" />

    <!-- Step 1: patient -->
    <div v-else-if="!hasOrder" class="step-one">
      <Card title="Patient" subtitle="Who is this order for?" class="start">
        <p v-if="resumeError" class="page-error" role="alert" data-test="resume-error">{{ resumeError }}</p>
        <UiAlert v-if="patientsUnavailable" tone="info">
          The patient list is not available yet. You can create an order here once it is live.
        </UiAlert>
        <template v-else>
          <EmptyState v-if="patients.length === 0" title="No patients found" message="Your practice has no patients yet." />
          <form v-else class="start-form" @submit.prevent="startOrder">
            <div class="field">
              <label for="patient-select">Choose a patient</label>
              <select id="patient-select" v-model="selectedPatientId" :disabled="busy" data-testid="patient-select">
                <option value="" disabled>Select a patient</option>
                <option v-for="p in patients" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </div>
            <UiButton type="submit" variant="primary" :busy="busy" busy-label="Starting..." :disabled="!selectedPatientId" data-testid="start-order">
              Start order
            </UiButton>
          </form>
        </template>
        <p v-if="pageError" class="page-error" role="alert">{{ pageError }}</p>
      </Card>
    </div>

    <!-- Steps 2-3: builder -->
    <div v-else class="layout">
      <div class="main-col">
        <details class="order-details">
          <summary>Order details</summary>
          <p>Order ID <code>{{ orderId }}</code> - status: {{ orderStatus }}</p>
        </details>

        <UiAlert v-if="pageError" tone="danger">{{ pageError }}</UiAlert>

        <!-- Sent: success state -->
        <Card v-if="sendResult" tone="success" class="sent">
          <template #header>
            <h2 class="sent-title">✓ Sent to {{ patientName ?? 'the patient' }}</h2>
          </template>
          <p>
            Stock is reserved for 7 days. The patient pays from the link below; you will see the
            order move to <strong>Paid</strong> in Orders.
          </p>
          <CopyLink :payUrl="sendResult.payUrl" />
          <div class="sent-actions">
            <UiButton variant="primary" data-testid="sent-new-order" @click="newOrder">Start another order</UiButton>
            <a href="/orders" class="btn" @click="goOrders">View all orders</a>
          </div>
        </Card>

        <AddLineForm v-if="isDraft" :products="products" :busy="busy" :error="addError" :on-order="onOrderBySku" :preview-price="previewPrice" @add="addLine" />

        <section class="items" aria-labelledby="items-title">
          <h2 id="items-title" class="section-title">Items <span v-if="lines.length" class="count">({{ lines.length }})</span></h2>
          <EmptyState v-if="lines.length === 0" title="No items yet" message="Add a product above to start the order." />
          <div v-else class="table-wrap">
            <table class="table table-stack items-table">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Qty</th>
                  <th scope="col" class="num">Unit price</th>
                  <th scope="col" class="num">Line total</th>
                  <th scope="col" class="num">COGS</th>
                  <th scope="col" class="num">Net margin</th>
                </tr>
              </thead>
              <tbody>
                <LineRow
                  v-for="line in lines"
                  :key="line.id"
                  :line="line"
                  :busy="busy || lineBusyId === line.id || !isDraft"
                  :error="lineErrors[line.id] ?? null"
                  :preview-price="previewPrice"
                  @commit="(payload) => patchLine(line.id, payload)"
                  @markup="(payload) => patchLine(line.id, payload)"
                  @remove="() => (removeTarget = { id: line.id, name: line.name })"
                />
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <aside class="side-col">
        <div class="sticky">
          <QuoteSummary :totals="quote?.totals ?? null" :item-count="lines.length">
            <div v-if="isDraft" class="send">
              <UiButton variant="primary" block :disabled="!canSend || busy" data-testid="review-send" @click="confirmSendOpen = true">
                Review & send
              </UiButton>
              <p v-if="!canSend" class="subtle">Add at least one item to send.</p>
            </div>
          </QuoteSummary>
        </div>
      </aside>
    </div>

    <!-- Mobile: total + send stays in reach -->
    <div v-if="hasOrder && isDraft && lines.length" class="mobile-bar">
      <span class="mobile-total">
        <span class="subtle">Patient pays</span>
        <strong class="money">{{ formatMoney(quote?.totals?.subtotalCents) }}</strong>
      </span>
      <UiButton variant="primary" :disabled="!canSend || busy" @click="confirmSendOpen = true">Review & send</UiButton>
    </div>

    <ConfirmDialog
      :open="confirmSendOpen"
      title="Send this order?"
      confirm-label="Send to patient"
      :busy="busy"
      @confirm="send"
      @cancel="confirmSendOpen = false"
    >
      <p>
        <strong>{{ patientName ?? 'The patient' }}</strong> will get a pay link. Stock is reserved
        for 7 days, and the order can no longer be edited.
      </p>
      <ul class="review-list">
        <li v-for="l in lines" :key="l.id">
          <span>{{ l.qty }} × {{ l.name }}</span>
          <span class="money">{{ formatCents(l.lineTotalCents) }}</span>
        </li>
      </ul>
      <p class="review-total">
        <span>Patient pays</span>
        <strong class="money">{{ quote?.totals ? formatCents(quote.totals.subtotalCents) : '-' }}</strong>
      </p>
    </ConfirmDialog>

    <ConfirmDialog
      :open="removeTarget !== null"
      title="Remove this item?"
      confirm-label="Remove item"
      tone="danger"
      :busy="lineBusyId !== null"
      @confirm="confirmRemove"
      @cancel="removeTarget = null"
    >
      <p>{{ removeTarget?.name }} will be taken off this draft. You can add it again later.</p>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.steps {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-6);
  list-style: none;
  padding: 0;
  margin: 0 0 var(--space-6);
}
.steps li {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--muted);
  font-size: var(--text-sm);
  font-weight: 550;
}
.step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 50%;
  border: 2px solid var(--border-strong);
  background: var(--surface);
  font-size: var(--text-xs);
  font-weight: 700;
}
.steps li.current {
  color: var(--brand-strong);
}
.steps li.current .step-num {
  border-color: var(--brand);
  background: var(--brand);
  color: #fff;
}
.steps li.done .step-num {
  border-color: var(--success);
  background: var(--success-tint);
  color: var(--success);
}
.step-one {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.start {
  max-width: 34rem;
}
.start-form {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: flex-end;
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1 1 16rem;
}
.field label {
  font-size: var(--text-sm);
  font-weight: 600;
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 17.5rem;
  gap: var(--space-6);
  align-items: start;
}
.main-col {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  min-width: 0;
}
.sticky {
  position: sticky;
  top: calc(var(--topbar-h) + var(--space-4));
}
.order-details {
  font-size: var(--text-sm);
  color: var(--muted);
}
.order-details summary {
  cursor: pointer;
  width: fit-content;
}
.order-details p {
  margin: var(--space-2) 0 0;
}
.section-title {
  font-size: var(--text-lg);
  margin: 0 0 var(--space-3);
}
.count {
  color: var(--muted);
  font-weight: 500;
}
.items-table :deep(td),
.items-table th {
  vertical-align: middle;
  padding-left: 0.5rem;
  padding-right: 0.5rem;
}
.send {
  margin-top: var(--space-4);
}
.send .subtle {
  margin: var(--space-2) 0 0;
  text-align: center;
}
.sent-title {
  font-size: var(--text-xl);
  color: var(--success);
  margin: 0;
}
.sent-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
.review-list {
  list-style: none;
  padding: 0;
  margin: var(--space-3) 0;
  border-top: 1px solid var(--border);
}
.review-list li,
.review-total {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border);
  font-size: var(--text-sm);
}
.review-total {
  border-bottom: none;
  font-size: var(--text-lg);
}
.mobile-bar {
  display: none;
}
@media (max-width: 980px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .sticky {
    position: static;
  }
}
@media (max-width: 640px) {
  .mobile-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border-top: 1px solid var(--border-strong);
    box-shadow: 0 -4px 16px rgba(16, 24, 40, 0.08);
  }
  .mobile-total {
    display: flex;
    flex-direction: column;
    line-height: 1.2;
  }
  .mobile-total strong {
    font-size: var(--text-lg);
  }
  .order-builder {
    padding-bottom: var(--space-16);
  }
}
</style>
