// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as chain from './lib/chain'
import { RevertedPaymentError } from './lib/receipts'
import App from './App'

const alice = '0x1111111111111111111111111111111111111111'
const bob = '0x2222222222222222222222222222222222222222' as const

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('Arc Payrun interface', () => {
  it('shows exact CSV payout preview while keeping signing unavailable without deployment', async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(screen.getByRole('heading', { name: /batch payouts in usdc/i })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /paste csv/i }))
    fireEvent.change(screen.getByRole('textbox', { name: /payout csv/i }), {
      target: { value: `address,amount\n${alice},1.25\n${bob},0.000001` },
    })
    expect(screen.getByText(/2 recipients/i)).toBeTruthy()
    expect(screen.getByText('1.250001')).toBeTruthy()
    expect(screen.getByRole('button', { name: /review batch/i }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(screen.getByText(/contract address is not configured/i)).toBeTruthy()
    expect(screen.getByText(/addresses and amounts become public/i)).toBeTruthy()
  })

  it('shows row errors and does not allow signing an invalid batch', () => {
    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: /recipient address 1/i }), {
      target: { value: alice },
    })
    fireEvent.change(screen.getByRole('textbox', { name: /amount in usdc 1/i }), {
      target: { value: '0.0000001' },
    })
    expect(screen.getByText(/row 1: amount must be positive/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /review batch/i }).hasAttribute('disabled')).toBe(
      true,
    )
  })

  it('reports missing browser wallet instead of pretending to connect', async () => {
    render(<App />)
    await userEvent.setup().click(screen.getByRole('button', { name: /connect wallet/i }))
    expect(screen.getByRole('alert').textContent).toMatch(/No browser wallet detected/i)
  })

  it('rejects an invalid share link before any RPC lookup', () => {
    window.history.replaceState(null, '', '/?tx=not-a-hash')
    render(<App />)
    expect(screen.getByRole('alert').textContent).toMatch(/Invalid transaction hash/i)
  })

  it('does not allow duplicate signing after a submitted transaction times out', async () => {
    const contract = '0x3333333333333333333333333333333333333333' as const
    const address = '0x1111111111111111111111111111111111111111' as const
    const hash = `0x${'a'.repeat(64)}` as const
    vi.spyOn(chain, 'configuredContract').mockReturnValue(contract)
    vi.spyOn(chain, 'connectWallet').mockResolvedValue(address)
    vi.spyOn(chain, 'preparePayment').mockResolvedValue({
      account: address,
      contract,
      balance: 3_000_000_000_000_000_000n,
      gasLimit: 100_000n,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 0n,
      maxNetworkFee: 2_000_000_000_000_000n,
    })
    vi.spyOn(chain, 'sendPayment').mockImplementation(async (_batch, _quote, onSubmitted) => {
      onSubmitted(hash)
      throw new Error('Timed out waiting for confirmation')
    })

    const user = userEvent.setup()
    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: /recipient address 1/i }), {
      target: { value: alice },
    })
    fireEvent.change(screen.getByRole('textbox', { name: /amount in usdc 1/i }), {
      target: { value: '1' },
    })
    await user.click(screen.getByRole('button', { name: /connect wallet/i }))
    await user.click(screen.getByRole('button', { name: /review batch/i }))
    await user.click(screen.getByRole('button', { name: /confirm & pay/i }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not verified yet/i))
    expect(screen.queryByRole('button', { name: /confirm & pay/i })).toBeNull()
    expect(screen.getByRole('button', { name: /review batch/i }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(screen.getByRole('button', { name: /retry receipt/i })).toBeTruthy()
    vi.spyOn(chain, 'loadPayment').mockResolvedValue({
      hash,
      sender: address,
      payments: [{ recipient: bob, amount: 1_000_000_000_000_000_000n, index: 0 }],
      blockNumber: 1n,
    })
    await user.click(screen.getByRole('button', { name: /retry receipt/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/do not match the reviewed batch/i))
    expect(screen.queryByText(/All payments confirmed/i)).toBeNull()
  })

  it('allows a fresh batch only after a transaction is confirmed reverted', async () => {
    const hash = `0x${'b'.repeat(64)}`
    window.history.replaceState(null, '', `/?tx=${hash}`)
    vi.spyOn(chain, 'loadPayment').mockRejectedValue(new RevertedPaymentError())
    render(<App />)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/reverted/i))
    expect(screen.getByText(/Transaction failed\. No payouts were sent\./i)).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: /start new batch/i }))
    expect(window.location.search).toBe('')
  })

  it('does not suggest retrying receipt when the submitted batch reverted', async () => {
    const contract = '0x3333333333333333333333333333333333333333' as const
    const address = '0x1111111111111111111111111111111111111111' as const
    const hash = `0x${'c'.repeat(64)}` as const
    vi.spyOn(chain, 'configuredContract').mockReturnValue(contract)
    vi.spyOn(chain, 'connectWallet').mockResolvedValue(address)
    vi.spyOn(chain, 'preparePayment').mockResolvedValue({
      account: address,
      contract,
      balance: 3_000_000_000_000_000_000n,
      gasLimit: 100_000n,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 0n,
      maxNetworkFee: 2_000_000_000_000_000n,
    })
    vi.spyOn(chain, 'sendPayment').mockImplementation(async (_batch, _quote, onSubmitted) => {
      onSubmitted(hash)
      throw new RevertedPaymentError()
    })
    const user = userEvent.setup()
    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: /recipient address 1/i }), {
      target: { value: alice },
    })
    fireEvent.change(screen.getByRole('textbox', { name: /amount in usdc 1/i }), {
      target: { value: '1' },
    })
    await user.click(screen.getByRole('button', { name: /connect wallet/i }))
    await user.click(screen.getByRole('button', { name: /review batch/i }))
    await user.click(screen.getByRole('button', { name: /confirm & pay/i }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/reverted/i))
    expect(screen.getByRole('alert').textContent).not.toMatch(/retry receipt/i)
    expect(screen.getByRole('button', { name: /start new batch/i })).toBeTruthy()
  })

  it('shows a confirmed receipt from a share link with correct singular wording', async () => {
    const hash = `0x${'d'.repeat(64)}` as const
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    window.history.replaceState(null, '', `/?tx=${hash}`)
    vi.spyOn(chain, 'loadPayment').mockResolvedValue({
      hash,
      sender: '0x1111111111111111111111111111111111111111',
      payments: [{ recipient: bob, amount: 10_000_000_000_000_000n, index: 0 }],
      blockNumber: 42n,
    })
    render(<App />)

    expect(await screen.findByRole('heading', { name: /all payments confirmed/i })).toBeTruthy()
    expect(screen.getByText(/confirmed on arc mainnet, block 42/i)).toBeTruthy()
    expect(screen.getByText(/paid 1 recipient in one transaction/i)).toBeTruthy()
    expect(screen.getByText('1. 0x2222...2222')).toBeTruthy()
    expect(screen.getByText('0.01 USDC')).toBeTruthy()
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  })

  it('states plainly where recipient data goes', () => {
    render(<App />)
    expect(screen.getByRole('link', { name: /arc payrun home/i })).toBeTruthy()
    expect(screen.getByText(/sent to Arc RPC for the gas estimate/i)).toBeTruthy()
    expect(screen.queryByText(/never leaves your browser|nothing is uploaded|without trusting/i)).toBeNull()
  })
})
