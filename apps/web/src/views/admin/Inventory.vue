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
import { currentUserId } from '../../api/session'
import type { AdminInventoryItem, AdminInventoryResponse, RestockResult } from '@cerbo/contracts'
import { formatCents } from '../../components/order/format'
import DemoBadge from '../../components/DemoBadge.vue'

const items = ref<AdminInventoryItem[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

// Per-SKU restock quantity input and in-flight flag, keyed by sku.
const qty = ref<Record<string, string>>({})
const restocking = ref<Record<string, boolean>>({})

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

async function restock(sku: string): Promise<void> {
  error.value = null
  notice.value = null
  const raw = (qty.value[sku] ?? '').trim()
  const n = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1) {
    error.value = `Enter a whole number of units (1 or more) to restock ${sku}.`
    return
  }
  restocking.value = { ...restocking.value, [sku]: true }
  try {
    const result = await apiRequest<RestockResult>(`/admin/inventory/${encodeURIComponent(sku)}/restock`, {
      method: 'POST',
      body: { qty: n }
    })
    notice.value = `Restocked ${result.qtyAdded} unit(s) of ${result.sku}. On hand is now ${result.onHandQty} (available ${result.available}).`
    qty.value = { ...qty.value, [sku]: '' }
    await load()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : `Failed to restock ${sku}.`
  } finally {
    restocking.value = { ...restocking.value, [sku]: false }
  }
}

onMounted(load)
</script>

<template>
  <section class="admin-inventory">
    <div class="head">
      <h2>Inventory</h2>
      <DemoBadge reason="Demo affordance - restock here refills the shared pool between demo scenarios. In production stock arrives through real receiving; a provider never restocks." />
    </div>

    <p class="demo-banner" role="note">
      <strong>Demo only.</strong> Cerbo holds one shared inventory pool for every practice
      (ADR-009). Restock here is a demo convenience for refilling stock between scenarios.
      In production, stock arrives through real receiving - a provider never restocks.
    </p>

    <p v-if="error" class="page-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice-ok" role="status">{{ notice }}</p>
    <p v-if="loading" class="notice">Loading...</p>

    <table v-if="!loading" class="inv-table">
      <thead>
        <tr>
          <th>SKU</th>
          <th>Name</th>
          <th class="num">On hand</th>
          <th class="num">Reserved</th>
          <th class="num">Available</th>
          <th class="num">Unit COGS</th>
          <th>Active</th>
          <th>Restock <DemoBadge reason="Demo affordance - refills stock between scenarios; not a production control." /></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="it in items" :key="it.sku">
          <td><code>{{ it.sku }}</code></td>
          <td>{{ it.name }}</td>
          <td class="num">{{ it.onHandQty }}</td>
          <td class="num">{{ it.reservedQty }}</td>
          <td class="num">{{ it.available }}</td>
          <td class="num">{{ formatCents(it.unitCogsCents) }}</td>
          <td>{{ it.active ? 'yes' : 'no' }}</td>
          <td>
            <form class="restock" @submit.prevent="restock(it.sku)">
              <input
                v-model="qty[it.sku]"
                type="number"
                min="1"
                step="1"
                inputmode="numeric"
                :aria-label="`Units to restock ${it.sku}`"
                placeholder="qty"
                :disabled="restocking[it.sku]"
              />
              <button type="submit" :disabled="restocking[it.sku]">
                {{ restocking[it.sku] ? 'Restocking...' : 'Restock' }}
              </button>
            </form>
          </td>
        </tr>
        <tr v-if="items.length === 0">
          <td colspan="8" class="notice">No products in the catalog.</td>
        </tr>
      </tbody>
    </table>

    <p class="actor-note">Acting as <code>{{ currentUserId }}</code>.</p>
  </section>
</template>

<style scoped>
.admin-inventory {
  max-width: 1000px;
}
.head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.head h2 {
  margin-bottom: 0;
}
.demo-banner {
  background: var(--demo-tint);
  border: 1px solid var(--demo-border);
  border-radius: var(--radius);
  padding: 0.6rem 0.85rem;
  color: var(--demo);
  margin: 1rem 0;
}
.inv-table {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.inv-table th,
.inv-table td {
  border-bottom: 1px solid var(--border);
  padding: 0.5rem 0.7rem;
  text-align: left;
}
.inv-table tbody tr:last-child td {
  border-bottom: none;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.restock {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}
.restock input {
  width: 6rem;
}
.notice {
  color: var(--muted);
}
.notice-ok {
  color: var(--success);
  background: var(--success-tint);
  border: 1px solid var(--success);
  border-radius: var(--radius-sm);
  padding: 0.5rem 0.75rem;
}
.actor-note {
  margin-top: 1.5rem;
  color: var(--subtle);
  font-size: 0.85em;
}
</style>
