import { fallback, http } from 'viem'

export const ARC_RPC_PROXY_PATH = '/arc-rpc'
export const ARC_MAINNET_RPC = 'https://rpc.mainnet.arc.io'

// Common privacy lists block third-party arc.io requests, so the host proxy is tried first.
export function arcMainnetTransport(origin = globalThis.location?.origin) {
  const direct = http(ARC_MAINNET_RPC)
  if (!origin) return direct
  return fallback([http(new URL(ARC_RPC_PROXY_PATH, origin).toString()), direct])
}
