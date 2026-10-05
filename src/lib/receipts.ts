import { decodeEventLog, encodeEventTopics, getAddress, parseAbi } from 'viem'
import type { Address, Hex } from 'viem'

export const batchAbi = parseAbi([
  'function pay(address[] recipients, uint256[] amounts) payable',
  'event Paid(address indexed sender, address indexed recipient, uint256 amount, uint256 index)',
])

const paidTopic = encodeEventTopics({ abi: batchAbi, eventName: 'Paid' })[0]

type PaymentLog = { address: Address; data: Hex; topics: [] | [Hex, ...Hex[]] }
type PaymentReceipt = { status: 'success' | 'reverted'; logs: readonly PaymentLog[] }
type PayerReceipt = PaymentReceipt & { from: Address; to: Address | null }
export type ConfirmedPayment = { recipient: Address; amount: bigint; index: number }

export class RevertedPaymentError extends Error {
  constructor() {
    super('Transaction reverted; no one was paid')
    this.name = 'RevertedPaymentError'
  }
}

function paidEvents(receipt: PaymentReceipt, contract: Address) {
  return receipt.logs
    .filter((log) => log.address.toLowerCase() === contract.toLowerCase() && log.topics[0] === paidTopic)
    .map((log) => decodeEventLog({ abi: batchAbi, eventName: 'Paid', topics: log.topics, data: log.data }).args)
}

// A direct call to the contract was paid by the transaction sender. Anything else (a Safe, or a contract
// that also adds payouts of its own) needs the payer named, unless only one sender paid in it.
export function payerOf(receipt: PayerReceipt, contract: Address, named?: Address): Address {
  if (receipt.status !== 'success') throw new RevertedPaymentError()
  if (named) return getAddress(named)
  if (receipt.to?.toLowerCase() === contract.toLowerCase()) return getAddress(receipt.from)
  const senders = new Set(paidEvents(receipt, contract).map((event) => event.sender.toLowerCase()))
  if (senders.size === 0) throw new Error('No payout events found in this transaction')
  if (senders.size > 1) {
    throw new Error('This transaction has payouts from more than one sender. Open the receipt link that names the payer.')
  }
  return getAddress([...senders][0])
}

// One transaction can hold several payouts from the same payer, for example when a Safe executes
// queued transactions together. Each payout starts again at index 0.
export function parsePaidRuns(
  receipt: PaymentReceipt,
  contract: Address,
  sender: Address,
): ConfirmedPayment[][] {
  if (receipt.status !== 'success') throw new RevertedPaymentError()

  const runs: ConfirmedPayment[][] = []
  for (const event of paidEvents(receipt, contract)) {
    if (event.sender.toLowerCase() !== sender.toLowerCase()) continue
    if (event.index === 0n) runs.push([])
    const run = runs.at(-1)
    if (!run || event.amount <= 0n || event.index !== BigInt(run.length)) {
      throw new Error('Receipt contains inconsistent payment events')
    }
    run.push({ recipient: getAddress(event.recipient), amount: event.amount, index: run.length })
  }
  if (runs.length === 0) throw new Error('No payout events found in this transaction')
  return runs
}

export function parsePaidReceipt(
  receipt: PaymentReceipt,
  contract: Address,
  sender: Address,
): ConfirmedPayment[] {
  const runs = parsePaidRuns(receipt, contract, sender)
  if (runs.length !== 1) throw new Error('Receipt contains more than one payout from this sender')
  return runs[0]
}
