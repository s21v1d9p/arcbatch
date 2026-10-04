// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, getAddress, pad, toEventSelector } from 'viem'
import {
  assertMatchesReviewedBatch,
  connectWallet,
  loadPayment,
  preparePayment,
  publicClient,
  sendPayment,
} from './chain'
import { ARC_BATCH_RUNTIME_CODE } from './contractCode'
import { validatePayouts } from './payouts'

const sender = '0x1111111111111111111111111111111111111111' as const
const recipient = '0x2222222222222222222222222222222222222222' as const
const contract = '0x3333333333333333333333333333333333333333' as const
const batch = validatePayouts([{ address: recipient, amount: '1' }])

describe('receipt vs reviewed batch', () => {
  it('accepts only the exact ordered recipient and amount list', () => {
    expect(() =>
      assertMatchesReviewedBatch(
        [{ recipient, amount: 1_000_000_000_000_000_000n, index: 0 }],
        batch,
      ),
    ).not.toThrow()
    expect(() => assertMatchesReviewedBatch([], batch)).toThrow('do not match')
    expect(() =>
      assertMatchesReviewedBatch(
        [{ recipient: sender, amount: 1_000_000_000_000_000_000n, index: 0 }],
        batch,
      ),
    ).toThrow('do not match')
    expect(() =>
      assertMatchesReviewedBatch([{ recipient, amount: 1n, index: 0 }], batch),
    ).toThrow('do not match')
  })
})

afterEach(() => {
  delete window.ethereum
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Arc wallet setup', () => {
  it('adds Arc only when the wallet reports it unknown, then switches to chain 5042', async () => {
    const methods: string[] = []
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: {
        request: async ({ method }: { method: string }) => {
          methods.push(method)
          if (method === 'eth_requestAccounts') return [sender]
          if (method === 'wallet_switchEthereumChain' && methods.filter((m) => m === method).length === 1) {
            throw Object.assign(new Error('unknown chain'), { code: 4902 })
          }
          if (method === 'wallet_addEthereumChain' || method === 'wallet_switchEthereumChain') return null
          throw new Error(`Unexpected RPC: ${method}`)
        },
      },
    })

    await expect(connectWallet()).resolves.toBe(sender)
    expect(methods).toEqual([
      'eth_requestAccounts',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
    ])
  })

  it('does not hide a rejected network change', async () => {
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: {
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_requestAccounts') return [sender]
          throw Object.assign(new Error('User rejected network switch'), { code: 4001 })
        },
      },
    })
    await expect(connectWallet()).rejects.toThrow('User rejected network switch')
  })
})

