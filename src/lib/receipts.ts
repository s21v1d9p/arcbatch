import { decodeEventLog, encodeEventTopics, getAddress, parseAbi } from 'viem'
import type { Address, Hex } from 'viem'

export const batchAbi = parseAbi([
  'function pay(address[] recipients, uint256[] amounts) payable',
  'event Paid(address indexed sender, address indexed recipient, uint256 amount, uint256 index)',
])

const paidTopic = encodeEventTopics({ abi: batchAbi, eventName: 'Paid' })[0]

type PaymentLog = { address: Address; data: Hex; topics: [] | [Hex, ...Hex[]] }
type PaymentReceipt = { status: 'success' | 'reverted'; logs: readonly PaymentLog[] }
export type ConfirmedPayment = { recipient: Address; amount: bigint; index: number }

export class RevertedPaymentError extends Error {
  constructor() {
    super('Transaction reverted; no one was paid')
    this.name = 'RevertedPaymentError'
  }
}

export function parsePaidReceipt(
  receipt: PaymentReceipt,
  contract: Address,
  sender: Address,
): ConfirmedPayment[] {
  if (receipt.status !== 'success') throw new RevertedPaymentError()

  const payments: ConfirmedPayment[] = []
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase() || log.topics[0] !== paidTopic) {
      continue
    }
    const event = decodeEventLog({ abi: batchAbi, topics: log.topics, data: log.data })
    if (event.args.sender.toLowerCase() !== sender.toLowerCase()) continue
    if (event.args.amount <= 0n || event.args.index !== BigInt(payments.length)) {
      throw new Error('ArcBatch receipt contains inconsistent payment events')
    }
    payments.push({
      recipient: getAddress(event.args.recipient),
      amount: event.args.amount,
      index: payments.length,
    })
  }
  if (payments.length === 0) throw new Error('No ArcBatch payments found in this transaction')
  return payments
}
