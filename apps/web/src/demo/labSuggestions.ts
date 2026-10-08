// DEMO extension (ADR-029): lab-informed supplement suggestions on the order builder.
//
// Web-only and simulated on purpose: the lab panels below are hard-coded for the two seeded
// patients, and a small rule table maps each marker to the catalog product it relates to.
// Nothing here is a clinical recommendation, nothing is stored, and no money is computed:
// the block is read-only decision support the provider can ignore. A production version
// would move the panels and rules server-side behind provider-scoped access (lab results
// are protected health information) and source them from a lab feed (HL7/FHIR).

/** One marker the rules understand: how to read it and which product it relates to. */
interface MarkerRule {
  label: string
  unit: string
  /** Reference range as shown to the provider. */
  range: string
  /** Decimal places the result is reported with (lab convention: 4.0 mg/dL, not 4). */
  decimals: number
  /** A result below this is "low" and produces a suggestion. */
  lowBelow: number
  /** Catalog product the marker relates to. */
  sku: string
  /** Optional one-line context shown with the suggestion. */
  note?: string
}

const RULES = {
  vitaminD: { label: '25-OH Vitamin D', unit: 'ng/mL', range: '30-100', decimals: 0, lowBelow: 30, sku: 'VITD3-K2' },
  magnesium: {
    label: 'RBC magnesium',
    unit: 'mg/dL',
    range: '4.2-6.8',
    decimals: 1,
    lowBelow: 4.2,
    sku: 'MAG-GLY-120',
    note: 'Also helps the body use vitamin D.'
  },
  omega3: { label: 'Omega-3 Index', unit: '%', range: '8% or more', decimals: 1, lowBelow: 8, sku: 'OMEGA3-1000' },
  zinc: { label: 'Zinc', unit: 'ug/dL', range: '70-120', decimals: 0, lowBelow: 70, sku: 'ZINC-30' },
  microbiome: { label: 'Gut microbiome diversity score', unit: '/ 10', range: '6 or more', decimals: 0, lowBelow: 6, sku: 'PROBIO-50B' },
  crp: { label: 'hs-CRP', unit: 'mg/L', range: 'under 1.0', decimals: 1, lowBelow: 0, sku: '' }
} satisfies Record<string, MarkerRule>

type MarkerKey = keyof typeof RULES

interface LabPanel {
  collectedOn: string
  results: Array<{ marker: MarkerKey; value: number }>
}

/** Simulated latest panels for the seeded patients (apps/api/src/db/seeds/01_core.ts). */
const PANELS: Record<string, LabPanel> = {
  // Cara Lopez
  'cccccccc-0000-0000-0000-000000000001': {
    collectedOn: '2026-09-28',
    results: [
      { marker: 'vitaminD', value: 22 },
      { marker: 'magnesium', value: 4.0 },
      { marker: 'omega3', value: 3.6 },
      { marker: 'zinc', value: 64 },
      { marker: 'crp', value: 0.6 }
    ]
  },
  // Dev Patel
  'cccccccc-0000-0000-0000-000000000002': {
    collectedOn: '2026-09-21',
    results: [
      { marker: 'vitaminD', value: 41 },
      { marker: 'magnesium', value: 5.1 },
      { marker: 'omega3', value: 4.1 },
      { marker: 'microbiome', value: 4 },
      { marker: 'crp', value: 0.8 }
    ]
  }
}

export interface LabSuggestion {
  sku: string
  productName: string
  marker: string
  result: string
  range: string
  note: string | null
  onOrder: boolean
  outOfStock: boolean
}

export interface LabSuggestionsView {
  collectedOn: string
  suggestions: LabSuggestion[]
  /** Results in range, shown as one line ("hs-CRP 0.6 mg/L"). */
  normal: string[]
}

/**
 * The read-only suggestions for a patient's latest (simulated) panel: one entry per LOW
 * marker, in panel order, marked when the product is already on the order or out of stock.
 * Returns null when the patient has no panel on file.
 */
export function labSuggestions(
  patientId: string | null,
  onOrderSkus: ReadonlySet<string>,
  products: ReadonlyArray<{ sku: string; name: string; available: number }>
): LabSuggestionsView | null {
  const panel = patientId ? PANELS[patientId] : undefined
  if (!panel) return null
  const bySku = new Map(products.map((p) => [p.sku, p]))
  const suggestions: LabSuggestion[] = []
  const normal: string[] = []
  for (const { marker, value } of panel.results) {
    const rule: MarkerRule = RULES[marker]
    const shown = new Intl.NumberFormat('en-US', { minimumFractionDigits: rule.decimals, maximumFractionDigits: rule.decimals }).format(value)
    const result = rule.unit === '%' ? `${shown}%` : `${shown} ${rule.unit}`
    if (!rule.sku || value >= rule.lowBelow) {
      normal.push(`${rule.label} ${result}`)
      continue
    }
    const product = bySku.get(rule.sku)
    suggestions.push({
      sku: rule.sku,
      productName: product?.name ?? rule.sku,
      marker: rule.label,
      result,
      range: rule.range,
      note: rule.note ?? null,
      onOrder: onOrderSkus.has(rule.sku),
      outOfStock: product ? product.available <= 0 : false
    })
  }
  return { collectedOn: panel.collectedOn, suggestions, normal }
}
