// @vitest-environment happy-dom
//
// Behaviour tests for the shared UI components that carry logic: the quantity stepper
// clamps, the confirm dialog gates and emits correctly, Money marks negatives, and the
// tabs follow the keyboard pattern.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import QuantityStepper from './QuantityStepper.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import Money from './Money.vue'
import UiTabs from './UiTabs.vue'
import StatusChip from './StatusChip.vue'

describe('QuantityStepper', () => {
  it('increments and decrements within min/max', async () => {
    const w = mount(QuantityStepper, { props: { modelValue: 2, min: 1, max: 3, label: 'Quantity' } })
    await w.find('[data-testid="qty-inc"]').trigger('click')
    expect(w.emitted('update:modelValue')![0]).toEqual([3])
    await w.setProps({ modelValue: 3 })
    expect(w.find('[data-testid="qty-inc"]').attributes('disabled')).toBeDefined()
    await w.setProps({ modelValue: 1 })
    expect(w.find('[data-testid="qty-dec"]').attributes('disabled')).toBeDefined()
  })

  it('labels its controls and forwards the test id to the number input', () => {
    const w = mount(QuantityStepper, { props: { modelValue: 2, label: 'Quantity', inputTestId: 'qty-input' } })
    const input = w.find('[data-test="qty-input"]')
    expect(input.attributes('type')).toBe('number')
    expect(input.attributes('aria-label')).toBe('Quantity')
    expect(w.find('[data-testid="qty-dec"]').attributes('aria-label')).toBe('Decrease Quantity')
  })
})

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    const w = mount(ConfirmDialog, { props: { open: false, title: 'Refund?', confirmLabel: 'Refund' } })
    expect(w.find('[role="dialog"]').exists()).toBe(false)
  })

  it('emits confirm and cancel, and Escape cancels', async () => {
    const w = mount(ConfirmDialog, { props: { open: true, title: 'Send?', confirmLabel: 'Send' }, slots: { default: 'Body' } })
    expect(w.find('[role="dialog"]').attributes('aria-modal')).toBe('true')
    await w.find('[data-testid="confirm-ok"]').trigger('click')
    await w.find('[data-testid="confirm-cancel"]').trigger('click')
    await w.find('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('confirm')).toHaveLength(1)
    expect(w.emitted('cancel')).toHaveLength(2)
  })

  it('keeps confirm disabled until the required word is typed', async () => {
    const w = mount(ConfirmDialog, { props: { open: true, title: 'Reset?', confirmLabel: 'Reset', tone: 'danger', requireText: 'RESET' } })
    expect(w.find('[data-testid="confirm-ok"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="confirm-require-input"]').setValue('RESET')
    expect(w.find('[data-testid="confirm-ok"]').attributes('disabled')).toBeUndefined()
  })
})

describe('Money', () => {
  it('formats and marks negatives with colour and a minus sign', () => {
    const neg = mount(Money, { props: { cents: -64 } })
    expect(neg.text()).toBe('-$0.64')
    expect(neg.classes()).toContain('money-negative')
    const pos = mount(Money, { props: { cents: 2999 } })
    expect(pos.text()).toBe('$29.99')
    expect(pos.classes()).not.toContain('money-negative')
  })
})

describe('StatusChip', () => {
  it('shows a human label', () => {
    expect(mount(StatusChip, { props: { status: 'on_hold' } }).text()).toBe('On hold')
    expect(mount(StatusChip, { props: { status: 'paid' } }).classes()).toContain('badge-success')
  })
})

describe('UiTabs', () => {
  it('moves selection with the arrow keys and shows only the active panel', async () => {
    const tabs = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' }
    ]
    const w = mount(UiTabs, { props: { tabs, modelValue: 'a' }, slots: { a: 'Panel A', b: 'Panel B' } })
    expect(w.text()).toContain('Panel A')
    expect(w.text()).not.toContain('Panel B')
    await w.find('[data-testid="tab-a"]').trigger('keydown', { key: 'ArrowRight' })
    expect(w.emitted('update:modelValue')![0]).toEqual(['b'])
  })
})
