<script setup lang="ts">
// Cerbo Admin inventory console (FR-15, ADR-009) - T11.
//
// Cerbo owns ONE shared inventory pool (ADR-009). This view lists the pool and lets a
// Cerbo Admin restock a SKU. Restock is DEMO ONLY: it exists so a demo can refill stock
// between scenarios; in production stock arrives through real receiving and a provider
// never restocks. The banner and per-action copy say so. Money (unit COGS) is
// DISPLAY-only here (AGENTS.md money rule 2) - formatted, never computed with.
import { onMounted, ref } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import type { AdminInventoryItem, AdminInventoryResponse, RestockResult } from '@cerbo/contracts'
import DemoBadge from '../../components/DemoBadge.vue'
import PageHeader from '../../components/ui/PageHeader.vue'
import Money from '../../components/ui/Money.vue'
import UiButton from '../../components/ui/UiButton.vue'
import ConfirmDialog from '../../components/ui/ConfirmDialog.vue'
import EmptyState from '../../components/ui/EmptyState.vue'
import Skeleton from '../../components/ui/Skeleton.vue'
import { toast } from '../../components/ui/toast'

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

onMounted(load)
</script>

<template>
  <section class="admin-inventory">
    <PageHeader title="Inventory" subtitle="Cerbo's shared stock pool, used by every practice.">
      <template #actions>
        <span class="demo-label">Demo only</span>
        <DemoBadge :reason="RESTOCK_REASON" />
      </template>
    </PageHeader>

    <p class="demo-banner" role="note">
      <strong>Demo only.</strong> Cerbo holds one shared inventory pool for every practice
      (ADR-009). Restock here is a demo convenience for refilling stock between scenarios.
      In production, stock arrives through real receiving - a provider never restocks.
    </p>

    <p v-if="error" class="page-error" role="alert">{{ error }}</p>

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
            <th scope="col" class="num">Unit cost</th>
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
            <td data-label="Unit cost" class="num"><Money :cents="it.unitCogsCents" /></td>
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
.demo-label {
  font-weight: 650;
  color: var(--demo);
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
