// @vitest-environment happy-dom
//
// Render + interaction tests for the New Order controls:
//  - price is never typed: the provider enters a per-unit dollar MARKUP (ADR-028);
//  - the markup is required, validated, and sent as integer cents;
//  - COGS is badged; a SKU already on the order is HIDDEN from the Add dropdown;
//  - the item row is QUANTITY ONLY, its action is "Update Item", and COGS is badged.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AddLineForm from './AddLineForm.vue'
import LineRow from './LineRow.vue'

const products = [
  { sku: 'MAG-GLY-120', name: 'Magnesium Glycinate 120ct', unitCogsCents: 1450, available: 50, active: true },
  { sku: 'VITD3-K2', name: 'Vitamin D3 + K2', unitCogsCents: 1125, available: 40, active: true }
]

const line = {
  id: 'l1',
  position: 1,
  sku: 'MAG-GLY-120',
  name: 'Magnesium Glycinate 120ct',
  qty: 2,
  unitPriceCents: 2999,
  unitCogsCents: 1450,
  unitMarkupCents: 1526,
  lineTotalCents: 5998,
  lineCogsCents: 2900,
  lineFeeCents: 45,
  lineMarginCents: 3053
}

describe('AddLineForm - markup entry (ADR-028)', () => {
  it('has one text input, the markup, and no price input or mode radios', () => {
    const wrapper = mount(AddLineForm, { props: { products, busy: false, error: null } })
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(0)
    expect(wrapper.findAll('input[type="text"]')).toHaveLength(1)
    expect(wrapper.find('[data-test="markup-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="unit-price"]').exists()).toBe(false)
  })

  it('carries the COGS DemoBadge in the product detail', () => {
    const wrapper = mount(AddLineForm, { props: { products, busy: false, error: null } })
    expect(wrapper.findAll('.demo-badge').length).toBeGreaterThanOrEqual(1)
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

  it('requires a markup: no emit and an error when it is blank', async () => {
    const wrapper = mount(AddLineForm, { props: { products, busy: false, error: null } })
    await wrapper.find('select').setValue('MAG-GLY-120')
    await wrapper.find('form').trigger('submit.prevent')
    expect(wrapper.emitted('add')).toBeUndefined()
    expect(wrapper.text()).toContain('Enter your markup per unit in dollars')
  })

  it.each([['-1'], ['10.555'], ['abc'], ['1000.01']])('rejects markup %s', async (value) => {
    const wrapper = mount(AddLineForm, { props: { products, busy: false, error: null } })
    await wrapper.find('select').setValue('MAG-GLY-120')
    await wrapper.find('[data-test="markup-input"]').setValue(value)
    await wrapper.find('form').trigger('submit.prevent')
    expect(wrapper.emitted('add')).toBeUndefined()
  })

  it('emits the markup in integer cents (no float math), never a price or margin %', async () => {
    const wrapper = mount(AddLineForm, { props: { products, busy: false, error: null } })
    await wrapper.find('select').setValue('MAG-GLY-120')
    await wrapper.find('[data-test="markup-input"]').setValue('12.50')
    await wrapper.find('form').trigger('submit.prevent')
    const payload = (wrapper.emitted('add') as unknown[][])[0][0] as Record<string, unknown>
    expect(payload).toEqual({ sku: 'MAG-GLY-120', qty: 1, markupCents: 1250 })
  })

  it('accepts a $0 markup (sell at cost + fee)', async () => {
    const wrapper = mount(AddLineForm, { props: { products, busy: false, error: null } })
    await wrapper.find('select').setValue('MAG-GLY-120')
    await wrapper.find('[data-test="markup-input"]').setValue('0')
    await wrapper.find('form').trigger('submit.prevent')
    expect((wrapper.emitted('add') as unknown[][])[0][0]).toEqual({ sku: 'MAG-GLY-120', qty: 1, markupCents: 0 })
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
  it('shows quantity + Update Item + Remove, and no open price/markup editor', () => {
    const wrapper = mountRow()
    expect(wrapper.find('[data-test="qty-input"]').exists()).toBe(true)
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(0)
    // Only the quantity number input is editable until "Change markup" is opened.
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

  it('shows the markup included in the unit price', () => {
    expect(mountRow().find('[data-test="line-markup"]').text()).toBe('incl. your $15.26')
  })

  it('opens the markup editor seeded with the current markup and emits it in cents', async () => {
    const wrapper = mountRow()
    await wrapper.find('[data-testid="change-markup"]').trigger('click')
    const input = wrapper.find('[data-testid="line-markup-input"]')
    expect((input.element as HTMLInputElement).value).toBe('15.26')
    await input.setValue('20')
    await wrapper.find('form').trigger('submit')
    expect((wrapper.emitted('markup') as unknown[][])[0][0]).toEqual({ markupCents: 2000 })
  })

  it('emits commit with qty only', async () => {
    const wrapper = mountRow()
    await wrapper.find('[data-test="qty-input"]').setValue(5)
    await wrapper.findAll('button').find((b) => b.text() === 'Update Item')!.trigger('click')
    const payload = (wrapper.emitted('commit') as unknown[][])[0][0] as Record<string, unknown>
    expect(payload).toEqual({ qty: 5 })
  })
})
