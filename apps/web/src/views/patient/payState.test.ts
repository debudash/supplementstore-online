// Tests for the patient pay page's pure state/copy logic (T7, FR-5 AC1-AC3).
import { describe, it, expect } from 'vitest'
import {
  phaseForStatus,
  phaseForPayError,
  titleForPhase,
  messageForPhase,
  DECLINE_NOTICE,
  type PayPhase
} from './payState'

describe('phaseForStatus', () => {
  it('maps a sent order to payable', () => {
    expect(phaseForStatus('sent')).toBe('payable')
  })

  it('maps a paid order to alreadyPaid (no fresh receipt to show)', () => {
    expect(phaseForStatus('paid')).toBe('alreadyPaid')
  })

  it('maps expired, cancelled, and refunded to their own phases', () => {
    expect(phaseForStatus('expired')).toBe('expired')
    expect(phaseForStatus('cancelled')).toBe('cancelled')
    expect(phaseForStatus('refunded')).toBe('refunded')
  })

  it('maps non-payable in-progress statuses to unavailable', () => {
    expect(phaseForStatus('draft')).toBe('unavailable')
    expect(phaseForStatus('on_hold')).toBe('unavailable')
  })
})

describe('phaseForPayError', () => {
  it('advances to the matching terminal phase', () => {
    expect(phaseForPayError('ALREADY_PAID')).toBe('alreadyPaid')
    expect(phaseForPayError('ORDER_EXPIRED')).toBe('expired')
    expect(phaseForPayError('ORDER_NOT_PAYABLE')).toBe('unavailable')
  })

  it('falls back to error for unexpected codes', () => {
    expect(phaseForPayError('IDEMPOTENCY_CONFLICT')).toBe('error')
    expect(phaseForPayError('INVALID_INPUT')).toBe('error')
    expect(phaseForPayError('WHATEVER')).toBe('error')
  })
})

describe('patient-facing copy', () => {
  const PHASES: PayPhase[] = [
    'loading',
    'payable',
    'paid',
    'alreadyPaid',
    'expired',
    'cancelled',
    'refunded',
    'unavailable',
    'notFound',
    'error'
  ]

  it('has a non-empty title for every phase', () => {
    for (const p of PHASES) expect(titleForPhase(p).length).toBeGreaterThan(0)
  })

  it('never leaks economics (cogs, margin, fee) in any message', () => {
    const texts = [...PHASES.map(messageForPhase), DECLINE_NOTICE, ...PHASES.map(titleForPhase)]
    for (const t of texts) {
      expect(t.toLowerCase()).not.toMatch(/\b(cogs|margin|fee)\b/)
    }
  })

  it('uses single hyphens, never an em or en dash, in copy', () => {
    const texts = [...PHASES.map(messageForPhase), DECLINE_NOTICE, ...PHASES.map(titleForPhase)]
    for (const t of texts) {
      expect(t).not.toMatch(/[–—]/)
    }
  })

  it('surfaces the ADR-023 keep-or-dispose guidance on refund (no returns)', () => {
    const msg = messageForPhase('refunded').toLowerCase()
    expect(msg).toContain('refunded in full')
    expect(msg).toMatch(/keep or safely dispose/)
    expect(msg).toContain('no returns')
  })
})
