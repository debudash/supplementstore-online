<script setup lang="ts">
// Cerbo Admin inventory console (FR-15, ADR-009) - T11.
//
// Cerbo owns ONE shared inventory pool (ADR-009). This view lists the pool and lets a
// Cerbo Admin restock a SKU. Restock is DEMO ONLY: it exists so a demo can refill stock
// between scenarios; in production stock arrives through real receiving and a provider
// never restocks. The banner and per-action copy say so. Money (unit COGS) is
// DISPLAY-only here (AGENTS.md money rule 2) - formatted, never computed with.
//
// Catalog pricing (ADR-025) is a REAL admin capability, kept in its own section: edit a
// product's list price through PriceEditDialog (edit -> server review -> save) and see
// its append-only price history. Restock stays separate and labelled Demo only.
import { onMounted, ref } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import type { AdminInventoryItem, AdminInventoryResponse, RestockResult, PriceHistoryResponse, PriceChange, UpdateListPriceResult } from '@cerbo/contracts'
import DemoBadge from '../../components/DemoBadge.vue'
import PageHeader from '../../components/ui/PageHeader.vue'
import Money from '../../components/ui/Money.vue'
import UiButton from '../../components/ui/UiButton.vue'
import ConfirmDialog from '../../components/ui/ConfirmDialog.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import PriceEditDialog from '../../components/admin/PriceEditDialog.vue'
import { toast } from '../../components/ui/toast'
import { formatMoney, formatBps } from '../../utils/money'

const LOW_STOCK = 5
const RESTOCK_REASON = 'Demo affordance - refills the shared pool between demo scenarios. In production stock arrives through real receiving; a provider never restocks.'

const items = ref<AdminInventoryItem[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

// Per-SKU restock quantity, inline status and inline error, keyed by sku.
const qty = ref<Record<string, string>>({})
const rowStatus = ref<Record<string, string>>({})
const rowError = ref<Record<string, string>>({})
const restockingSku = ref<string | null>(null)
const pending = ref<{ sku: string; name: string; qty: number } | null>(null)

function availability(available: number): { label: string; tone: string } {
  if (available <= 0) return { label: 'Out of stock', tone: 'danger' }
  if (available <= LOW_STOCK) return { label: 'Low', tone: 'warning' }
  return { label: 'In stock', tone: 'success' }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const res = await apiRequest<AdminInventoryResponse>('/admin/inventory')
    items.value = res.items
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Failed to load inventory.'
    items.value = []
  } finally {
    loading.value = false
  }
}

/** Validate the typed quantity, then ask for confirmation before calling the API. */
function requestRestock(item: AdminInventoryItem): void {
  rowStatus.value = { ...rowStatus.value, [item.sku]: '' }
  const raw = String(qty.value[item.sku] ?? '').trim()
  const n = Number(raw)
  if (!/^\d+$/.test(raw) || n < 1 || n > 10000) {
    rowError.value = { ...rowError.value, [item.sku]: 'Enter a whole number from 1 to 10000.' }
    return
  }
  rowError.value = { ...rowError.value, [item.sku]: '' }
  pending.value = { sku: item.sku, name: item.name, qty: n }
}

async function confirmRestock(): Promise<void> {
  const p = pending.value
  if (!p) return
  restockingSku.value = p.sku
  try {
    const result = await apiRequest<RestockResult>(`/admin/inventory/${encodeURIComponent(p.sku)}/restock`, {
      method: 'POST',
      body: { qty: p.qty }
    })
    const msg = `Added ${result.qtyAdded} units of ${p.name}. On hand ${result.onHandQty}, available ${result.available}.`
    rowStatus.value = { ...rowStatus.value, [p.sku]: msg }
    qty.value = { ...qty.value, [p.sku]: '' }
    toast(msg, 'success')
    pending.value = null
    await load()
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : `Failed to restock ${p.name}.`
    rowError.value = { ...rowError.value, [p.sku]: msg }
    toast(msg, 'danger')
    pending.value = null
  } finally {
    restockingSku.value = null
  }
}

// ---- Catalog pricing ----
const editing = ref<AdminInventoryItem | null>(null)
const historyOpen = ref<string | null>(null)
const history = ref<Record<string, PriceChange[]>>({})
const historyLoading = ref<string | null>(null)
const historyError = ref<string | null>(null)

function shortDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

async function loadHistory(sku: string): Promise<void> {
  historyLoading.value = sku
  historyError.value = null
  try {
    const res = await apiRequest<PriceHistoryResponse>(`/admin/products/${encodeURIComponent(sku)}/price-history`)
    history.value = { ...history.value, [sku]: res.changes }
  } catch (err) {
    historyError.value = err instanceof ApiError ? err.message : 'Could not load the price history.'
  } finally {
    historyLoading.value = null
  }
}

async function toggleHistory(sku: string): Promise<void> {
  if (historyOpen.value === sku) {
    historyOpen.value = null
    return
  }
  historyOpen.value = sku
  await loadHistory(sku)
}

