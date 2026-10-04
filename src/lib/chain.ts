import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  isAddress,
  zeroAddress,
} from 'viem'
import type { Address, Hash } from 'viem'
import type { Batch } from './payouts'
import { batchAbi, parsePaidReceipt } from './receipts'
import type { ConfirmedPayment } from './receipts'
import { ARC_BATCH_RUNTIME_CODE } from './contractCode'
import { arcFeeCaps } from './fees'
import { arcMainnet } from './networks'
import { arcMainnetTransport } from './rpc'
import { connectToChain, injectedWallet, selectChain } from './wallet'

export { arcMainnet }

export const publicClient = createPublicClient({ chain: arcMainnet, transport: arcMainnetTransport() })

export type Quote = {
  account: Address
  contract: Address
  balance: bigint
  gasLimit: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  maxNetworkFee: bigint
}

export function assertMatchesReviewedBatch(payments: readonly ConfirmedPayment[], batch: Batch): void {
  if (
    payments.length !== batch.payouts.length ||
    payments.some(
      (payment, index) =>
        payment.index !== index ||
        payment.recipient.toLowerCase() !== batch.payouts[index].address.toLowerCase() ||
        payment.amount !== batch.payouts[index].units,
    )
  ) {
    throw new Error('Confirmed payment events do not match the reviewed batch')
  }
}

export function configuredContract(): Address {
  const address = import.meta.env.VITE_ARC_BATCH_ADDRESS
  if (!address || !isAddress(address) || address.toLowerCase() === zeroAddress) {
    throw new Error('Arc mainnet contract address is not configured yet')
  }
  return getAddress(address)
}

export async function connectWallet(): Promise<Address> {
  return connectToChain(arcMainnet)
}

async function assertPayoutContract(address: Address): Promise<void> {
  const code = await publicClient.getCode({ address })
  if (!code || code === '0x') throw new Error('Configured contract is not deployed on Arc mainnet')
  if (code.toLowerCase() !== ARC_BATCH_RUNTIME_CODE.toLowerCase()) {
    throw new Error('Configured contract does not match the verified payout contract bytecode')
  }
}

export async function preparePayment(batch: Batch, account: Address): Promise<Quote> {
  const contract = configuredContract()
  if ((await publicClient.getChainId()) !== arcMainnet.id) {
    throw new Error('RPC is not connected to Arc mainnet')
  }
  await assertPayoutContract(contract)

  const args = [
    batch.payouts.map((payout) => payout.address),
    batch.payouts.map((payout) => payout.units),
  ] as const
  const gasEstimate = await publicClient.estimateContractGas({
    account,
    address: contract,
    abi: batchAbi,
    functionName: 'pay',
    args,
    value: batch.total,
  })
  const gasLimit = (gasEstimate * 120n) / 100n + 1n
  const { maxFeePerGas, maxPriorityFeePerGas } = arcFeeCaps(
    await publicClient.estimateFeesPerGas({ type: 'eip1559' }),
  )
  const maxNetworkFee = gasLimit * maxFeePerGas
  const balance = await publicClient.getBalance({ address: account })
  if (balance < batch.total + maxNetworkFee) {
    throw new Error(
      `Insufficient Arc USDC: need up to ${formatUnits(batch.total + maxNetworkFee, 18)} USDC including gas, wallet has ${formatUnits(balance, 18)} USDC`,
    )
  }
  return { account, contract, balance, gasLimit, maxFeePerGas, maxPriorityFeePerGas, maxNetworkFee }
}

export async function sendPayment(
  batch: Batch,
  quote: Quote,
  onSubmitted: (hash: Hash) => void,
) {
  const provider = injectedWallet()
  const client = createWalletClient({ chain: arcMainnet, transport: custom(provider) })
  const [activeAccount] = await client.getAddresses()
  if (activeAccount?.toLowerCase() !== quote.account.toLowerCase()) {
    throw new Error('Wallet account changed. Reconnect and review the payout again.')
  }
  await selectChain(arcMainnet)
  const currentQuote = await preparePayment(batch, quote.account)
  if (currentQuote.contract !== quote.contract) {
    throw new Error('Payout contract changed. Review the payout again.')
  }
  const hash = await client.writeContract({
    account: quote.account,
    chain: arcMainnet,
    address: quote.contract,
    abi: batchAbi,
    functionName: 'pay',
    args: [
      batch.payouts.map((payout) => payout.address),
      batch.payouts.map((payout) => payout.units),
    ],
    value: batch.total,
    gas: currentQuote.gasLimit,
    maxFeePerGas: currentQuote.maxFeePerGas,
    maxPriorityFeePerGas: currentQuote.maxPriorityFeePerGas,
  })
  onSubmitted(hash)
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  const payments = parsePaidReceipt(receipt, quote.contract, quote.account)
  assertMatchesReviewedBatch(payments, batch)
  return { hash, sender: quote.account, payments, blockNumber: receipt.blockNumber }
}

export async function loadPayment(hash: Hash) {
  const contract = configuredContract()
  const transaction = await publicClient.getTransaction({ hash })
  if (transaction.to?.toLowerCase() !== contract.toLowerCase()) {
    throw new Error('Transaction was not sent to the configured payout contract')
  }
  await assertPayoutContract(contract)
  const receipt = await publicClient.getTransactionReceipt({ hash })
  const payments = parsePaidReceipt(receipt, contract, transaction.from)
  return { hash, sender: getAddress(transaction.from), payments, blockNumber: receipt.blockNumber }
}

export function explorerTransaction(hash: Hash): string {
  return `${arcMainnet.blockExplorers.default.url}/tx/${hash}`
}
