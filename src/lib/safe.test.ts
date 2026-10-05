// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, getAddress, pad, toEventSelector } from 'viem'
import * as chain from './chain'
import { validatePayouts } from './payouts'
import { batchAbi, RevertedPaymentError } from './receipts'
import {
  completeSafePayment,
  detectSafe,
  duplicateStatus,
  forgetPendingPayout,
  isPendingDuplicate,
  pendingPayoutsFor,
  proposeSafePayment,
  refreshPendingPayouts,
  rememberPendingPayout,
  restoreBatch,
  SafeCancelledError,
  SafePendingError,
} from './safe'
import type { SafeSdk, SafeSession } from './safe'

const safeAddress = '0x4444444444444444444444444444444444444444' as const
const owner = '0x5555555555555555555555555555555555555555' as const
const contract = '0x3333333333333333333333333333333333333333' as const
const recipient = '0x2222222222222222222222222222222222222222' as const
const executed = `0x${'e'.repeat(64)}` as const
const batch = validatePayouts([{ address: recipient, amount: '0.01' }])
const quote = { account: safeAddress, contract, balance: 1_000_000_000_000_000_000n }

type SendParams = { txs: { to: string; value: string; data: string }[] }
type SafeTxReply = { txStatus: string; txHash?: string }

function fakeSdk({
  getInfo = async () => {
    throw new Error('getInfo not expected')
  },
  send = async (_params: SendParams) => {
    throw new Error('send not expected')
  },
  getBySafeTxHash = async (_safeTxHash: string): Promise<SafeTxReply> => {
    throw new Error('getBySafeTxHash not expected')
  },
}: Partial<{
  getInfo: SafeSdk['safe']['getInfo']
  send: SafeSdk['txs']['send']
  getBySafeTxHash: SafeSdk['txs']['getBySafeTxHash']
}> = {}): SafeSdk {
  return { safe: { getInfo }, txs: { send, getBySafeTxHash } }
}

function sessionWith(sdk: SafeSdk): SafeSession {
  return { sdk, address: safeAddress, chainId: 5042, threshold: 1, readOnly: false }
}

function receiptPaidBy(sender: string, status: 'success' | 'reverted' = 'success', runs: bigint[][] = [[10_000_000_000_000_000n]]) {
  return {
    status,
    from: owner,
    to: safeAddress,
    blockNumber: 7n,
    logs:
      status === 'reverted'
        ? []
        : runs.flatMap((amounts) =>
            amounts.map((amount, index) => ({
              address: contract,
              topics: [
                toEventSelector('event Paid(address indexed sender, address indexed recipient, uint256 amount, uint256 index)'),
                pad(sender as `0x${string}`),
                pad(recipient),
              ],
              data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [amount, BigInt(index)]),
            })),
          ),
  }
}

function memoryStore() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) }
}

function replies(...items: Array<Error | SafeTxReply>) {
  return vi.fn(async (_safeTxHash: string): Promise<SafeTxReply> => {
    const next = items.length > 1 ? items.shift() : items[0]
    if (!next || next instanceof Error) throw next ?? new Error('no reply')
    return next
  })
}

const noWait = { sleep: async () => {} }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('detectSafe', () => {
  it('returns null outside a frame without loading the Safe SDK', async () => {
    const loadSdk = vi.fn(async () => fakeSdk())
    await expect(detectSafe({ loadSdk })).resolves.toBeNull()
    expect(loadSdk).not.toHaveBeenCalled()
  })

  it('returns null when nothing answers inside a frame', async () => {
    const sdk = fakeSdk({ getInfo: () => new Promise(() => {}) })
    await expect(detectSafe({ inFrame: true, loadSdk: async () => sdk, timeoutMs: 5 })).resolves.toBeNull()
  })

  it('reads the Safe address, network, threshold and read-only flag', async () => {
    const mixedCase = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    const sdk = fakeSdk({
      getInfo: async () => ({ safeAddress: mixedCase, chainId: 5042, threshold: 2, owners: [owner], isReadOnly: true }),
    })
    await expect(detectSafe({ inFrame: true, loadSdk: async () => sdk })).resolves.toEqual({
      sdk,
      address: getAddress(mixedCase),
      chainId: 5042,
      threshold: 2,
      readOnly: true,
    })
  })
})