async function onPriceSaved(result: UpdateListPriceResult): Promise<void> {
  editing.value = null
  toast(`${result.name}: list price ${formatMoney(result.previousPriceCents)} to ${formatMoney(result.listPriceCents)}.`, 'success')
  await load()
  if (historyOpen.value === result.sku) await loadHistory(result.sku)
}

onMounted(load)
</script>

<template>
  <section class="admin-inventory">
    <PageHeader title="Inventory and pricing" subtitle="Cerbo's catalog prices and the shared stock pool used by every practice." />

    <p v-if="error" class="page-error" role="alert">{{ error }}</p>

    <section class="section" aria-labelledby="pricing-title">
      <div class="section-head">
        <h2 id="pricing-title">Catalog pricing</h2>
        <p class="subtle">
          The list price is where every new order starts. Only Cerbo Admin changes it; providers
          can only move an order's price through margin %. Every change is reviewed first and kept in the price history.
        </p>
      </div>
      <Skeleton v-if="loading && items.length === 0" :lines="5" height="2.25rem" label="Loading catalog" />
      <div v-else-if="items.length > 0" class="table-wrap">
        <table class="table table-stack" data-testid="pricing-table">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col" class="num">Cerbo cost</th>
              <th scope="col" class="num">List price</th>
              <th scope="col" class="num">Margin at list</th>
              <th scope="col">Recurring</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="it in items" :key="`p-${it.sku}`">
              <tr :data-testid="`pricing-row-${it.sku}`">
                <td data-label="Product">
                  <span class="product">
                    <span class="product-name">{{ it.name }}</span>
                    <code>{{ it.sku }}</code>
                  </span>
                </td>
                <td data-label="Cerbo cost" class="num"><Money :cents="it.unitCogsCents" /></td>
                <td data-label="List price" class="num"><Money :cents="it.listPriceCents" strong /></td>
                <td data-label="Margin at list" class="num">{{ formatBps(it.listMarginBps) }}</td>
                <td data-label="Recurring">
                  <span v-if="it.activeScheduleCount > 0" class="badge badge-info">{{ it.activeScheduleCount }} active</span>
                  <span v-else class="subtle">None</span>
                </td>
                <td data-label="" class="price-actions">
                  <div class="row-center">
                    <UiButton size="sm" variant="primary" :data-testid="`edit-price-${it.sku}`" @click="editing = it">Change price</UiButton>
                    <button
                      type="button"
                      class="btn-link"
                      :aria-expanded="historyOpen === it.sku"
                      :aria-controls="`history-${it.sku}`"
                      :data-testid="`history-${it.sku}`"
                      @click="toggleHistory(it.sku)"
                    >{{ historyOpen === it.sku ? 'Hide history' : 'History' }}</button>
                  </div>
                </td>
              </tr>
              <tr v-if="historyOpen === it.sku" :id="`history-${it.sku}`" class="history-row">
                <td colspan="6">
                  <Skeleton v-if="historyLoading === it.sku" :lines="2" label="Loading price history" />
                  <p v-else-if="historyError" class="row-error" role="alert">{{ historyError }}</p>
                  <p v-else-if="!(history[it.sku]?.length)" class="subtle">No price changes yet. The current price is the seeded catalog price.</p>
                  <ol v-else class="history" :aria-label="`Price history for ${it.name}`">
                    <li v-for="c in history[it.sku]" :key="c.id" data-testid="history-entry">
                      <span class="h-change">
                        <span class="money">{{ formatMoney(c.oldPriceCents) }}</span>
                        <span aria-hidden="true">→</span>
                        <span class="sr-only">to</span>
                        <strong class="money">{{ formatMoney(c.newPriceCents) }}</strong>
                      </span>
                      <span class="h-reason">{{ c.reason }}</span>
                      <span class="h-meta subtle">{{ c.actorName ?? c.actorUserId }} · {{ shortDateTime(c.changedAt) }}</span>
                    </li>
                  </ol>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>

    <section class="section" aria-labelledby="stock-title">
      <div class="section-head">
        <h2 id="stock-title">Stock <span class="demo-label">Demo only</span> <DemoBadge :reason="RESTOCK_REASON" /></h2>
      </div>
    <p class="demo-banner" role="note">
      <strong>Demo only.</strong> Cerbo holds one shared inventory pool for every practice
      (ADR-009). Restock here is a demo convenience for refilling stock between scenarios.
      In production, stock arrives through real receiving - a provider never restocks.
    </p>

    <Skeleton v-if="loading && items.length === 0" :lines="5" height="2.25rem" label="Loading inventory" />

    <EmptyState v-else-if="!error && items.length === 0" title="No products in the catalog" message="Seed the catalog to see stock here." />

    <div v-else-if="items.length > 0" class="table-wrap">
      <table class="table table-stack" :aria-busy="loading ? 'true' : undefined">
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">Availability</th>
            <th scope="col" class="num">On hand</th>
            <th scope="col" class="num">Reserved</th>
            <th scope="col" class="num">Available</th>
            <th scope="col">Active</th>
            <th scope="col">Restock</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="it in items" :key="it.sku" :data-testid="`inventory-row-${it.sku}`">
            <td data-label="Product">
              <span class="product">
                <span class="product-name">{{ it.name }}</span>
                <code>{{ it.sku }}</code>
              </span>
            </td>
            <td data-label="Availability">
              <span class="badge" :class="`badge-${availability(it.available).tone}`" data-testid="availability-chip">
                {{ availability(it.available).label }}
              </span>
            </td>
            <td data-label="On hand" class="num">{{ it.onHandQty }}</td>
            <td data-label="Reserved" class="num">{{ it.reservedQty }}</td>
            <td data-label="Available" class="num">{{ it.available }}</td>
            <td data-label="Active">{{ it.active ? 'Yes' : 'No' }}</td>
            <td data-label="Restock" class="restock-cell">
              <form class="restock" novalidate @submit.prevent="requestRestock(it)">
                <label :for="`qty-${it.sku}`" class="qty-label">Units<span class="sr-only"> to add to {{ it.name }}</span></label>
                <input
                  :id="`qty-${it.sku}`"
                  v-model="qty[it.sku]"
                  type="number"
                  min="1"
                  max="10000"
                  step="1"
                  inputmode="numeric"
                  class="qty-input"
                  :aria-invalid="rowError[it.sku] ? 'true' : undefined"
                  :aria-describedby="rowError[it.sku] ? `qty-err-${it.sku}` : undefined"
                  :disabled="restockingSku === it.sku"
                  data-testid="restock-qty"
                />
                <UiButton type="submit" size="sm" :busy="restockingSku === it.sku" busy-label="Adding..." data-testid="restock-submit">
                  Restock
                </UiButton>
                <DemoBadge :reason="RESTOCK_REASON" />
              </form>
              <p v-if="rowError[it.sku]" :id="`qty-err-${it.sku}`" class="row-error">{{ rowError[it.sku] }}</p>
              <p class="row-status" aria-live="polite">{{ rowStatus[it.sku] }}</p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    </section>

    <PriceEditDialog :item="editing" @saved="onPriceSaved" @close="editing = null" @conflict="load" />

    <ConfirmDialog
      :open="pending !== null"
      :title="pending ? `Add ${pending.qty} units of ${pending.name}?` : ''"
      confirm-label="Add stock"
      :busy="restockingSku !== null"
      @confirm="confirmRestock"
      @cancel="pending = null"
    >
      <p>
        Adds to on-hand stock in the shared pool. This is a demo convenience; in production
        stock arrives through real receiving.
      </p>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.admin-inventory {
  max-width: 1120px;
}
.section {
  margin-bottom: var(--space-10);
}
.section-head h2 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}
.section-head p {
  margin-bottom: var(--space-4);
  max-width: 48rem;
}
.demo-label {
  font-size: var(--text-sm);
  font-weight: 650;
  color: var(--demo);
}
.price-actions {
  text-align: right;
}
.price-actions .row-center {
  justify-content: flex-end;
}
.history-row > td {
  background: var(--surface-2);
}
.history {
  list-style: none;
  margin: 0;
  padding: 0;
}
.history li {
  display: grid;
  grid-template-columns: minmax(10rem, auto) 1fr auto;
  gap: var(--space-1) var(--space-4);
  align-items: baseline;
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border);
}
.history li:last-child {
  border-bottom: none;
}
.h-change {
  display: inline-flex;
  gap: var(--space-2);
  white-space: nowrap;
}
.h-reason {
  min-width: 0;
}
@media (max-width: 640px) {
  .history li {
    grid-template-columns: 1fr;
  }
  .price-actions .row-center {
    justify-content: flex-start;
  }
}
.demo-banner {
  background: var(--demo-tint);
  border: 1px solid var(--demo-border);
  border-left: 4px solid var(--demo);
  border-radius: var(--radius);
  padding: var(--space-3) var(--space-4);
  color: var(--demo);
  margin: 0 0 var(--space-4);
}
.product {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.product-name {
  font-weight: 600;
}
.restock {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}
.qty-label {
  font-size: var(--text-sm);
  font-weight: 600;
}
.qty-input {
  width: 5.5rem;
}
.row-error {
  margin: var(--space-1) 0 0;
  color: var(--danger);
  font-size: var(--text-sm);
  font-weight: 550;
}
.row-status {
  margin: 0;
  color: var(--success);
  font-size: var(--text-sm);
}
.row-status:not(:empty) {
  margin-top: var(--space-1);
}
@media (max-width: 640px) {
  .restock-cell {
    flex-direction: column;
    align-items: stretch;
  }
  .restock-cell::before {
    margin-bottom: var(--space-1);
  }
  .restock {
    justify-content: flex-end;
  }
}
</style>
