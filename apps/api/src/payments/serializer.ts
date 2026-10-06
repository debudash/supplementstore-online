// Patient whitelist serializer (T4) - FR-5 AC1, EVAL-12, RT-10, NFR-5.
//
// The patient view is built field-by-field from a strict allow-list. It is NOT a
// filtered copy of an internal object: COGS, fee, margin, provider ids and economics
// simply never enter the returned shape, so there is nothing to accidentally leak.
import type { PatientPayItem, PatientPayView } from './types'

/** Inputs the serializer may read. Deliberately a subset - no economics beyond price/total. */
export interface PatientLineInput {
  name: string
  qty: number
  unitPriceCents: number
  lineTotalCents: number
}

export interface PatientViewInput {
  status: string
  subtotalCents: number
  patientFullName: string
  lines: PatientLineInput[]
}

/** First name only (never the full patient record). Empty string if no name. */
function firstName(fullName: string): string {
  return (fullName ?? '').trim().split(/\s+/)[0] ?? ''
}

/**
 * Build the patient-safe view. The returned object's keys are EXACTLY:
 * items[{ name, qty, unitPriceCents, lineTotalCents }], totalCents, status,
 * patientFirstName. Any other field is impossible to emit from here.
 */
export function toPatientView(input: PatientViewInput): PatientPayView {
  const items: PatientPayItem[] = input.lines.map((l) => ({
    name: l.name,
    qty: l.qty,
    unitPriceCents: l.unitPriceCents,
    lineTotalCents: l.lineTotalCents
  }))
  return {
    items,
    totalCents: input.subtotalCents,
    status: input.status as PatientPayView['status'],
    patientFirstName: firstName(input.patientFullName)
  }
}
