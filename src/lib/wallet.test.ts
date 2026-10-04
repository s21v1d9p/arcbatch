// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { arcTestnet } from './networks'
import { connectToChain } from './wallet'

afterEach(() => {
  delete window.ethereum
})

describe('wallet connection on Arc Testnet', () => {
  it('only asks the wallet to select chain 5042002', async () => {
    const calls: { method: string; params?: unknown }[] = []
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: {
        request: async (request: { method: string; params?: unknown }) => {
          calls.push(request)
          if (request.method === 'eth_requestAccounts') {
            return ['0x1111111111111111111111111111111111111111']
          }
          if (request.method === 'wallet_switchEthereumChain') return null
          throw new Error(`Unexpected request: ${request.method}`)
        },
      },
    })
    await expect(connectToChain(arcTestnet)).resolves.toBe(
      '0x1111111111111111111111111111111111111111',
    )
    expect(calls.find((call) => call.method === 'wallet_switchEthereumChain')?.params).toEqual([
      { chainId: '0x4cef52' },
    ])
  })
})