describe('proposeSafePayment', () => {
  it('checks the payout again, then proposes one pay call with the exact total', async () => {
    const recheck = vi.spyOn(chain, 'prepareSafePayment').mockResolvedValue(quote)
    const send = vi.fn(async (_params: SendParams) => ({ safeTxHash: '0x5afe' }))

    await expect(proposeSafePayment(sessionWith(fakeSdk({ send })), batch, quote)).resolves.toBe('0x5afe')
    expect(recheck).toHaveBeenCalledWith(batch, safeAddress)
    expect(send).toHaveBeenCalledTimes(1)
    const { txs } = send.mock.calls[0][0]
    expect(txs).toHaveLength(1)
    expect(txs[0].to).toBe(contract)
    expect(txs[0].value).toBe('10000000000000000')
    expect(decodeFunctionData({ abi: batchAbi, data: txs[0].data as `0x${string}` })).toEqual({
      functionName: 'pay',
      args: [[recipient], [10_000_000_000_000_000n]],
    })
  })

  it('does not propose when the payout contract changed after review', async () => {
    vi.spyOn(chain, 'prepareSafePayment').mockResolvedValue({ ...quote, contract: owner })
    const send = vi.fn(async (_params: SendParams) => ({ safeTxHash: '0x5afe' }))
    await expect(proposeSafePayment(sessionWith(fakeSdk({ send })), batch, quote)).rejects.toThrow(
      'Payout contract changed',
    )
    expect(send).not.toHaveBeenCalled()
  })
})