describe('mainnet payout quote', () => {
  it('floors max gas price at 20 Gwei and reserves enough USDC for payout plus gas', async () => {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    vi.spyOn(publicClient, 'getChainId').mockResolvedValue(5042)
    vi.spyOn(publicClient, 'getCode').mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    vi.spyOn(publicClient, 'estimateContractGas').mockResolvedValue(100_000n)
    vi.spyOn(publicClient, 'estimateFeesPerGas').mockResolvedValue({
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    })
    vi.spyOn(publicClient, 'getBalance').mockResolvedValue(2_000_000_000_000_000_000n)

    const quote = await preparePayment(batch, sender)
    expect(quote.maxFeePerGas).toBe(21_000_000_000n)
    expect(quote.maxPriorityFeePerGas).toBe(1_000_000_000n)
    expect(quote.gasLimit).toBe(120_001n)
    expect(quote.maxNetworkFee).toBe(2_520_021_000_000_000n)
  })

  it('rejects mismatched chains, undeployed contracts, and insufficient USDC', async () => {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    const chainId = vi.spyOn(publicClient, 'getChainId').mockResolvedValue(1)
    await expect(preparePayment(batch, sender)).rejects.toThrow('not connected to Arc mainnet')
    chainId.mockResolvedValue(5042)
    const code = vi.spyOn(publicClient, 'getCode').mockResolvedValue(undefined)
    await expect(preparePayment(batch, sender)).rejects.toThrow('not deployed')
    code.mockResolvedValue('0x6000')
    await expect(preparePayment(batch, sender)).rejects.toThrow('verified payout contract bytecode')
    code.mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    vi.spyOn(publicClient, 'estimateContractGas').mockResolvedValue(100_000n)
    vi.spyOn(publicClient, 'estimateFeesPerGas').mockResolvedValue({
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 0n,
    })
    vi.spyOn(publicClient, 'getBalance').mockResolvedValue(1_000_000_000_000_000_000n)
    await expect(preparePayment(batch, sender)).rejects.toThrow('Insufficient Arc USDC')
  })

  it('passes the reviewed recipients, exact value, gas limit, and both fee caps to the wallet', async () => {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    vi.spyOn(publicClient, 'getChainId').mockResolvedValue(5042)
    vi.spyOn(publicClient, 'getCode').mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    vi.spyOn(publicClient, 'estimateContractGas').mockResolvedValue(100_000n)
    vi.spyOn(publicClient, 'estimateFeesPerGas').mockResolvedValue({
      maxFeePerGas: 21_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    })
    vi.spyOn(publicClient, 'getBalance').mockResolvedValue(2_000_000_000_000_000_000n)
    vi.spyOn(publicClient, 'waitForTransactionReceipt').mockRejectedValue(
      new Error('Stopped after wallet broadcast'),
    )

    let sent: unknown
    const hash = `0x${'f'.repeat(64)}`
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: {
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          if (method === 'eth_accounts') return [sender]
          if (method === 'wallet_switchEthereumChain') return null
          if (method === 'eth_chainId') return '0x13b2'
          if (method === 'eth_sendTransaction') {
            sent = params
            return hash
          }
          throw new Error(`Unexpected wallet RPC: ${method}`)
        },
      },
    })

    const onSubmitted = vi.fn()
    const quote = await preparePayment(batch, sender)
    await expect(sendPayment(batch, quote, onSubmitted)).rejects.toThrow(
      'Stopped after wallet broadcast',
    )
    expect(onSubmitted).toHaveBeenCalledWith(hash)
    expect(sent).toEqual([
      expect.objectContaining({
        from: sender,
        to: contract,
        value: '0xde0b6b3a7640000',
        gas: '0x1d4c1',
        maxFeePerGas: '0x4e3b29200',
        maxPriorityFeePerGas: '0x3b9aca00',
      }),
    ])
  })
})

describe('shared receipt verification', () => {
  it('refuses receipts from a configured address that is not the verified payout contract', async () => {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    const hash = `0x${'e'.repeat(64)}` as const
    vi.spyOn(publicClient, 'getTransaction').mockResolvedValue({ to: contract, from: sender } as never)
    const code = vi.spyOn(publicClient, 'getCode').mockResolvedValue('0x6000')
    const receipt = vi
      .spyOn(publicClient, 'getTransactionReceipt')
      .mockResolvedValue({ status: 'success', logs: [], blockNumber: 1n } as never)

    await expect(loadPayment(hash)).rejects.toThrow('verified payout contract bytecode')
    expect(receipt).not.toHaveBeenCalled()
    code.mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    await expect(loadPayment(hash)).rejects.toThrow('No payout events')
  })

  it('returns a checksummed sender for shareable receipts', async () => {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    const hash = `0x${'d'.repeat(64)}` as const
    const lowercaseSender = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    vi.spyOn(publicClient, 'getTransaction').mockResolvedValue({
      to: contract,
      from: lowercaseSender,
    } as never)
    vi.spyOn(publicClient, 'getCode').mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    vi.spyOn(publicClient, 'getTransactionReceipt').mockResolvedValue({
      status: 'success',
      blockNumber: 1n,
      logs: [
        {
          address: contract,
          topics: [
            toEventSelector('event Paid(address indexed sender, address indexed recipient, uint256 amount, uint256 index)'),
            pad(lowercaseSender),
            pad(recipient),
          ],
          data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1n, 0n]),
        },
      ],
    } as never)

    const result = await loadPayment(hash)
    expect(result.sender).toBe(getAddress(lowercaseSender))
  })
})
