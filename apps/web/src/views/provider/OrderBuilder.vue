<script setup lang="ts">
// Provider order builder (FR-1..FR-4). Create a draft for one of the practice's
// patients, add SKUs with a price or margin %, watch the live server quote (price,
// COGS, fee, net margin), then send and surface the copyable patient pay link.
//
// The UI only DISPLAYS money; every figure comes from GET /api/orders/:id/quote
// (AGENTS.md money rule 2). Price vs margin % is just an input mode - the server
// derives and stores the canonical price (ADR-005).
import { onMounted, ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiRequest, ApiError } from '../../api/client'
import { currentUserId } from '../../api/session'
import type {
  ProductView,
  OrderView,
  OrderStatus,
  QuoteResponse,
  SendResponse,
  PatientView
} from '@cerbo/contracts'
import { insufficientStockMessage } from '../../components/order/format'
import AddLineForm from '../../components/order/AddLineForm.vue'
import LineRow from '../../components/order/LineRow.vue'
import QuoteSummary from '../../components/order/QuoteSummary.vue'
import CopyLink from '../../components/order/CopyLink.vue'

const route = useRoute()
const router = useRouter()

const products = ref<ProductView[]>([])
const patients = ref<PatientView[]>([])
const patientsUnavailable = ref(false)
const loadError = ref<string | null>(null)

const selectedPatientId = ref<string>('')
// The active order is tracked by id + current status (sourced from POST /orders on a new
// draft, or GET /orders/:id/quote when resuming an existing draft). We never need the
// full OrderView in the builder, so this works for both entry paths.
const orderId = ref<string | null>(null)
const orderStatus = ref<OrderStatus | null>(null)
const quote = ref<QuoteResponse | null>(null)
// Set when a resume attempt fails (unknown id, not the provider's order, or not a draft);
// the start panel shows it instead of silently opening a blank draft.
const resumeError = ref<string | null>(null)

const busy = ref(false)
const lineBusyId = ref<string | null>(null)
const addError = ref<string | null>(null)
const lineErrors = ref<Record<string, string>>({})
const pageError = ref<string | null>(null)
const sendResult = ref<SendResponse | null>(null)

const hasOrder = computed(() => orderId.value !== null)
const lines = computed(() => quote.value?.lines ?? [])
const isDraft = computed(() => orderStatus.value === 'draft')
const canSend = computed(() => isDraft.value && lines.value.length > 0)
// Quantity already on this draft per SKU, for the Add form's "already on this order: N"
// note. Straight from the quote lines - a display value, never stock arithmetic.
const onOrderBySku = computed<Record<string, number>>(() => {
  const map: Record<string, number> = {}
  for (const l of lines.value) map[l.sku] = l.qty
  return map
})

/** Turn an API error into a provider-facing message (exact copy for known codes). */
function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'INSUFFICIENT_STOCK') {
      // Prefer the server-computed remaining headroom (details.remaining); fall back to
      // raw available if an older server omits it. Never subtract in the browser.
      const details = err.details as { available?: unknown; remaining?: unknown }
      const n = Number(details.remaining ?? details.available ?? 0)
      return insufficientStockMessage(n)
    }
    if (err.code === 'MARGIN_NEGATIVE') {
      return "This line's margin after the platform fee would be negative. Raise the price or margin %."
    }
    return err.message
  }
  return 'Something went wrong. Please try again.'
}

/** Map a MARGIN_NEGATIVE error to the line id at the reported position, if any. */
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
    // GET /api/patients is still a 501 stub (unassigned at scaffold time; now owned by
    // T3). Degrade to a clear state instead of crashing; create-draft resumes once it
    // lands. Any other error is surfaced normally.
    if (err instanceof ApiError && (err.status === 501 || err.code === 'NOT_IMPLEMENTED')) {
      patientsUnavailable.value = true
      patients.value = []
    } else {
      throw err
    }
  }
}

/** Normalise a route query value (string | string[] | undefined) to a single string. */
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
  // Resume an existing draft when arrived at as /orders/new?orderId=<id> (e.g. from the
  // Orders list). Done after the catalog/patients load so the builder is ready to use.
  const resumeId = queryString(route.query.orderId)
  if (resumeId) await resumeOrder(resumeId)
})

async function refreshQuote(): Promise<void> {
  if (!orderId.value) return
  quote.value = await apiRequest<QuoteResponse>(`/orders/${orderId.value}/quote`)
  // Keep the tracked status in sync with the server (e.g. draft -> sent after send).
  orderStatus.value = quote.value.status
}