describe('completeSafePayment', () => {
  it('waits while Safe syncs and owners sign, then verifies the executed payout', async () => {
    const getBySafeTxHash = replies(
      new Error('not indexed yet'),
      { txStatus: 'AWAITING_CONFIRMATIONS' },
      { txStatus: 'AWAITING_EXECUTION' },
      { txStatus: 'SUCCESS', txHash: executed },
    )
    vi.spyOn(chain.publicClient, 'waitForTransactionReceipt').mockResolvedValue(receiptPaidBy(safeAddress) as never)
    const progress: string[] = []
    const onExecuted = vi.fn()

    const result = await completeSafePayment(
      sessionWith(fakeSdk({ getBySafeTxHash })),
      batch,
      contract,
      '0x5afe',
      { onProgress: (step) => progress.push(step), onExecuted },
      noWait,
    )
    expect(progress).toEqual(['syncing', 'awaiting-signatures', 'awaiting-execution'])
    expect(onExecuted).toHaveBeenCalledWith(executed)
    expect(result).toEqual({
      hash: executed,
      sender: safeAddress,
      executor: owner,
      payments: [{ recipient, amount: 10_000_000_000_000_000n, index: 0 }],
      runs: [[{ recipient, amount: 10_000_000_000_000_000n, index: 0 }]],
      blockNumber: 7n,
    })
  })

  it('finds this payout when Safe executes several queued payouts in one transaction', async () => {
    const session = sessionWith(fakeSdk({ getBySafeTxHash: replies({ txStatus: 'SUCCESS', txHash: executed }) }))
    vi.spyOn(chain.publicClient, 'waitForTransactionReceipt').mockResolvedValue(
      receiptPaidBy(safeAddress, 'success', [[5n, 6n], [10_000_000_000_000_000n]]) as never,
    )
    const result = await completeSafePayment(session, batch, contract, '0x5afe', { onProgress: vi.fn(), onExecuted: vi.fn() }, noWait)
    expect(result.payments).toEqual([{ recipient, amount: 10_000_000_000_000_000n, index: 0 }])
    expect(result.runs).toHaveLength(2)
  })

  it('stops on a cancelled transaction or a malformed hash, and gives up waiting with a clear error', async () => {
    const callbacks = { onProgress: vi.fn(), onExecuted: vi.fn() }
    const cancelled = sessionWith(fakeSdk({ getBySafeTxHash: replies({ txStatus: 'CANCELLED' }) }))
    await expect(completeSafePayment(cancelled, batch, contract, '0x5afe', callbacks, noWait)).rejects.toThrow(
      SafeCancelledError,
    )
    const malformed = sessionWith(fakeSdk({ getBySafeTxHash: replies({ txStatus: 'SUCCESS', txHash: 'javascript:x' }) }))
    await expect(completeSafePayment(malformed, batch, contract, '0x5afe', callbacks, noWait)).rejects.toThrow(
      'invalid transaction hash',
    )
    const waiting = sessionWith(fakeSdk({ getBySafeTxHash: replies({ txStatus: 'AWAITING_CONFIRMATIONS' }) }))
    await expect(
      completeSafePayment(waiting, batch, contract, '0x5afe', callbacks, { ...noWait, timeoutMs: 0 }),
    ).rejects.toThrow(SafePendingError)
    expect(callbacks.onExecuted).not.toHaveBeenCalled()
  })

  it('reports a failed Safe execution as not paid and never accepts payments from another sender', async () => {
    const callbacks = { onProgress: vi.fn(), onExecuted: vi.fn() }
    // Safe marks a transaction FAILED when the payout call failed inside a Safe transaction that itself succeeded.
    const failed = sessionWith(fakeSdk({ getBySafeTxHash: replies({ txStatus: 'FAILED', txHash: executed }) }))
    const receipt = vi
      .spyOn(chain.publicClient, 'waitForTransactionReceipt')
      .mockResolvedValue({ ...receiptPaidBy(safeAddress), logs: [] } as never)
    await expect(completeSafePayment(failed, batch, contract, '0x5afe', callbacks, noWait)).rejects.toThrow(
      RevertedPaymentError,
    )
    expect(callbacks.onExecuted).toHaveBeenCalledWith(executed)

    const succeeded = sessionWith(fakeSdk({ getBySafeTxHash: replies({ txStatus: 'SUCCESS', txHash: executed }) }))
    receipt.mockResolvedValue(receiptPaidBy(owner) as never)
    await expect(completeSafePayment(succeeded, batch, contract, '0x5afe', callbacks, noWait)).rejects.toThrow(
      'No payout events',
    )
  })
})

