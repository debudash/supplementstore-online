import { describe, it, expect } from 'vitest'
import { formatMoney, isNegative, formatBps } from './money'

describe('formatMoney', () => {
  it('formats integer cents as USD via Intl', () => {
    expect(formatMoney(0)).toBe('$0.00')
    expect(formatMoney(5)).toBe('$0.05')
    expect(formatMoney(2999)).toBe('$29.99')
    expect(formatMoney(123456)).toBe('$1,234.56')
    expect(formatMoney(100000000)).toBe('$1,000,000.00')
  })

  it('marks negatives with a leading minus', () => {
    expect(formatMoney(-64)).toBe('-$0.64')
    expect(formatMoney(-8497)).toBe('-$84.97')
  })

  it('is exact for values that are not representable as binary floats in dollars', () => {
    expect(formatMoney(1)).toBe('$0.01')
    expect(formatMoney(10)).toBe('$0.10')
    expect(formatMoney(110)).toBe('$1.10')
    expect(formatMoney(Number.MAX_SAFE_INTEGER)).toBe('$90,071,992,547,409.91')
  })

  it('renders a dash for missing or non-finite input', () => {
    expect(formatMoney(null)).toBe('-')
    expect(formatMoney(undefined)).toBe('-')
    expect(formatMoney(Number.NaN)).toBe('-')
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe('-')
  })
})

describe('isNegative', () => {
  it('is true only for finite negative numbers', () => {
    expect(isNegative(-1)).toBe(true)
    expect(isNegative(0)).toBe(false)
    expect(isNegative(null)).toBe(false)
  })
})

describe('formatBps', () => {
  it('formats basis points as a percent label', () => {
    expect(formatBps(7500)).toBe('75%')
    expect(formatBps(75)).toBe('0.75%')
    expect(formatBps(3750)).toBe('37.5%')
    expect(formatBps(5165)).toBe('51.65%')
    expect(formatBps(null)).toBe('-')
  })
})
