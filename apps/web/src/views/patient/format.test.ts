// Tests for the patient pay page's money display helper (T7).
import { describe, it, expect } from 'vitest'
import { formatCents } from './format'

describe('formatCents (patient)', () => {
  it('formats integer cents as dollars', () => {
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(5)).toBe('$0.05')
    expect(formatCents(100)).toBe('$1.00')
    expect(formatCents(2999)).toBe('$29.99')
    expect(formatCents(8497)).toBe('$84.97')
  })

  it('groups thousands', () => {
    expect(formatCents(123456)).toBe('$1,234.56')
  })

  it('renders a dash for non-finite input instead of throwing', () => {
    expect(formatCents(Number.NaN)).toBe('-')
    expect(formatCents(Number.POSITIVE_INFINITY)).toBe('-')
  })
})