describe('pending Safe payouts', () => {
  const otherSafe = '0x1234567890123456789012345678901234567890' as const

  it('remembers a proposed payout and spots the same payout proposed again', () => {
    const store = memoryStore()
    rememberPendingPayout(safeAddress, '0x5afe', batch, store)
    expect(pendingPayoutsFor(safeAddress, store).map((item) => item.safeTxHash)).toEqual(['0x5afe'])
    expect(restoreBatch(pendingPayoutsFor(safeAddress, store)[0])).toEqual(batch)
    expect(isPendingDuplicate(safeAddress, validatePayouts([{ address: recipient, amount: '0.010' }]), store)).toBe(true)
    expect(isPendingDuplicate(safeAddress, validatePayouts([{ address: recipient, amount: '0.02' }]), store)).toBe(false)
    expect(isPendingDuplicate(otherSafe, batch, store)).toBe(false)

    forgetPendingPayout('0x5afe', store)
    expect(pendingPayoutsFor(safeAddress, store)).toEqual([])
    expect(isPendingDuplicate(safeAddress, batch, store)).toBe(false)
  })

  it('drops payouts that Safe reports as executed, failed or cancelled, and keeps the rest', async () => {
    const store = memoryStore()
    for (const hash of ['0xa', '0xb', '0xc', '0xd']) rememberPendingPayout(safeAddress, hash, batch, store)
    const status: Record<string, SafeTxReply | Error> = {
      '0xa': { txStatus: 'SUCCESS', txHash: executed },
      '0xb': { txStatus: 'AWAITING_CONFIRMATIONS' },
      '0xc': new Error('not indexed yet'),
      '0xd': { txStatus: 'CANCELLED' },
    }
    const getBySafeTxHash = async (hash: string): Promise<SafeTxReply> => {
      const reply = status[hash]
      if (reply instanceof Error) throw reply
      return reply
    }
    const kept = await refreshPendingPayouts(sessionWith(fakeSdk({ getBySafeTxHash })), store)
    expect(kept.map((item) => item.safeTxHash)).toEqual(['0xb', '0xc'])
    expect(pendingPayoutsFor(safeAddress, store).map((item) => item.safeTxHash)).toEqual(['0xb', '0xc'])
  })

  it('forgets a proposal only after Safe fails to find it twice, at least 10 minutes apart', async () => {
    const store = memoryStore()
    rememberPendingPayout(safeAddress, '0xgone', batch, store, 0)
    const missing = sessionWith(fakeSdk({ getBySafeTxHash: replies(new Error('Not found')) }))
    const hour = 60 * 60_000
    expect(await refreshPendingPayouts(missing, store, hour)).toHaveLength(1)
    expect(await refreshPendingPayouts(missing, store, hour + 5 * 60_000)).toHaveLength(1)
    expect(await refreshPendingPayouts(missing, store, hour + 11 * 60_000)).toEqual([])
    expect(isPendingDuplicate(safeAddress, batch, store)).toBe(false)
  })

  it('keeps a pending proposal through a passing outage', async () => {
    const store = memoryStore()
    rememberPendingPayout(safeAddress, '0x5afe', batch, store, 0)
    const hour = 60 * 60_000
    const down = sessionWith(fakeSdk({ getBySafeTxHash: replies(new Error('503')) }))
    const up = sessionWith(fakeSdk({ getBySafeTxHash: replies({ txStatus: 'AWAITING_CONFIRMATIONS' }) }))
    await refreshPendingPayouts(down, store, hour)
    await refreshPendingPayouts(up, store, hour + 5 * 60_000)
    expect(await refreshPendingPayouts(down, store, hour + 20 * 60_000)).toHaveLength(1)
    expect(isPendingDuplicate(safeAddress, batch, store)).toBe(true)
  })

  it('checks a remembered identical payout with Safe before allowing a new proposal', async () => {
    const store = memoryStore()
    expect(await duplicateStatus(sessionWith(fakeSdk()), batch, store)).toBe('none')
    rememberPendingPayout(safeAddress, '0x5afe', batch, store, 0)
    const pending = sessionWith(fakeSdk({ getBySafeTxHash: replies({ txStatus: 'AWAITING_EXECUTION' }) }))
    expect(await duplicateStatus(pending, batch, store)).toBe('pending')
    const down = sessionWith(fakeSdk({ getBySafeTxHash: replies(new Error('503')) }))
    expect(await duplicateStatus(down, batch, store)).toBe('unknown')
    expect(pendingPayoutsFor(safeAddress, store)).toHaveLength(1)
    const done = sessionWith(fakeSdk({ getBySafeTxHash: replies({ txStatus: 'SUCCESS', txHash: executed }) }))
    expect(await duplicateStatus(done, batch, store)).toBe('none')
    expect(pendingPayoutsFor(safeAddress, store)).toEqual([])
  })

  it('works without storage when the browser blocks it', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => rememberPendingPayout(safeAddress, '0x5afe', batch, blocked)).not.toThrow()
    expect(pendingPayoutsFor(safeAddress, blocked)).toEqual([])
  })
})
