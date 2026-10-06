<script setup lang="ts">
// Copyable patient pay link shown after send (FR-4 AC4). The link is always visible
// and selectable; the Copy button uses the Clipboard API when available and degrades
// to "select the field" text otherwise. The link itself is a demo affordance: in
// production the patient would be emailed or texted the link (Notifier seam), not shown
// it on the provider's screen - hence the demo marker.
import { ref, computed } from 'vue'
import DemoBadge from '../DemoBadge.vue'

const props = defineProps<{ payUrl: string }>()

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
  <section class="copy-link" aria-label="Patient pay link">
    <div class="head">
      <h3>Patient pay link</h3>
      <DemoBadge reason="Demo affordance - in production the patient is emailed or texted this link (Notifier seam). It is surfaced here so you can open the pay page during the demo." />
    </div>
    <p class="hint">Send this link to the patient so they can pay.</p>
    <div class="row">
      <input :value="absoluteUrl" readonly data-test="pay-url" aria-label="Patient pay link URL" @focus="($event.target as HTMLInputElement).select()" />
      <button type="button" class="btn-primary" @click="copy">Copy link</button>
    </div>
    <p v-if="copied" class="ok" role="status">Link copied.</p>
    <p v-if="copyFailed" class="warn" role="status">Copy is unavailable - select the field and copy manually.</p>
  </section>
</template>

<style scoped>
.copy-link {
  border: 1px solid var(--success);
  background: var(--success-tint);
  border-radius: var(--radius);
  padding: 0.85rem 1rem;
  margin-top: 1rem;
}
.head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.head h3 {
  margin: 0;
}
.hint {
  color: var(--muted);
  margin: 0.35rem 0 0.6rem;
}
.row {
  display: flex;
  gap: 0.5rem;
}
.row input {
  flex: 1;
  font-family: var(--font-mono);
  background: var(--surface);
}
.ok {
  color: var(--success);
  font-weight: 600;
  margin: 0.5rem 0 0;
}
.warn {
  color: var(--warning);
  margin: 0.5rem 0 0;
}
</style>
