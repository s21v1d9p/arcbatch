import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, pad, toEventSelector } from 'viem'
import { parsePaidReceipt, parsePaidRuns, payerOf, RevertedPaymentError } from './receipts'

const contract = '0x3333333333333333333333333333333333333333' as const
const sender = '0x1111111111111111111111111111111111111111' as const
const recipient = '0x2222222222222222222222222222222222222222' as const
const abi = [
  {
    type: 'event',
    name: 'Paid',
    inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'index', type: 'uint256', indexed: false },
    ],
  },
] as const
const paidLog = {
  address: contract,
  topics: [toEventSelector(abi[0]), pad(sender), pad(recipient)] as [
    `0x${string}`,
    `0x${string}`,
    `0x${string}`,
  ],
  data: encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }],
    [1_000_000_000_000_000_000n, 0n],
  ),
}

describe('parsePaidReceipt', () => {
  it('reads actual payment events from the configured contract and sender', () => {
    expect(
      parsePaidReceipt(
        { status: 'success', logs: [{ ...paidLog, address: sender }, paidLog] },
        contract,
        sender,
      ),
    ).toEqual([{ recipient, amount: 1_000_000_000_000_000_000n, index: 0 }])
  })

  it('never calls a reverted, empty, or unrelated transaction paid', () => {
    expect(RevertedPaymentError).toBeTypeOf('function')
    expect(() => parsePaidReceipt({ status: 'reverted', logs: [paidLog] }, contract, sender)).toThrow(
      RevertedPaymentError,
    )
    expect(() => parsePaidReceipt({ status: 'success', logs: [] }, contract, sender)).toThrow(
      'No payout events',
    )
    expect(() => parsePaidReceipt({ status: 'success', logs: [paidLog] }, sender, sender)).toThrow(
      'No payout events',
    )
  })
})

describe('payerOf and parsePaidRuns', () => {
  const safe = '0x4444444444444444444444444444444444444444' as const
  const reenterer = '0x5555555555555555555555555555555555555555' as const
  const owner = '0x6666666666666666666666666666666666666666' as const
  const one = 1_000_000_000_000_000_000n

  function paid(from: `0x${string}`, index: bigint, amount = one) {
    return {
      ...paidLog,
      topics: [paidLog.topics[0], pad(from), pad(recipient)] as typeof paidLog.topics,
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [amount, index]),
    }
  }

  it('uses the transaction sender for a direct payout, even when a recipient contract re-enters pay()', () => {
    const receipt = {
      status: 'success' as const,
      from: sender,
      to: contract,
      logs: [paid(sender, 0n), paid(reenterer, 0n), paid(sender, 1n)],
    }
    expect(payerOf(receipt, contract)).toBe(sender)
    expect(parsePaidRuns(receipt, contract, sender)).toEqual([
      [
        { recipient, amount: one, index: 0 },
        { recipient, amount: one, index: 1 },
      ],
    ])
  })

  it('accepts a single payer when a Safe executed the payout, and never guesses between several', () => {
    const bulk = {
      status: 'success' as const,
      from: owner,
      to: safe,
      logs: [paid(safe, 0n), paid(safe, 1n), paid(safe, 0n)],
    }
    expect(payerOf(bulk, contract)).toBe(safe)

    // Whoever executes a signed Safe transaction can add a payout of their own to it.
    const mixed = {
      status: 'success' as const,
      from: owner,
      to: reenterer,
      logs: [paid(safe, 0n), paid(safe, 1n), paid(reenterer, 0n, 1n)],
    }
    expect(() => payerOf(mixed, contract)).toThrow('more than one sender')
    expect(payerOf(mixed, contract, safe)).toBe(safe)
    expect(parsePaidRuns(mixed, contract, safe)).toHaveLength(1)
  })

  it('splits several payouts from one payer in the same transaction', () => {
    const receipt = {
      status: 'success' as const,
      from: owner,
      to: safe,
      logs: [paid(safe, 0n), paid(safe, 1n), paid(safe, 0n, 2n)],
    }
    expect(parsePaidRuns(receipt, contract, safe)).toEqual([
      [
        { recipient, amount: one, index: 0 },
        { recipient, amount: one, index: 1 },
      ],
      [{ recipient, amount: 2n, index: 0 }],
    ])
    expect(() => parsePaidReceipt(receipt, contract, safe)).toThrow('more than one payout')
  })

  it('rejects receipts without payouts, events out of order and reverted transactions', () => {
    expect(() => payerOf({ status: 'success', from: owner, to: safe, logs: [] }, contract)).toThrow(
      'No payout events',
    )
    expect(() => payerOf({ status: 'reverted', from: sender, to: contract, logs: [] }, contract)).toThrow(
      RevertedPaymentError,
    )
    expect(() =>
      parsePaidRuns({ status: 'success', logs: [paid(sender, 1n)] }, contract, sender),
    ).toThrow('inconsistent')
  })
})
