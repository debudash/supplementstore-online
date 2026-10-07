<script setup lang="ts">
// Cerbo Admin demo data (FR-14). Import a historical baseline from CSV text, regenerate
// the synthetic baseline, generate synthetic in-house migration activity (through the
// real split + posting code, backdated, no inventory impact), and reset all synthetic
// data. The demo generators and reset require DEMO_MODE=true server-side; a disabled
// server returns DEMO_DISABLED, surfaced here as an error. The UI only triggers and
// reports - all generation and the guarded purge happen server-side (ADR-019).
//
// Regenerate replaces data and Reset purges it, so both go through a ConfirmDialog;
// Reset additionally requires typing RESET.
import { computed, ref } from 'vue'
import { apiRequest, ApiError } from '../../api/client'
import type {
  BaselineImportResult,
  BaselineRegenerateResult,
  MigrationGenerateResult,
  DemoResetResult
} from '@cerbo/contracts'
import DemoBadge from '../../components/DemoBadge.vue'
import PageHeader from '../../components/ui/PageHeader.vue'
import Card from '../../components/ui/Card.vue'
import Money from '../../components/ui/Money.vue'
import UiAlert from '../../components/ui/UiAlert.vue'
import UiField from '../../components/ui/UiField.vue'
import UiButton from '../../components/ui/UiButton.vue'
import ConfirmDialog from '../../components/ui/ConfirmDialog.vue'

const SAMPLE_CSV = 'provider_email,order_date,gmv_cents,source\nana@riverside.example,2026-01-15,48000,Fullscript'

// Bounds match the server's validation (admin/demo/router.ts intField).
const SEED_MAX = 2_000_000_000
const MONTHS_MAX = 60

type Action = 'import' | 'regenerate' | 'migration' | 'reset'

const csv = ref(SAMPLE_CSV)
const seed = ref<number | string>(7)
const baselineMonths = ref<number | string>(6)
const migrationMonths = ref<number | string>(3)

const busy = ref<Action | null>(null)
const confirming = ref<'regenerate' | 'reset' | null>(null)
const error = ref<string | null>(null)

const importResult = ref<BaselineImportResult | null>(null)
const regenerateResult = ref<BaselineRegenerateResult | null>(null)
const migrationResult = ref<MigrationGenerateResult | null>(null)
const resetResult = ref<DemoResetResult | null>(null)

function intError(value: number | string, label: string, min: number, max: number): string | null {
  const s = String(value).trim()
  if (!/^\d+$/.test(s)) return `${label} must be a whole number.`
  const n = Number(s)
  if (n < min || n > max) return `${label} must be between ${min} and ${max}.`
  return null
}

const seedError = computed(() => intError(seed.value, 'Seed', 0, SEED_MAX))
const baselineMonthsError = computed(() => intError(baselineMonths.value, 'Baseline months', 1, MONTHS_MAX))
const migrationMonthsError = computed(() => intError(migrationMonths.value, 'Migration months', 1, MONTHS_MAX))

const PURGED_LABELS: Record<keyof DemoResetResult['purged'], string> = {
  orders: 'Orders',
  orderLines: 'Order lines',
  orderEvents: 'Order status events',
  payments: 'Payments',
  refunds: 'Refunds',
  journals: 'Journals',
  ledgerEntries: 'Ledger entries',
  inventoryMovements: 'Inventory movements',
  baselineOrders: 'Baseline rows',
  baselineImports: 'Baseline imports'
}
const PURGED_KEYS = Object.keys(PURGED_LABELS) as (keyof DemoResetResult['purged'])[]

function clearResults(): void {
  error.value = null
  importResult.value = null
  regenerateResult.value = null
  migrationResult.value = null
  resetResult.value = null
}

async function run(action: Action, fn: () => Promise<void>): Promise<void> {
  busy.value = action
  clearResults()
  try {
    await fn()
  } catch (err) {
    error.value = err instanceof ApiError ? `${err.message} (${err.code})` : 'Request failed.'
  } finally {
    busy.value = null
    confirming.value = null
  }
}

const importCsv = () =>
  run('import', async () => {
    importResult.value = await apiRequest<BaselineImportResult>('/admin/baseline/import', {
      method: 'POST',
      body: { csv: csv.value }
    })
  })

function askRegenerate(): void {
  if (seedError.value || baselineMonthsError.value) return
  confirming.value = 'regenerate'
}

const regenerate = () =>
  run('regenerate', async () => {
    regenerateResult.value = await apiRequest<BaselineRegenerateResult>('/admin/demo/baseline/regenerate', {
      method: 'POST',
      body: { seed: Number(seed.value), months: Number(baselineMonths.value) }
    })
  })

