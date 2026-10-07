// @vitest-environment happy-dom
//
// Render + interaction tests for the New Order controls:
//  - price is SHOWN READ-ONLY in "Add item" (no price input);
//  - margin % editable + DemoBadge; COGS badged; margin overrides catalog, else catalog;
//  - a SKU already on the order is HIDDEN from the Add dropdown (owner UX);
//  - the item row is QUANTITY ONLY, its action is "Update Item", and COGS is badged.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AddLineForm from './AddLineForm.vue'
import LineRow from './LineRow.vue'

// The seeded catalog list price (ProductView.listPriceCents) is a required field.
const products = [
  { sku: 'MAG-GLY-120', name: 'Magnesium Glycinate 120ct', unitCogsCents: 1450, available: 50, active: true, listPriceCents: 2999 },
  { sku: 'VITD3-K2', name: 'Vitamin D3 + K2', unitCogsCents: 1125, available: 40, active: true, listPriceCents: 2499 }
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

  it('carries DemoBadge markers (margin control + COGS in the product list)', () => {
    const wrapper = mount(AddLineForm, { props: { products, busy: false, error: null } })
    // Two demo badges: the COGS-in-list marker and the margin-control marker.
    expect(wrapper.findAll('.demo-badge').length).toBeGreaterThanOrEqual(2)
  })

  it('hides a SKU already on the order from the dropdown; others remain', () => {
    const wrapper = mount(AddLineForm, {
      props: { products, busy: false, error: null, onOrder: { 'MAG-GLY-120': 3 } }
    })
    const optionValues = wrapper.findAll('option').map((o) => o.attributes('value'))
    expect(optionValues).not.toContain('MAG-GLY-120') // already on the order -> hidden
    expect(optionValues).toContain('VITD3-K2') // not on the order -> still addable
  })

  it('brings a SKU back when it is no longer on the order', async () => {
    const wrapper = mount(AddLineForm, {
      props: { products, busy: false, error: null, onOrder: { 'MAG-GLY-120': 3 } }
    })
    expect(wrapper.findAll('option').map((o) => o.attributes('value'))).not.toContain('MAG-GLY-120')
    await wrapper.setProps({ onOrder: {} }) // item removed from the order
    expect(wrapper.findAll('option').map((o) => o.attributes('value'))).toContain('MAG-GLY-120')
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

/** Mount a LineRow inside a table so its <tr>/<td> render in a valid context. */
function mountRow() {
  return mount(LineRow, {
    props: { line, busy: false, error: null },
    attrs: {},
    global: {},
    // Provide a table ancestor via a wrapper element.
    attachTo: document.createElement('tbody')
  })
}

describe('LineRow - quantity-only item row, "Update Item", COGS badged', () => {
  it('shows quantity + Update Item + Remove, and no price/margin editing', () => {
    const wrapper = mountRow()
    expect(wrapper.find('[data-test="qty-input"]').exists()).toBe(true)
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(0)
    // Only the quantity number input is editable; no text (price/margin) inputs.
    expect(wrapper.findAll('input[type="text"]')).toHaveLength(0)
    const buttons = wrapper.findAll('button').map((b) => b.text())
    expect(buttons).toContain('Update Item')
    expect(buttons).toContain('Remove')
  })

  it('renders as table cells with the per-line figures', () => {
    const wrapper = mountRow()
    expect(wrapper.find('tr').exists()).toBe(true)
    expect(wrapper.find('[data-test="line-total"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="line-cogs"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="line-margin"]').exists()).toBe(true)
  })

  it('badges the COGS figure only (not line total, fee or net margin)', () => {
    const wrapper = mountRow()
    expect(wrapper.findAll('.demo-badge')).toHaveLength(1)
  })

  it('emits commit with qty only', async () => {
    const wrapper = mountRow()
    await wrapper.find('[data-test="qty-input"]').setValue(5)
    await wrapper.findAll('button').find((b) => b.text() === 'Update Item')!.trigger('click')
    const payload = (wrapper.emitted('commit') as unknown[][])[0][0] as Record<string, unknown>
    expect(payload).toEqual({ qty: 5 })
  })
})
