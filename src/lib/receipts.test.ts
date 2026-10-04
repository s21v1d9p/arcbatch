import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, pad, toEventSelector } from 'viem'
import { parsePaidReceipt, RevertedPaymentError } from './receipts'

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
