<script setup lang="ts">
// Provider order builder (FR-1..FR-4). Create a draft for one of the practice's
// patients, add SKUs with a price or margin %, watch the live server quote (price,
// COGS, fee, net margin), then send and surface the copyable patient pay link.
//
// The UI only DISPLAYS money; every figure comes from GET /api/orders/:id/quote
// (AGENTS.md money rule 2). Price vs margin % is just an input mode - the server
// derives and stores the canonical price (ADR-005).
import { onMounted, ref, computed } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import { currentUserId } from '../../api/session'
import type {
  ProductView,
  OrderView,
  QuoteResponse,
  SendResponse,
  PatientView
} from '@cerbo/contracts'
import { insufficientStockMessage } from '../../components/order/format'
import AddLineForm from '../../components/order/AddLineForm.vue'
import LineRow from '../../components/order/LineRow.vue'
import QuoteSummary from '../../components/order/QuoteSummary.vue'
import CopyLink from '../../components/order/CopyLink.vue'

const products = ref<ProductView[]>([])
const patients = ref<PatientView[]>([])
const patientsUnavailable = ref(false)
const loadError = ref<string | null>(null)

const selectedPatientId = ref<string>('')
const order = ref<OrderView | null>(null)
const quote = ref<QuoteResponse | null>(null)

const busy = ref(false)
const lineBusyId = ref<string | null>(null)
const addError = ref<string | null>(null)
const lineErrors = ref<Record<string, string>>({})
const pageError = ref<string | null>(null)
const sendResult = ref<SendResponse | null>(null)

const lines = computed(() => quote.value?.lines ?? [])
const canSend = computed(() => !!order.value && order.value.status === 'draft' && lines.value.length > 0)
const isDraft = computed(() => order.value?.status === 'draft')

/** Turn an API error into a provider-facing message (exact copy for known codes). */
function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'INSUFFICIENT_STOCK') {
      const available = Number((err.details as { available?: unknown }).available ?? 0)
      return insufficientStockMessage(available)
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

onMounted(async () => {
  try {
    await Promise.all([loadCatalog(), loadPatients()])
  } catch (err) {
    loadError.value = messageFor(err)
  }
})

async function refreshQuote(): Promise<void> {
  if (!order.value) return
  quote.value = await apiRequest<QuoteResponse>(`/orders/${order.value.id}/quote`)
}

async function startOrder(): Promise<void> {
  if (!selectedPatientId.value) return
  pageError.value = null
  busy.value = true
  try {
    order.value = await apiRequest<OrderView>('/orders', {
      method: 'POST',
      body: { patientId: selectedPatientId.value }
    })
    sendResult.value = null
    lineErrors.value = {}
    await refreshQuote()
  } catch (err) {
    pageError.value = messageFor(err)
  } finally {
    busy.value = false
  }
}

async function addLine(payload: { sku: string; qty: number; unitPriceCents?: number; marginBps?: number }): Promise<void> {
  if (!order.value) return
  addError.value = null
  busy.value = true
  try {
    await apiRequest<OrderView>(`/orders/${order.value.id}/lines`, { method: 'POST', body: payload })
    await refreshQuote()
  } catch (err) {
    addError.value = messageFor(err)
  } finally {
    busy.value = false
  }
}

async function commitLine(lineId: string, payload: { qty: number; unitPriceCents?: number; marginBps?: number }): Promise<void> {
  if (!order.value) return
  const next = { ...lineErrors.value }
  delete next[lineId]
  lineErrors.value = next
  lineBusyId.value = lineId
  try {
    await apiRequest<OrderView>(`/orders/${order.value.id}/lines/${lineId}`, { method: 'PATCH', body: payload })
    await refreshQuote()
  } catch (err) {
    const targetId = lineIdAtErrorPosition(err) ?? lineId
    lineErrors.value = { ...lineErrors.value, [targetId]: messageFor(err) }
  } finally {
    lineBusyId.value = null
  }
}

async function removeLine(lineId: string): Promise<void> {
  if (!order.value) return
  lineBusyId.value = lineId
  try {
    await apiRequest<OrderView>(`/orders/${order.value.id}/lines/${lineId}`, { method: 'DELETE' })
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
  if (!order.value) return
  pageError.value = null
  busy.value = true
  try {
    const result = await apiRequest<SendResponse>(`/orders/${order.value.id}/send`, { method: 'POST' })
    sendResult.value = result
    order.value = result.order
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
  order.value = null
  quote.value = null
  sendResult.value = null
  lineErrors.value = {}
  addError.value = null
  pageError.value = null
  selectedPatientId.value = ''
}
</script>

<template>
  <section class="order-builder">
    <h2>New Order</h2>

    <p v-if="loadError" class="page-error" role="alert">{{ loadError }}</p>

    <!-- Patient selection + draft creation (FR-1 AC1) -->
    <section v-if="!order" class="start">
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
        <button type="button" :disabled="busy || !selectedPatientId" @click="startOrder">Start draft order</button>
      </template>
      <p v-if="pageError" class="page-error" role="alert">{{ pageError }}</p>
    </section>

    <!-- Draft builder -->
    <section v-else class="builder">
      <div class="order-meta">
        <span>Order <code>{{ order.id }}</code></span>
        <span class="status">status: {{ order.status }}</span>
        <button type="button" class="link" :disabled="busy" @click="newOrder">Start another order</button>
      </div>

      <p v-if="pageError" class="page-error" role="alert">{{ pageError }}</p>

      <AddLineForm
        v-if="isDraft"
        :products="products"
        :busy="busy"
        :error="addError"
        @add="addLine"
      />

      <div class="lines">
        <h3>Items</h3>
        <p v-if="lines.length === 0" class="notice">No items yet. Add one above.</p>
        <LineRow
          v-for="line in lines"
          :key="line.id"
          :line="line"
          :busy="busy || lineBusyId === line.id"
          :error="lineErrors[line.id] ?? null"
          @commit="(payload) => commitLine(line.id, payload)"
          @remove="() => removeLine(line.id)"
        />
      </div>

      <QuoteSummary :totals="quote?.totals ?? null" />

      <div class="actions" v-if="isDraft">
        <button type="button" :disabled="!canSend || busy" @click="send">Send to patient</button>
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
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}
.status {
  color: #555;
}
.link {
  background: none;
  border: none;
  color: #2a5db0;
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
}
.notice {
  color: #555;
}
.page-error {
  color: #c0392b;
  border: 1px solid #c0392b;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}
.actions {
  margin-top: 1rem;
}
.actor-note {
  margin-top: 1.5rem;
  color: #888;
  font-size: 0.85em;
}
</style>
