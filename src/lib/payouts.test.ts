import { describe, expect, it } from 'vitest'
import { parseCsvRows, validatePayouts } from './payouts'

const alice = '0x1111111111111111111111111111111111111111'
const bob = '0x2222222222222222222222222222222222222222'

describe('parseCsvRows', () => {
  it('accepts a header, CRLF, quotes, whitespace, and trailing empty lines', () => {
    expect(parseCsvRows(`address,amount\r\n "${alice}", "1.25" \r\n${bob},0.000001\r\n`)).toEqual([
      { address: alice, amount: '1.25' },
      { address: bob, amount: '0.000001' },
    ])
  })

  it('accepts two-column rows without a header', () => {
    expect(parseCsvRows(`${alice},2`)).toEqual([{ address: alice, amount: '2' }])
  })

  it('allows blank lines before the optional header without treating it as a recipient', () => {
    expect(parseCsvRows(`\naddress,amount\n${alice},1\n`)).toEqual([
      { address: alice, amount: '1' },
    ])
  })

  it('reports malformed input with its line number', () => {
    expect(() => parseCsvRows(`address,amount\n${alice},1,extra`)).toThrow('Line 2')
    expect(() => parseCsvRows(`address,amount\n"${alice},1`)).toThrow('Line 2')
    expect(() => parseCsvRows('')).toThrow('at least one')
  })
})

describe('validatePayouts', () => {
  it('converts six-decimal USDC amounts to exact native 18-decimal units', () => {
    const batch = validatePayouts([
      { address: alice, amount: '1.25' },
      { address: bob, amount: '0.000001' },
    ])
    expect(batch.total).toBe(1_250_001_000_000_000_000n)
    expect(batch.payouts.map((payout) => payout.units)).toEqual([
      1_250_000_000_000_000_000n,
      1_000_000_000_000n,
    ])
  })

  it('rejects repeated addresses regardless of case', () => {
    expect(() =>
      validatePayouts([
        { address: alice, amount: '1' },
        { address: alice.toUpperCase().replace('0X', '0x'), amount: '1' },
      ]),
    ).toThrow('Row 2: duplicate')
  })

  it.each(['0', '-1', '0.0000001', '1e3', '1.'])('rejects invalid amount %s', (amount) => {
    expect(() => validatePayouts([{ address: alice, amount }])).toThrow('Row 1: amount')
  })

  it('rejects invalid or dangerous recipients and more than 25 recipients', () => {
    expect(() => validatePayouts([{ address: 'not an address', amount: '1' }])).toThrow(
      'Row 1: address',
    )
    expect(() => validatePayouts([{ address: alice, amount: '1' }], alice)).toThrow(
      'Row 1: recipient is the payout contract',
    )
    expect(() => validatePayouts(Array(26).fill({ address: alice, amount: '1' }))).toThrow(
      '25 recipients',
    )
  })

  it('rejects amounts too large for a Solidity uint256 rather than signing them', () => {
    expect(() => validatePayouts([{ address: alice, amount: '9'.repeat(80) }])).toThrow(
      'exceeds valid USDC range',
    )
  })
})
