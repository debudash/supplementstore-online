// @vitest-environment happy-dom
//
// Render + interaction tests for the owner's New Order requirements:
//  - price is SHOWN READ-ONLY in "Add item" (no price input to type into);
//  - margin % is editable and carries the shared DemoBadge; COGS figures are badged;
//  - a margin % overrides the catalog price (server re-derives), otherwise the catalog
//    price is used as-is - the doctor never types a price;
//  - "Update line" is QUANTITY ONLY (no price/margin field on an existing line).
// These assert behaviour the owner asked for; they do not weaken any existing check.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AddLineForm from './AddLineForm.vue'
import LineRow from './LineRow.vue'

// With the seeded catalog list price (ProductView.listPriceCents) present.
const products = [
  { sku: 'MAG-GLY-120', name: 'Magnesium Glycinate 120ct', unitCogsCents: 1450, available: 50, active: true, listPriceCents: 2999 }
]
// Before the backend list_price_cents field merges, ProductView has no listPriceCents.
const productsNoPrice = [
  { sku: 'MAG-GLY-120', name: 'Magnesium Glycinate 120ct', unitCogsCents: 1450, available: 50, active: true }
]

const line = {
  id: 'l1',
  position: 1,
  sku: 'MAG-GLY-120',
  name: 'Magnesium Glycinate 120ct',
  qty: 2,
  unitPriceCents: 2999,
  unitCogsCents: 1450,
  lineTotalCents: 5998,
  lineCogsCents: 2900,
  lineFeeCents: 45,
  lineMarginCents: 3053
}

describe('AddLineForm - price read-only, margin editable, demo-badged', () => {
  it('shows the price read-only (an output, not an input) and has no mode radios', () => {
    const wrapper = mount(AddLineForm, { props: { products, busy: false, error: null } })
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(0)
    // The only text input is the margin input - there is no price input to type into.
    expect(wrapper.findAll('input[type="text"]')).toHaveLength(1)
    expect(wrapper.find('[data-test="margin-input"]').exists()).toBe(true)
    const price = wrapper.find('[data-test="unit-price"]')
    expect(price.exists()).toBe(true)
    expect(price.element.tagName).toBe('OUTPUT') // read-only, never an <input>
  })

  it('displays the seeded catalog price once a SKU is chosen', async () => {
    const wrapper = mount(AddLineForm, { props: { products, busy: false, error: null } })
    await wrapper.find('select').setValue('MAG-GLY-120')
    expect(wrapper.find('[data-test="unit-price"]').text()).toBe('$29.99') // formatCents(2999)
  })

  it('degrades to a neutral pending state when the catalog price field is absent', async () => {
    const wrapper = mount(AddLineForm, { props: { products: productsNoPrice, busy: false, error: null } })
    await wrapper.find('select').setValue('MAG-GLY-120')
    expect(wrapper.find('[data-test="unit-price"]').text()).toContain('pending')
  })

  it('carries DemoBadge markers (margin control + COGS in the product list)', () => {
    const wrapper = mount(AddLineForm, { props: { products, busy: false, error: null } })
    // Two demo badges: the COGS-in-list marker and the margin-control marker.
    expect(wrapper.findAll('.demo-badge').length).toBeGreaterThanOrEqual(2)
  })

  it('sends the catalog price (not typed) when no margin is entered', async () => {
    const wrapper = mount(AddLineForm, { props: { products, busy: false, error: null } })
    await wrapper.find('select').setValue('MAG-GLY-120')
    await wrapper.find('form').trigger('submit.prevent')
    const payload = (wrapper.emitted('add') as unknown[][])[0][0] as Record<string, unknown>
    expect(payload).toMatchObject({ sku: 'MAG-GLY-120', qty: 1, unitPriceCents: 2999 })
    expect(payload).not.toHaveProperty('marginBps')
  })

  it('a margin % overrides the catalog price: emits marginBps, never unitPriceCents', async () => {
    const wrapper = mount(AddLineForm, { props: { products, busy: false, error: null } })
    await wrapper.find('select').setValue('MAG-GLY-120')
    await wrapper.find('[data-test="margin-input"]').setValue('50')
    await wrapper.find('form').trigger('submit.prevent')
    const payload = (wrapper.emitted('add') as unknown[][])[0][0] as Record<string, unknown>
    expect(payload).toMatchObject({ sku: 'MAG-GLY-120', qty: 1, marginBps: 5000 })
    expect(payload).not.toHaveProperty('unitPriceCents')
  })
})

describe('LineRow - quantity-only update, COGS badged', () => {
  it('shows quantity + Update line + Remove, and no price/margin editing', () => {
    const wrapper = mount(LineRow, { props: { line, busy: false, error: null } })
    expect(wrapper.find('[data-test="qty-input"]').exists()).toBe(true)
    // No radios, and the only editable input in the row is the quantity field.
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(0)
    expect(wrapper.findAll('input[type="text"]')).toHaveLength(0)
    const buttons = wrapper.findAll('button').map((b) => b.text())
    expect(buttons).toContain('Update line')
    expect(buttons).toContain('Remove')
  })

  it('badges the COGS figure but not the line total or net margin', () => {
    const wrapper = mount(LineRow, { props: { line, busy: false, error: null } })
    expect(wrapper.find('.demo-badge').exists()).toBe(true)
    // Exactly one badge in the row: the COGS figure.
    expect(wrapper.findAll('.demo-badge')).toHaveLength(1)
  })

  it('emits commit with qty only', async () => {
    const wrapper = mount(LineRow, { props: { line, busy: false, error: null } })
    await wrapper.find('[data-test="qty-input"]').setValue(5)
    await wrapper.findAll('button').find((b) => b.text() === 'Update line')!.trigger('click')
    const emitted = wrapper.emitted('commit')
    expect(emitted).toBeTruthy()
    const payload = (emitted as unknown[][])[0][0] as Record<string, unknown>
    expect(payload).toEqual({ qty: 5 })
  })
})
