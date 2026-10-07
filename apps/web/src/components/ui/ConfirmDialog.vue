<script setup lang="ts">
// Modal confirmation for consequential or irreversible actions. Rendered in place (no
// Teleport) as a fixed overlay. Focus moves into the dialog on open (to Cancel for
// danger actions, so Enter never confirms by accident), Tab is trapped inside, Esc
// cancels, and focus returns to the element that opened it on close.
//
// Optional `requireText`: the confirm button stays disabled until the user types that
// exact word (used for the demo reset).
import { nextTick, ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  title: string
  confirmLabel: string
  cancelLabel?: string
  tone?: 'primary' | 'danger'
  busy?: boolean
  requireText?: string
}>()
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()

const panel = ref<HTMLElement | null>(null)
const cancelBtn = ref<HTMLButtonElement | null>(null)
const confirmBtn = ref<HTMLButtonElement | null>(null)
const typed = ref('')
let returnFocus: HTMLElement | null = null
const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`

watch(
  () => props.open,
  async (open) => {
    if (open) {
      typed.value = ''
      returnFocus = (document.activeElement as HTMLElement | null) ?? null
      await nextTick()
      ;(props.tone === 'danger' || props.requireText ? cancelBtn.value : confirmBtn.value)?.focus()
    } else if (returnFocus) {
      returnFocus.focus?.()
      returnFocus = null
    }
  }
)

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    if (!props.busy) emit('cancel')
    return
  }
  if (e.key !== 'Tab' || !panel.value) return
  const focusables = Array.from(
    panel.value.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select, textarea, a[href]')
  )
  if (focusables.length === 0) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}
</script>

<template>
  <div v-if="open" class="overlay" @mousedown.self="!busy && emit('cancel')">
    <div
      ref="panel"
      class="dialog"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      data-testid="confirm-dialog"
      @keydown="onKeydown"
    >
      <h2 :id="titleId" class="dialog-title">{{ title }}</h2>
      <div class="dialog-body"><slot /></div>
      <label v-if="requireText" class="require">
        Type <strong>{{ requireText }}</strong> to confirm
        <input v-model="typed" type="search" autocomplete="off" data-testid="confirm-require-input" />
      </label>
      <div class="dialog-actions">
        <button ref="cancelBtn" type="button" :disabled="busy" data-testid="confirm-cancel" @click="emit('cancel')">
          {{ cancelLabel ?? 'Cancel' }}
        </button>
        <button
          ref="confirmBtn"
          type="button"
          :class="tone === 'danger' ? 'btn-danger' : 'btn-primary'"
          :disabled="busy || (!!requireText && typed.trim() !== requireText)"
          data-testid="confirm-ok"
          @click="emit('confirm')"
        >
          {{ busy ? 'Working...' : confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: rgba(16, 24, 40, 0.45);
}
.dialog {
  width: min(32rem, 100%);
  max-height: calc(100vh - 2rem);
  overflow: auto;
  background: var(--surface);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: var(--space-6);
}
.dialog-title {
  font-size: var(--text-xl);
  margin: 0 0 var(--space-3);
}
.dialog-body {
  color: var(--text);
}
.require {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-4);
  font-size: var(--text-sm);
}
.dialog-actions {
  display: flex;
  flex-wrap: wrap-reverse;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-6);
}
@media (max-width: 480px) {
  .overlay {
    align-items: flex-end;
    padding: 0;
  }
  .dialog {
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    width: 100%;
  }
  .dialog-actions button {
    flex: 1 1 100%;
  }
}
</style>
