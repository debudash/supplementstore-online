<script setup lang="ts">
// Copyable patient pay link shown after send (FR-4 AC4). The link is always visible
// and selectable; the Copy button uses the Clipboard API when available and degrades
// to "select the field" text otherwise.
import { ref, computed } from 'vue'

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
    <h3>Patient pay link</h3>
    <p class="hint">Send this link to the patient so they can pay.</p>
    <div class="row">
      <input :value="absoluteUrl" readonly data-test="pay-url" @focus="($event.target as HTMLInputElement).select()" />
      <button type="button" @click="copy">Copy link</button>
    </div>
    <p v-if="copied" class="ok" role="status">Link copied.</p>
    <p v-if="copyFailed" class="warn" role="status">Copy is unavailable - select the field and copy manually.</p>
  </section>
</template>

<style scoped>
.copy-link {
  border: 1px solid #2d7d46;
  border-radius: 6px;
  padding: 0.75rem 1rem;
  margin-top: 1rem;
}
.hint {
  color: #555;
  margin: 0.2rem 0 0.5rem;
}
.row {
  display: flex;
  gap: 0.5rem;
}
.row input {
  flex: 1;
  font-family: monospace;
}
.ok {
  color: #2d7d46;
}
.warn {
  color: #b9770e;
}
</style>
