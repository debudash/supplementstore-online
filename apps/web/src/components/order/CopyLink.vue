<script setup lang="ts">
// Copyable patient pay link (FR-4 AC4). The link is always visible and selectable; Copy
// uses the Clipboard API and degrades to "select the field" text otherwise. In production
// the patient is emailed or texted the link (Notifier seam), hence the demo marker.
import { ref, computed } from 'vue'
import DemoBadge from '../DemoBadge.vue'

const props = defineProps<{ payUrl: string; compact?: boolean }>()

// payUrl is a relative path like /pay/<token>; show the absolute URL the patient opens.
const absoluteUrl = computed(() => {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}${props.payUrl}`
})

const copied = ref(false)
const copyFailed = ref(false)

async function copy(): Promise<void> {
  copied.value = false
  copyFailed.value = false
  try {
    await navigator.clipboard.writeText(absoluteUrl.value)
    copied.value = true
  } catch {
    copyFailed.value = true
  }
}
</script>

<template>
  <section class="copy-link" :class="{ compact }" aria-label="Patient pay link">
    <div class="head">
      <h3 class="title">Patient pay link</h3>
      <DemoBadge reason="In production the patient is emailed or texted this link. It is shown here so you can open the pay page during the demo." />
    </div>
    <div class="row">
      <input :value="absoluteUrl" readonly data-test="pay-url" aria-label="Patient pay link URL" @focus="($event.target as HTMLInputElement).select()" />
      <button type="button" class="btn-primary" data-testid="copy-link" @click="copy">{{ copied ? 'Copied' : 'Copy link' }}</button>
    </div>
    <p v-if="copied" class="ok" role="status">Link copied.</p>
    <p v-if="copyFailed" class="warn" role="status">Copy is unavailable - select the field and copy manually.</p>
  </section>
</template>

<style scoped>
.copy-link {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-4);
}
.copy-link.compact {
  border: none;
  padding: var(--space-2) 0;
  background: none;
}
.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.title {
  margin: 0;
  font-size: var(--text-md);
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.row input {
  flex: 1 1 16rem;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  background: var(--surface-2);
}
.ok {
  color: var(--success);
  font-weight: 600;
  margin: var(--space-2) 0 0;
}
.warn {
  color: var(--warning);
  margin: var(--space-2) 0 0;
}
</style>
