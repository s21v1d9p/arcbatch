import { encodeFunctionData, getAddress, isAddress } from 'viem'
import type { Address, Hash } from 'viem'
import { matchingRun, payArgs, prepareSafePayment, publicClient } from './chain'
import type { SafeQuote } from './chain'
import { validatePayouts } from './payouts'
import type { Batch } from './payouts'
import { batchAbi, parsePaidRuns, RevertedPaymentError } from './receipts'
import type { ConfirmedPayment } from './receipts'

// Only the official Safe{Wallet} app may drive Arc Payrun when it runs as a Safe App.
const SAFE_WALLET_ORIGIN = /^https:\/\/app\.safe\.global$/

export type SafeSdk = {
  safe: {
    getInfo(): Promise<{ safeAddress: string; chainId: number; threshold: number; isReadOnly: boolean }>
  }
  txs: {
    send(params: { txs: { to: string; value: string; data: string }[] }): Promise<{ safeTxHash: string }>
    getBySafeTxHash(safeTxHash: string): Promise<{ txStatus: string; txHash?: string }>
  }
}

export type SafeSession = {
  sdk: SafeSdk
  address: Address
  chainId: number
  threshold: number
  readOnly: boolean
}

export type SafeProgress = 'syncing' | 'awaiting-signatures' | 'awaiting-execution'

export class SafePendingError extends Error {
  constructor() {
    super('Still waiting for the Safe owners to sign and execute this payout')
    this.name = 'SafePendingError'
  }
}

export class SafeCancelledError extends Error {
  constructor() {
    super('The Safe transaction was cancelled. No one was paid')
    this.name = 'SafeCancelledError'
  }
}

async function loadSafeSdk(): Promise<SafeSdk> {
  const { default: SafeAppsSDK } = await import('@safe-global/safe-apps-sdk')
  return new SafeAppsSDK({ allowedDomains: [SAFE_WALLET_ORIGIN] })
}

function insideFrame(): boolean {
  return window.self !== window.top
}

export async function detectSafe({
  inFrame = insideFrame(),
  loadSdk = loadSafeSdk,
  timeoutMs = 1500,
}: { inFrame?: boolean; loadSdk?: () => Promise<SafeSdk>; timeoutMs?: number } = {}): Promise<SafeSession | null> {
  if (!inFrame) return null
  const sdk = await loadSdk()
  const info = await Promise.race([
    sdk.safe.getInfo(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ])
  if (!info) return null
  return {
    sdk,
    address: getAddress(info.safeAddress),
    chainId: info.chainId,
    threshold: info.threshold,
    readOnly: info.isReadOnly,
  }
}

export async function proposeSafePayment(session: SafeSession, batch: Batch, quote: SafeQuote): Promise<string> {
  const current = await prepareSafePayment(batch, session.address)
  if (current.contract !== quote.contract) {
    throw new Error('Payout contract changed. Review the payout again.')
  }
  const data = encodeFunctionData({ abi: batchAbi, functionName: 'pay', args: payArgs(batch) })
  const { safeTxHash } = await session.sdk.txs.send({
    txs: [{ to: current.contract, value: batch.total.toString(), data }],
  })
  return safeTxHash
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function executedTransaction(
  sdk: SafeSdk,
  safeTxHash: string,
  onProgress: (progress: SafeProgress) => void,
  { pollMs, timeoutMs, sleep }: { pollMs: number; timeoutMs: number; sleep: (ms: number) => Promise<void> },
): Promise<{ hash: Hash; failed: boolean }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // Safe's backend needs a moment to index a new proposal, so lookup errors mean "not yet".
    const details = await sdk.txs.getBySafeTxHash(safeTxHash).catch(() => null)
    if (details?.txStatus === 'CANCELLED') throw new SafeCancelledError()
    if (details?.txHash && (details.txStatus === 'SUCCESS' || details.txStatus === 'FAILED')) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(details.txHash)) {
        throw new Error('Safe returned an invalid transaction hash')
      }
      return { hash: details.txHash as Hash, failed: details.txStatus === 'FAILED' }
    }
    onProgress(
      !details ? 'syncing' : details.txStatus === 'AWAITING_EXECUTION' ? 'awaiting-execution' : 'awaiting-signatures',
    )
    if (Date.now() >= deadline) throw new SafePendingError()
    await sleep(pollMs)
  }
}

export async function completeSafePayment(
  session: SafeSession,
  batch: Batch,
  contract: Address,
  safeTxHash: string,
  { onProgress, onExecuted }: { onProgress: (progress: SafeProgress) => void; onExecuted: (hash: Hash) => void },
  { pollMs = 3000, timeoutMs = 10 * 60_000, sleep = wait }: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
) {
  const { hash, failed } = await executedTransaction(session.sdk, safeTxHash, onProgress, { pollMs, timeoutMs, sleep })
  onExecuted(hash)
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  let runs: ConfirmedPayment[][]
  try {
    runs = parsePaidRuns(receipt, contract, session.address)
  } catch (cause) {
    // Safe reports FAILED when the payout call failed inside a Safe transaction that went through: nobody was paid.
    if (failed) throw new RevertedPaymentError()
    throw cause
  }
  return {
    hash,
    sender: session.address,
    executor: getAddress(receipt.from),
    payments: matchingRun(runs, batch),
    runs,
    blockNumber: receipt.blockNumber,
  }
}

