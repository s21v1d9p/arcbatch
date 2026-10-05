import { describe, expect, it } from 'vitest'
import vercelRaw from '../vercel.json?raw'
import manifestRaw from '../public/manifest.json?raw'

type HeaderRule = { source: string; headers: { key: string; value: string }[] }

const vercel = JSON.parse(vercelRaw) as { headers: HeaderRule[] }
const publicFiles = Object.keys(import.meta.glob('../public/*'))

function headersFor(source: string): Record<string, string> {
  const rule = vercel.headers.find((candidate) => candidate.source === source)
  return Object.fromEntries((rule?.headers ?? []).map((header) => [header.key, header.value]))
}

describe('hosting for Safe{Wallet}', () => {
  it('lets only Safe{Wallet} frame the site and keeps the other security headers', () => {
    const site = headersFor('/(.*)')
    expect(site['Content-Security-Policy']).toBe(
      "frame-ancestors 'self' https://app.safe.global; base-uri 'self'; object-src 'none'",
    )
    expect(site['X-Frame-Options']).toBeUndefined()
    expect(site['X-Content-Type-Options']).toBe('nosniff')
    expect(site['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
  })

  it('serves a manifest that Safe{Wallet} can read from another origin', () => {
    expect(headersFor('/manifest.json')).toEqual({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'X-Requested-With, content-type, Authorization',
    })
    const manifest = JSON.parse(manifestRaw) as {
      name: string
      description: string
      iconPath: string
      icons: { src: string; type: string; sizes: string }[]
    }
    expect(manifest.name).toBe('Arc Payrun')
    expect(manifest.description).toMatch(/Safe/)
    expect(publicFiles).toContain(`../public/${manifest.iconPath}`)
    expect(manifest.icons.map((icon) => `../public${icon.src}`).every((path) => publicFiles.includes(path))).toBe(true)
  })
})
