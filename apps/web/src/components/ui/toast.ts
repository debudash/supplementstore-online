// Tiny global toast store. Views call toast('Saved', 'success'); ToastHost renders them
// in a polite live region and removes each after a few seconds.
import { ref } from 'vue'

export type ToastTone = 'info' | 'success' | 'warning' | 'danger'
export interface Toast {
  id: number
  message: string
  tone: ToastTone
}

export const toasts = ref<Toast[]>([])
let nextId = 1

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

export function toast(message: string, tone: ToastTone = 'success', ms = 5000): void {
  const id = nextId++
  toasts.value = [...toasts.value, { id, message, tone }]
  if (typeof window !== 'undefined') window.setTimeout(() => dismissToast(id), ms)
}
