// API-side patient payment types (T4), mirroring packages/contracts/src/payments.ts.
// apps/api does not depend on @cerbo/contracts (it exports only its index barrel), so
// the API declares these shapes locally and keeps them in sync with the contract -
// the same pattern T3 uses for order views.
//
// PRIVACY: PatientPayView / PatientPayItem / PayResult are the ONLY shapes sent to a
// patient. None carries COGS, fee, margin, or provider economics (EVAL-12, RT-10).

export interface PatientPayItem {
  name: string
  qty: number
  unitPriceCents: number
  lineTotalCents: number
}

export interface PatientPayView {
  items: PatientPayItem[]
  totalCents: number
  status: string
  patientFirstName: string
}

export interface PayResult {
  paymentId: string
  status: 'paid'
  totalCents: number
}
