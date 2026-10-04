import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPublicClient } from 'viem'
import { arcMainnet } from './networks'
import { ARC_MAINNET_RPC, arcMainnetTransport } from './rpc'

const origin = 'https://arcbatch.example'
const proxyUrl = `${origin}/arc-rpc`
const directUrl = new URL(ARC_MAINNET_RPC).toString()

afterEach(() => {
  vi.unstubAllGlobals()
})

function chainIdResponse(init?: RequestInit): Response {
  const request = JSON.parse(String(init?.body)) as { id: number }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x13b2' }), {
    headers: { 'content-type': 'application/json' },
  })
}

describe('Arc mainnet RPC transport', () => {
  it('uses the same-origin proxy first so third-party arc.io blockers cannot break the app', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => chainIdResponse(init))
    vi.stubGlobal('fetch', fetch)
    const client = createPublicClient({ chain: arcMainnet, transport: arcMainnetTransport(origin) })

    await expect(client.getChainId()).resolves.toBe(5042)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([proxyUrl])
  })

  it.each([
    ['missing route', 404],
    ['static-site fallback page', 200],
  ])('falls back to Arc public RPC when the host serves a %s', async (_case, status) => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) =>
      url === proxyUrl
        ? new Response('<!doctype html><title>Not RPC</title>', {
            status,
            headers: { 'content-type': 'text/html' },
          })
        : chainIdResponse(init),
    )
    vi.stubGlobal('fetch', fetch)
    const client = createPublicClient({ chain: arcMainnet, transport: arcMainnetTransport(origin) })

    await expect(client.getChainId()).resolves.toBe(5042)
    expect(fetch.mock.calls[0]?.[0]).toBe(proxyUrl)
    expect(fetch.mock.calls.at(-1)?.[0]).toBe(directUrl)
  })
})
