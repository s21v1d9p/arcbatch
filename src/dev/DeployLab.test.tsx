// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ARC_BATCH_RUNTIME_CODE } from '../lib/contractCode'
import DeployLab from './DeployLab'

const sender = '0x1111111111111111111111111111111111111111'
const artifact = {
  _format: 'hh3-artifact-1',
  contractName: 'ArcBatch',
  abi: [
    { type: 'function', name: 'pay', stateMutability: 'payable' },
    { type: 'event', name: 'Paid' },
  ],
  bytecode: '0x60016000',
  deployedBytecode: '0x6001',
}

afterEach(() => {
  cleanup()
  delete window.ethereum
  vi.unstubAllGlobals()
})

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

function stubArtifactAndRpc(deployedBytecode: string, chainId = '0x13b2') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/ArcBatch.json')) return json({ ...artifact, deployedBytecode })
      const request = JSON.parse(String(init?.body)) as { id: number; method: string }
      const results: Record<string, string> = {
        eth_chainId: chainId,
        eth_getBalance: '0x29a2241af62c0000',
      }
      return json({ jsonrpc: '2.0', id: request.id, result: results[request.method] })
    }),
  )
}

function stubWallet() {
  Object.defineProperty(window, 'ethereum', {
    configurable: true,
    value: {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [sender]
        if (method === 'wallet_switchEthereumChain') return null
        throw new Error(`Unexpected wallet request: ${method}`)
      },
    },
  })
}

describe('local-only testnet lab', () => {
  it('loads local compiled bytecode and requires a wallet before deploying', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => artifact }))
    render(<DeployLab />)
    expect(screen.getByRole('heading', { name: /arc testnet lab/i })).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/compiled contract ready/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /prepare deployment/i }).hasAttribute('disabled'))
      .toBe(true)
    await userEvent.setup().click(screen.getByRole('button', { name: /connect metamask/i }))
    expect(screen.getByRole('alert').textContent).toMatch(/No browser wallet detected/i)
  })
})

describe('local-only mainnet deployment mode', () => {
  it('requires verified bytecode, Arc mainnet, and typed confirmation before preparing deployment', async () => {
    stubArtifactAndRpc(ARC_BATCH_RUNTIME_CODE)
    stubWallet()
    const user = userEvent.setup()
    render(<DeployLab network="mainnet" />)

    expect(screen.getByRole('heading', { name: /arc mainnet deploy/i })).toBeTruthy()
    expect(document.querySelector('.lab-banner')?.textContent).toMatch(/Arc Mainnet, real USDC/)
    expect(screen.queryByRole('heading', { name: /two-recipient smoke test/i })).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/matches verified ArcBatch bytecode/i),
    )
    await user.click(screen.getByRole('button', { name: /connect metamask/i }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Connected to Arc Mainnet/i))

    const prepare = screen.getByRole('button', { name: /prepare deployment/i })
    expect(prepare.hasAttribute('disabled')).toBe(true)
    await user.type(screen.getByRole('textbox', { name: /type deploy on mainnet/i }), 'DEPLOY ON MAINNET')
    expect(prepare.hasAttribute('disabled')).toBe(false)
  })

  it('blocks mainnet deployment when compiled bytecode differs from the verified contract', async () => {
    stubArtifactAndRpc('0x6001')
    render(<DeployLab network="mainnet" />)

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/differs from the verified ArcBatch bytecode/i),
    )
    expect(screen.getByRole('button', { name: /prepare deployment/i }).hasAttribute('disabled'))
      .toBe(true)
  })

  it('refuses a wallet connection when the RPC is not Arc mainnet', async () => {
    stubArtifactAndRpc(ARC_BATCH_RUNTIME_CODE, '0x4cef52')
    stubWallet()
    render(<DeployLab network="mainnet" />)
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/matches verified ArcBatch bytecode/i),
    )
    await userEvent.setup().click(screen.getByRole('button', { name: /connect metamask/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/expected Arc Mainnet 5042/i))
  })
})