function generateMigration(): void {
  if (seedError.value || migrationMonthsError.value) return
  void run('migration', async () => {
    migrationResult.value = await apiRequest<MigrationGenerateResult>('/admin/demo/migration/generate', {
      method: 'POST',
      body: { seed: Number(seed.value), months: Number(migrationMonths.value) }
    })
  })
}

const reset = () =>
  run('reset', async () => {
    resetResult.value = await apiRequest<DemoResetResult>('/admin/demo/reset', { method: 'POST', body: {} })
  })

function onConfirm(): void {
  if (confirming.value === 'regenerate') void regenerate()
  else if (confirming.value === 'reset') void reset()
}
</script>

<template>
  <section class="demo-data">
    <PageHeader title="Demo data" subtitle="Load a baseline, generate synthetic activity, or clear it all.">
      <template #actions>
        <DemoBadge reason="Demo affordance - this entire screen is demonstration tooling. It generates and removes synthetic data and does not exist in the production product." />
      </template>
    </PageHeader>

    <p class="demo-notice" role="note">
      <strong>Demo only.</strong> These controls generate and remove synthetic demonstration
      data. Reset purges only rows flagged synthetic; it can never touch real orders, payments
      or ledger entries. Metrics exclude synthetic data by default.
    </p>

    <div class="results" aria-live="polite">
      <p v-if="error" class="page-error" role="alert" data-testid="demo-error">{{ error }}</p>

      <UiAlert v-if="importResult" :tone="importResult.insertedCount > 0 ? 'success' : 'warning'" title="Baseline import finished" data-testid="demo-result">
        Imported {{ importResult.insertedCount }} row(s); {{ importResult.rejected.length }} rejected.
        <div v-if="importResult.rejected.length > 0" class="table-wrap rejected">
          <table class="table table-stack">
            <caption class="sr-only">Rejected rows</caption>
            <thead>
              <tr>
                <th scope="col" class="num">Row</th>
                <th scope="col">Reason</th>
                <th scope="col">Content</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in importResult.rejected" :key="r.row">
                <td data-label="Row" class="num">{{ r.row }}</td>
                <td data-label="Reason">{{ r.reason }}</td>
                <td data-label="Content"><code>{{ r.raw }}</code></td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiAlert>

      <UiAlert v-if="regenerateResult" tone="success" title="Synthetic baseline regenerated" data-testid="demo-result">
        Inserted {{ regenerateResult.insertedCount }} row(s), replaced {{ regenerateResult.replacedCount }}
        (seed {{ regenerateResult.seed }}, {{ regenerateResult.months }} months).
      </UiAlert>

      <UiAlert v-if="migrationResult" tone="success" title="Migration activity generated" data-testid="demo-result">
        Generated {{ migrationResult.orderCount }} synthetic paid order(s) worth <Money :cents="migrationResult.gmvCents" />
        (seed {{ migrationResult.seed }}, {{ migrationResult.months }} months).
      </UiAlert>

      <UiAlert v-if="resetResult" tone="success" title="Synthetic data reset" data-testid="demo-result">
        Purged rows by table. Real data untouched.
        <dl class="counts">
          <div v-for="k in PURGED_KEYS" :key="k">
            <dt>{{ PURGED_LABELS[k] }}</dt>
            <dd>{{ resetResult.purged[k] }}</dd>
          </div>
        </dl>
      </UiAlert>
    </div>

    <div class="stack">
      <Card title="Import baseline CSV" subtitle="Historical marketplace sales per provider, used for the migration report.">
        <UiField v-slot="f" label="Baseline CSV" hint="Header: provider_email,order_date,gmv_cents,source. Bad rows are rejected and listed, never inserted.">
          <textarea
            :id="f.id"
            v-model="csv"
            rows="5"
            class="csv"
            spellcheck="false"
            :aria-describedby="f.describedby"
            :disabled="busy !== null"
            data-testid="baseline-csv"
          ></textarea>
        </UiField>
        <div class="row actions">
          <UiButton variant="primary" :busy="busy === 'import'" busy-label="Importing..." :disabled="busy !== null || !csv.trim()" data-testid="baseline-import" @click="importCsv">
            Import CSV
          </UiButton>
        </div>
      </Card>

      <Card title="Generate synthetic data" subtitle="Runs through the real posting code, flagged synthetic. Requires DEMO_MODE on the server." tone="demo">
        <template #actions>
          <DemoBadge reason="Demo affordance - generates synthetic baseline and in-house migration activity through the real posting code, flagged synthetic and excluded from metrics by default." />
        </template>
        <div class="inputs">
          <UiField v-slot="f" label="Seed" :hint="`0 to ${SEED_MAX}`" :error="seedError">
            <input :id="f.id" v-model="seed" type="number" min="0" :max="SEED_MAX" step="1" inputmode="numeric" :aria-describedby="f.describedby" :aria-invalid="f.invalid ? 'true' : undefined" data-testid="demo-seed" />
          </UiField>
          <UiField v-slot="f" label="Baseline months" :hint="`1 to ${MONTHS_MAX}`" :error="baselineMonthsError">
            <input :id="f.id" v-model="baselineMonths" type="number" min="1" :max="MONTHS_MAX" step="1" inputmode="numeric" :aria-describedby="f.describedby" :aria-invalid="f.invalid ? 'true' : undefined" data-testid="demo-baseline-months" />
          </UiField>
          <UiField v-slot="f" label="Migration months" :hint="`1 to ${MONTHS_MAX}`" :error="migrationMonthsError">
            <input :id="f.id" v-model="migrationMonths" type="number" min="1" :max="MONTHS_MAX" step="1" inputmode="numeric" :aria-describedby="f.describedby" :aria-invalid="f.invalid ? 'true' : undefined" data-testid="demo-migration-months" />
          </UiField>
        </div>
        <div class="row actions">
          <UiButton
            :busy="busy === 'regenerate'"
            busy-label="Regenerating..."
            :disabled="busy !== null || !!seedError || !!baselineMonthsError"
            data-testid="demo-regenerate"
            @click="askRegenerate"
          >
            Regenerate baseline
          </UiButton>
          <UiButton
            :busy="busy === 'migration'"
            busy-label="Generating..."
            :disabled="busy !== null || !!seedError || !!migrationMonthsError"
            data-testid="demo-generate-migration"
            @click="generateMigration"
          >
            Generate migration activity
          </UiButton>
        </div>
      </Card>

      <Card title="Danger zone" subtitle="Remove every synthetic row in one step." tone="danger">
        <template #actions>
          <DemoBadge reason="Demo affordance - purges only rows flagged synthetic (the one guarded exception to the append-only ledger). It can never touch real orders, payments or ledger entries, and is not a production control." />
        </template>
        <p class="danger-copy">
          Purges all synthetic orders with their lines, status events, payments, refunds,
          journals, ledger entries and inventory movements, plus synthetic baseline rows and
          imports. Real data and closed payable statements are never touched.
        </p>
        <UiButton variant="danger" :busy="busy === 'reset'" busy-label="Resetting..." :disabled="busy !== null" data-testid="demo-reset" @click="confirming = 'reset'">
          Reset synthetic data
        </UiButton>
      </Card>
    </div>

    <ConfirmDialog
      :open="confirming === 'regenerate'"
      title="Replace the synthetic baseline?"
      confirm-label="Regenerate"
      :busy="busy === 'regenerate'"
      @confirm="onConfirm"
      @cancel="confirming = null"
    >
      <p>
        Deletes every existing synthetic baseline row and generates a new set from seed
        {{ seed }} over {{ baselineMonths }} months. Imported (real) baseline rows are not touched.
      </p>
    </ConfirmDialog>

    <ConfirmDialog
      :open="confirming === 'reset'"
      title="Reset all synthetic data?"
      confirm-label="Reset"
      tone="danger"
      require-text="RESET"
      :busy="busy === 'reset'"
      @confirm="onConfirm"
      @cancel="confirming = null"
    >
      <p>This permanently deletes every row flagged synthetic:</p>
      <ul class="purge-list">
        <li>Synthetic orders, order lines and status events</li>
        <li>Their payments, refunds, journals and ledger entries</li>
        <li>Their inventory movements</li>
        <li>Synthetic baseline rows and baseline imports</li>
      </ul>
      <p>Real orders, payments, ledger entries and closed payable statements are never touched. This cannot be undone.</p>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.demo-data {
  max-width: 920px;
}
.demo-notice {
  color: var(--demo);
  background: var(--demo-tint);
  border: 1px solid var(--demo-border);
  border-left: 4px solid var(--demo);
  border-radius: var(--radius);
  padding: var(--space-3) var(--space-4);
  margin: 0 0 var(--space-4);
}
.results {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.results:empty {
  margin-bottom: 0;
}
.csv {
  width: 100%;
  font-family: var(--font-mono);
}
.actions {
  margin-top: var(--space-4);
}
.inputs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr));
  gap: var(--space-4);
}
.rejected {
  margin-top: var(--space-3);
  color: var(--text);
}
.counts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
  gap: var(--space-2) var(--space-4);
  margin: var(--space-2) 0 0;
}
.counts div {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
}
.counts dd {
  margin: 0;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.danger-copy {
  margin-top: 0;
}
.purge-list {
  margin: var(--space-2) 0;
  padding-left: var(--space-5);
}
</style>
