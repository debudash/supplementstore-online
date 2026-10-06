<script setup lang="ts">
// Cerbo Admin demo data (FR-14). Import a historical baseline from CSV text, regenerate
// the synthetic baseline, generate synthetic in-house migration activity (through the
// real split + posting code, backdated, no inventory impact), and reset all synthetic
// data. The demo generators and reset require DEMO_MODE=true server-side; a disabled
// server returns DEMO_DISABLED, surfaced here as an error. The UI only triggers and
// reports - all generation and the guarded purge happen server-side (ADR-019).
import { ref } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import { currentUserId } from '../../api/session'
import type {
  BaselineImportResult,
  BaselineRegenerateResult,
  MigrationGenerateResult,
  DemoResetResult
} from '@cerbo/contracts'

const SAMPLE_CSV = 'provider_email,order_date,gmv_cents,source\nana@riverside.example,2026-01-15,48000,Fullscript'

const csv = ref(SAMPLE_CSV)
const seed = ref(7)
const baselineMonths = ref(6)
const migrationMonths = ref(3)
const busy = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

async function run<T>(fn: () => Promise<T>, describe: (r: T) => string): Promise<void> {
  busy.value = true
  error.value = null
  notice.value = null
  try {
    notice.value = describe(await fn())
  } catch (err) {
    error.value = err instanceof ApiError ? `${err.code}: ${err.message}` : 'Request failed.'
  } finally {
    busy.value = false
  }
}

const importCsv = () =>
  run(
    () => apiRequest<BaselineImportResult>('/admin/baseline/import', { method: 'POST', body: { csv: csv.value } }),
    (r) => `Imported ${r.insertedCount} baseline row(s); ${r.rejected.length} rejected.`
  )

const regenerate = () =>
  run(
    () =>
      apiRequest<BaselineRegenerateResult>('/admin/demo/baseline/regenerate', {
        method: 'POST',
        body: { seed: seed.value, months: baselineMonths.value }
      }),
    (r) => `Regenerated synthetic baseline: ${r.insertedCount} row(s) (replaced ${r.replacedCount}).`
  )

const generateMigration = () =>
  run(
    () =>
      apiRequest<MigrationGenerateResult>('/admin/demo/migration/generate', {
        method: 'POST',
        body: { seed: seed.value, months: migrationMonths.value }
      }),
    (r) => `Generated ${r.orderCount} synthetic order(s), GMV ${(r.gmvCents / 100).toLocaleString('en-US')} dollars.`
  )

const reset = () =>
  run(
    () => apiRequest<DemoResetResult>('/admin/demo/reset', { method: 'POST', body: {} }),
    (r) =>
      `Reset: purged ${r.purged.orders} order(s), ${r.purged.ledgerEntries} ledger entr(ies), ` +
      `${r.purged.baselineOrders} baseline row(s). Real data untouched.`
  )
</script>

<template>
  <section class="demo-data">
    <h2>Demo Data</h2>

    <p class="demo-notice">
      Demo-only tooling. These controls generate and remove SYNTHETIC demonstration data.
      Reset purges only rows flagged synthetic; it can never touch real orders, payments,
      or ledger entries - the database triggers reject that, and the reset is the single
      guarded exception to the append-only ledger. Metrics exclude synthetic data by
      default.
    </p>

    <p v-if="error" class="page-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice-ok" role="status">{{ notice }}</p>

    <h3>Baseline import (CSV)</h3>
    <p class="hint">
      Header: <code>provider_email,order_date,gmv_cents,source</code>. Each row is validated;
      bad rows are rejected and reported, never inserted.
    </p>
    <textarea v-model="csv" rows="4" class="csv" :disabled="busy"></textarea>
    <div class="row">
      <button type="button" :disabled="busy" @click="importCsv">Import baseline CSV</button>
    </div>

    <h3>Synthetic demo data (DEMO_MODE only)</h3>
    <div class="row">
      <label class="field">Seed <input v-model.number="seed" type="number" :disabled="busy" /></label>
      <label class="field">
        Baseline months <input v-model.number="baselineMonths" type="number" min="1" max="60" :disabled="busy" />
      </label>
      <label class="field">
        Migration months <input v-model.number="migrationMonths" type="number" min="1" max="60" :disabled="busy" />
      </label>
    </div>
    <div class="row">
      <button type="button" :disabled="busy" @click="regenerate">Regenerate synthetic baseline</button>
      <button type="button" :disabled="busy" @click="generateMigration">Generate migration activity</button>
      <button type="button" class="danger" :disabled="busy" @click="reset">Reset (purge synthetic)</button>
    </div>

    <p class="actor-note">Acting as <code>{{ currentUserId }}</code>.</p>
  </section>
</template>

<style scoped>
.demo-data {
  max-width: 820px;
}
.demo-notice {
  color: #555;
  border: 1px dashed #888;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  margin-bottom: 1rem;
  font-size: 0.9em;
}
.hint {
  color: #555;
  font-size: 0.9em;
}
.csv {
  width: 100%;
  font-family: monospace;
  margin-bottom: 0.5rem;
}
.row {
  display: flex;
  gap: 1rem;
  align-items: flex-end;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.9em;
}
.field input {
  width: 8rem;
}
.danger {
  color: #c0392b;
  border-color: #c0392b;
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
