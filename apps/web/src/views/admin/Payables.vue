<script setup lang="ts">
// Cerbo Admin payables (FR-11 AC3). View a UTC month's payable statements and close the
// month into immutable statements (ADR-016). GET /api/admin/payables?month= returns the
// stored statements once closed, or a live preview before. POST /api/admin/payables/close
// creates the statements; a month already closed returns ALREADY_CLOSED. The UI only
// displays and triggers the close - all money aggregation happens server-side from the
// ledger (AGENTS.md money rule 2).
import { onMounted, ref } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import { currentUserId } from '../../api/session'
import type { AdminPayablesResponse, ClosePayablesResult } from '@cerbo/contracts'
import { formatCents } from '../../components/order/format'

function currentMonthToken(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

const month = ref(currentMonthToken())
const data = ref<AdminPayablesResponse | null>(null)
const loading = ref(false)
const closing = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  notice.value = null
  try {
    data.value = await apiRequest<AdminPayablesResponse>(
      `/admin/payables?month=${encodeURIComponent(month.value)}`
    )
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Failed to load payables.'
    data.value = null
  } finally {
    loading.value = false
  }
}

async function close(): Promise<void> {
  closing.value = true
  error.value = null
  notice.value = null
  try {
    const result = await apiRequest<ClosePayablesResult>('/admin/payables/close', {
      method: 'POST',
      body: { month: month.value }
    })
    notice.value = `Closed ${result.month}: ${result.statements.length} statement(s) created.`
    await load()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Failed to close the month.'
  } finally {
    closing.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="admin-payables">
    <h2>Admin Payables</h2>

    <div class="toolbar">
      <label class="field">
        Month (YYYY-MM)
        <input v-model="month" type="month" :disabled="loading || closing" />
      </label>
      <button type="button" :disabled="loading || closing" @click="load">View</button>
      <button type="button" :disabled="loading || closing || data?.closed" @click="close">
        Close month
      </button>
    </div>

    <p v-if="error" class="page-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice-ok" role="status">{{ notice }}</p>
    <p v-if="loading" class="notice">Loading...</p>

    <template v-if="data && !loading">
      <p class="period">
        <strong>{{ data.periodStart }}</strong> to <strong>{{ data.periodEnd }}</strong> (UTC) -
        <span :class="data.closed ? 'tag-closed' : 'tag-open'">{{ data.closed ? 'Closed' : 'Open (preview)' }}</span>
      </p>

      <table class="report-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th class="num">Opening</th>
            <th class="num">Credits</th>
            <th class="num">Debits</th>
            <th class="num">Closing</th>
            <th>Closed at</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in data.statements" :key="s.providerId">
            <td><code>{{ s.providerId }}</code></td>
            <td class="num">{{ formatCents(s.openingCents) }}</td>
            <td class="num">{{ formatCents(s.creditsCents) }}</td>
            <td class="num">{{ formatCents(s.debitsCents) }}</td>
            <td class="num">{{ formatCents(s.closingCents) }}</td>
            <td>{{ s.closedAt ? new Date(s.closedAt).toLocaleString() : '-' }}</td>
          </tr>
          <tr v-if="data.statements.length === 0">
            <td colspan="6" class="notice">No payable activity in this month.</td>
          </tr>
        </tbody>
      </table>
    </template>

    <p class="actor-note">Acting as <code>{{ currentUserId }}</code>.</p>
  </section>
</template>

<style scoped>
.admin-payables {
  max-width: 920px;
}
.toolbar {
  display: flex;
  gap: 1rem;
  align-items: flex-end;
  margin-bottom: 0.75rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85em;
  color: var(--muted);
}
.period {
  color: var(--muted);
}
.tag-closed {
  color: var(--success);
  font-weight: 700;
}
.tag-open {
  color: var(--warning);
  font-weight: 700;
}
.report-table {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.report-table th,
.report-table td {
  border-bottom: 1px solid var(--border);
  padding: 0.5rem 0.7rem;
  text-align: left;
}
.report-table tbody tr:last-child td {
  border-bottom: none;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
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
