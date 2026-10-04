import 'viem/window'
import { createWalletClient, custom, getAddress } from 'viem'
import type { Address, Chain } from 'viem'

export function injectedWallet() {
  const provider = window.ethereum
  if (!provider) throw new Error('No browser wallet detected. Install an EVM wallet to pay.')
  return provider
}

function isUnknownChain(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 4902
}

export async function selectChain(chain: Chain): Promise<void> {
  const provider = injectedWallet()
  const explorer = chain.blockExplorers?.default.url
  if (!explorer) throw new Error('Chain explorer URL is required to add a wallet network')
  const chainId = `0x${chain.id.toString(16)}`
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
  } catch (error) {
    if (!isUnknownChain(error)) throw error
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
          blockExplorerUrls: [explorer],
        },
      ],
    })
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
  }
}

export async function connectToChain(chain: Chain): Promise<Address> {
  const provider = injectedWallet()
  const client = createWalletClient({ chain, transport: custom(provider) })
  const [account] = await client.requestAddresses()
  if (!account) throw new Error('Wallet returned no account')
  await selectChain(chain)
  return getAddress(account)
}