async function startOrder(): Promise<void> {
  if (!selectedPatientId.value) return
  pageError.value = null
  resumeError.value = null
  busy.value = true
  try {
    const created = await apiRequest<OrderView>('/orders', {
      method: 'POST',
      body: { patientId: selectedPatientId.value }
    })
    orderId.value = created.id
    orderStatus.value = created.status
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
 * Resume an existing draft by id, hydrating the builder from GET /orders/:id/quote (no
 * new endpoint needed - the quote carries id, status, totals and lines). Degrades
 * cleanly: a 404 is the ownership check (AGENTS section 7 returns 404, not 403, so
 * existence is not leaked) and a non-draft order is read-only, both surfaced as a
 * message rather than a crash or a silent blank draft.
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

async function addLine(payload: { sku: string; qty: number; unitPriceCents?: number; marginBps?: number }): Promise<void> {
  if (!orderId.value) return
  addError.value = null
  busy.value = true
  try {
    await apiRequest<OrderView>(`/orders/${orderId.value}/lines`, { method: 'POST', body: payload })
    await refreshQuote()
  } catch (err) {
    addError.value = messageFor(err)
  } finally {
    busy.value = false
  }
}

async function commitLine(lineId: string, payload: { qty: number; unitPriceCents?: number; marginBps?: number }): Promise<void> {
  if (!orderId.value) return
  const next = { ...lineErrors.value }
  delete next[lineId]
  lineErrors.value = next
  lineBusyId.value = lineId
  try {
    await apiRequest<OrderView>(`/orders/${orderId.value}/lines/${lineId}`, { method: 'PATCH', body: payload })
    await refreshQuote()
  } catch (err) {
    const targetId = lineIdAtErrorPosition(err) ?? lineId
    lineErrors.value = { ...lineErrors.value, [targetId]: messageFor(err) }
  } finally {
    lineBusyId.value = null
  }
}

async function removeLine(lineId: string): Promise<void> {
  if (!orderId.value) return
  lineBusyId.value = lineId
  try {
    await apiRequest<OrderView>(`/orders/${orderId.value}/lines/${lineId}`, { method: 'DELETE' })
    const next = { ...lineErrors.value }
    delete next[lineId]
    lineErrors.value = next
    await refreshQuote()
  } catch (err) {
    lineErrors.value = { ...lineErrors.value, [lineId]: messageFor(err) }
  } finally {
    lineBusyId.value = null
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
  }
}

function newOrder(): void {
  orderId.value = null
  orderStatus.value = null
  quote.value = null
  sendResult.value = null
  lineErrors.value = {}
  addError.value = null
  pageError.value = null
  resumeError.value = null
  selectedPatientId.value = ''
  // Drop a lingering ?orderId= so a refresh does not re-resume the finished order.
  if (route.query.orderId) void router.replace({ name: 'order-new' })
}
</script>

<template>
  <section class="order-builder">
    <h2>New Order</h2>

    <p v-if="loadError" class="page-error" role="alert">{{ loadError }}</p>

    <!-- Patient selection + draft creation (FR-1 AC1) -->
    <section v-if="!hasOrder" class="start">
      <p v-if="resumeError" class="page-error" role="alert" data-test="resume-error">{{ resumeError }}</p>
      <h3>Patient</h3>
      <p v-if="patientsUnavailable" class="notice" role="status">
        The patient list is not yet available (the patients endpoint is still being
        implemented). You can create an order here once it is live.
      </p>
      <template v-else>
        <label class="field">
          Choose a patient
          <select v-model="selectedPatientId" :disabled="busy || patients.length === 0">
            <option value="" disabled>Select a patient</option>
            <option v-for="p in patients" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
        <p v-if="patients.length === 0" class="notice">No patients found for your practice.</p>
        <button type="button" class="btn-primary" :disabled="busy || !selectedPatientId" @click="startOrder">Start draft order</button>
      </template>
      <p v-if="pageError" class="page-error" role="alert">{{ pageError }}</p>
    </section>

    <!-- Draft builder -->
    <section v-else class="builder">
      <div class="order-meta">
        <span>Order <code>{{ orderId }}</code></span>
        <span class="status">status: {{ orderStatus }}</span>
        <button type="button" class="btn-link" :disabled="busy" @click="newOrder">Start another order</button>
      </div>

      <p v-if="pageError" class="page-error" role="alert">{{ pageError }}</p>

      <AddLineForm
        v-if="isDraft"
        :products="products"
        :busy="busy"
        :error="addError"
        :on-order="onOrderBySku"
        @add="addLine"
      />

      <div class="lines">
        <h3>Items</h3>
        <p v-if="lines.length === 0" class="notice">No items yet. Add one above.</p>
        <table v-else class="items-table">
          <thead>
            <tr>
              <th>Item</th>
              <th class="num">Qty</th>
              <th class="num">Unit price</th>
              <th class="num">Line total</th>
              <th class="num">COGS</th>
              <th class="num">Fee</th>
              <th class="num">Net margin</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <LineRow
              v-for="line in lines"
              :key="line.id"
              :line="line"
              :busy="busy || lineBusyId === line.id"
              :error="lineErrors[line.id] ?? null"
              @commit="(payload) => commitLine(line.id, payload)"
              @remove="() => removeLine(line.id)"
            />
          </tbody>
        </table>
      </div>

      <QuoteSummary :totals="quote?.totals ?? null" />

      <div class="actions" v-if="isDraft">
        <button type="button" class="btn-primary" :disabled="!canSend || busy" @click="send">Send to patient</button>
      </div>

      <CopyLink v-if="sendResult" :payUrl="sendResult.payUrl" />
    </section>

    <p class="actor-note">Acting as <code>{{ currentUserId }}</code>.</p>
  </section>
</template>

<style scoped>
.order-builder {
  max-width: 920px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.9em;
  max-width: 20rem;
  margin-bottom: 0.6rem;
}
.order-meta {
  display: flex;
  gap: 1rem;
  align-items: center;
  margin-bottom: 1rem;
  flex-wrap: wrap;
  padding: 0.6rem 0.85rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.status {
  color: var(--muted);
}
.notice {
  color: var(--muted);
}
/* Mirrors the Orders list table so the two screens read as one product. */
.items-table {
  border-collapse: collapse;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  margin-bottom: 1rem;
}
.items-table th,
.items-table :deep(td) {
  border-bottom: 1px solid var(--border);
  padding: 0.5rem 0.7rem;
  text-align: left;
}
.items-table th.num,
.items-table :deep(td.num) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.actions {
  margin-top: 1rem;
}
.actor-note {
  margin-top: 1.5rem;
  color: var(--subtle);
  font-size: 0.85em;
}
</style>
