// Light tests for the provider order UI's display/alert logic (T6).
//
// Components render money and alerts through these pure helpers, so testing them
// covers the "quote rendering" and "error alert" acceptance criteria without pulling
// in a DOM test harness (@vue/test-utils) - a new devDependency the scope guardrails
// (AGENTS.md section 10) tell us to avoid. The rendering components stay thin wrappers
// over these functions.
import { describe, it, expect } from 'vitest'
import {
  formatCents,
  centsToPlain,
  dollarsToCents,
  insufficientStockMessage,
  marginPercentToBps
} from './format'

describe('formatCents', () => {
  it('formats whole and fractional dollars from integer cents', () => {
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(64)).toBe('$0.64')
    expect(formatCents(2999)).toBe('$29.99')
    expect(formatCents(8497)).toBe('$84.97')
  })

  it('pads single-digit cents and groups thousands', () => {
    expect(formatCents(100)).toBe('$1.00')
    expect(formatCents(105)).toBe('$1.05')
    expect(formatCents(123456)).toBe('$1,234.56')
  })

  it('renders negative amounts with a leading minus', () => {
    expect(formatCents(-64)).toBe('-$0.64')
    expect(formatCents(-8497)).toBe('-$84.97')
  })

  it('renders a dash for non-finite input instead of throwing', () => {
    expect(formatCents(Number.NaN)).toBe('-')
    expect(formatCents(Number.POSITIVE_INFINITY)).toBe('-')
  })
})

describe('centsToPlain', () => {
  it('renders a plain editable amount with no symbol or grouping', () => {
    expect(centsToPlain(2999)).toBe('29.99')
    expect(centsToPlain(3000)).toBe('30.00')
    expect(centsToPlain(5)).toBe('0.05')
    expect(centsToPlain(123456)).toBe('1234.56')
  })
})

describe('dollarsToCents', () => {
  it('parses dollar strings into integer cents without float math', () => {
    expect(dollarsToCents('29.99')).toBe(2999)
    expect(dollarsToCents('30')).toBe(3000)
    expect(dollarsToCents('0.05')).toBe(5)
    expect(dollarsToCents('$84.97')).toBe(8497)
    expect(dollarsToCents('1.5')).toBe(150)
  })

  it('rejects malformed or negative amounts', () => {
    expect(dollarsToCents('')).toBeNull()
    expect(dollarsToCents('abc')).toBeNull()
    expect(dollarsToCents('-5')).toBeNull()
    expect(dollarsToCents('1.999')).toBeNull()
  })
})

describe('insufficientStockMessage', () => {
  it('matches the exact FR-3 AC2 / EVAL-05 copy', () => {
    expect(insufficientStockMessage(5)).toBe(
      'On-hand stock cannot meet this quantity (available: 5). Wait for restock or reduce quantity.'
    )
    expect(insufficientStockMessage(0)).toBe(
      'On-hand stock cannot meet this quantity (available: 0). Wait for restock or reduce quantity.'
    )
  })
})

describe('marginPercentToBps', () => {
  it('converts whole percents to basis points', () => {
    expect(marginPercentToBps('50')).toBe(5000)
    expect(marginPercentToBps('0')).toBe(0)
    expect(marginPercentToBps('95')).toBe(9500)
  })

  it('converts fractional percents without float math', () => {
    expect(marginPercentToBps('37.5')).toBe(3750)
    expect(marginPercentToBps('37.52')).toBe(3752)
    expect(marginPercentToBps('0.01')).toBe(1)
  })

  it('rejects malformed input', () => {
    expect(marginPercentToBps('')).toBeNull()
    expect(marginPercentToBps('abc')).toBeNull()
    expect(marginPercentToBps('-5')).toBeNull()
    expect(marginPercentToBps('1.234')).toBeNull()
  })
})