// Proposals waiting for signatures are remembered per browser, so reopening the app inside Safe
// cannot propose the same payout a second time.
const PENDING_KEY = 'arcpayrun:pending-safe-payouts'

type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void }

export type PendingPayout = {
  safe: Address
  safeTxHash: string
  proposedAt: number
  missingSince?: number
  payouts: { address: string; amount: string }[]
}

// A proposal Safe cannot find on two checks this far apart was deleted from its queue.
const FORGET_MISSING_AFTER_MS = 10 * 60_000

function browserStore(): Store | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function isPendingPayout(value: unknown): value is PendingPayout {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<PendingPayout>
  return (
    typeof item.safe === 'string' &&
    isAddress(item.safe) &&
    typeof item.safeTxHash === 'string' &&
    typeof item.proposedAt === 'number' &&
    (item.missingSince === undefined || typeof item.missingSince === 'number') &&
    Array.isArray(item.payouts) &&
    item.payouts.every((payout) => typeof payout?.address === 'string' && typeof payout?.amount === 'string')
  )
}

function readPending(store: Store | null): PendingPayout[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(PENDING_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isPendingPayout) : []
  } catch {
    return []
  }
}

function writePending(store: Store | null, items: PendingPayout[]): void {
  try {
    store?.setItem(PENDING_KEY, JSON.stringify(items))
  } catch {
    // Storage blocked: the app still works, it just cannot remember proposals across reloads.
  }
}

export function rememberPendingPayout(
  safe: Address,
  safeTxHash: string,
  batch: Batch,
  store = browserStore(),
  now = Date.now(),
): void {
  const items = readPending(store).filter((item) => item.safeTxHash !== safeTxHash)
  items.push({ safe, safeTxHash, proposedAt: now, payouts: batch.payouts.map(({ address, amount }) => ({ address, amount })) })
  writePending(store, items)
}

export function forgetPendingPayout(safeTxHash: string, store = browserStore()): void {
  writePending(store, readPending(store).filter((item) => item.safeTxHash !== safeTxHash))
}

export function pendingPayoutsFor(safe: Address, store = browserStore()): PendingPayout[] {
  return readPending(store).filter((item) => item.safe.toLowerCase() === safe.toLowerCase())
}

export function restoreBatch(pending: PendingPayout): Batch {
  return validatePayouts(pending.payouts)
}

function samePayout(item: PendingPayout, batch: Batch): boolean {
  try {
    const pending = restoreBatch(item)
    return (
      pending.payouts.length === batch.payouts.length &&
      pending.payouts.every(
        (payout, index) =>
          payout.address.toLowerCase() === batch.payouts[index].address.toLowerCase() &&
          payout.units === batch.payouts[index].units,
      )
    )
  } catch {
    return false
  }
}

export function isPendingDuplicate(safe: Address, batch: Batch, store = browserStore()): boolean {
  return pendingPayoutsFor(safe, store).some((item) => samePayout(item, batch))
}

const RESOLVED = ['SUCCESS', 'FAILED', 'CANCELLED']

function updatePending(store: Store | null, safeTxHash: string, change: Partial<PendingPayout>): void {
  writePending(store, readPending(store).map((item) => (item.safeTxHash === safeTxHash ? { ...item, ...change } : item)))
}

export async function refreshPendingPayouts(
  session: SafeSession,
  store = browserStore(),
  now = Date.now(),
): Promise<PendingPayout[]> {
  const kept: PendingPayout[] = []
  for (const item of pendingPayoutsFor(session.address, store)) {
    const details = await session.sdk.txs.getBySafeTxHash(item.safeTxHash).catch(() => null)
    if (details && RESOLVED.includes(details.txStatus)) {
      forgetPendingPayout(item.safeTxHash, store)
      continue
    }
    if (details) {
      if (item.missingSince !== undefined) updatePending(store, item.safeTxHash, { missingSince: undefined })
      kept.push({ ...item, missingSince: undefined })
      continue
    }
    // A lookup can fail during an outage, so a proposal is only dropped after a second miss much later.
    if (item.missingSince === undefined) {
      updatePending(store, item.safeTxHash, { missingSince: now })
      kept.push({ ...item, missingSince: now })
    } else if (now - item.missingSince >= FORGET_MISSING_AFTER_MS) {
      forgetPendingPayout(item.safeTxHash, store)
    } else {
      kept.push(item)
    }
  }
  return kept
}

// Before proposing, any remembered identical payout is checked with Safe. Nothing is forgotten here
// unless Safe says it was executed, failed or cancelled.
export async function duplicateStatus(
  session: SafeSession,
  batch: Batch,
  store = browserStore(),
): Promise<'none' | 'pending' | 'unknown'> {
  let status: 'none' | 'pending' | 'unknown' = 'none'
  for (const item of pendingPayoutsFor(session.address, store)) {
    if (!samePayout(item, batch)) continue
    const details = await session.sdk.txs.getBySafeTxHash(item.safeTxHash).catch(() => null)
    if (details && RESOLVED.includes(details.txStatus)) {
      forgetPendingPayout(item.safeTxHash, store)
    } else if (details) {
      return 'pending'
    } else {
      status = 'unknown'
    }
  }
  return status
}
