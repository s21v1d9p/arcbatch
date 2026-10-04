import { getAddress, isAddress, parseUnits, zeroAddress } from 'viem'
import type { Address } from 'viem'

export type PayoutInput = { address: string; amount: string }
export type Payout = { address: Address; amount: string; units: bigint }
export type Batch = { payouts: Payout[]; total: bigint }

const MAX_RECIPIENTS = 25
const MAX_UINT256 = 2n ** 256n - 1n
const CSV_PAIR = /^\s*("(?:[^"]|"")*"|[^,"]*)\s*,\s*("(?:[^"]|"")*"|[^,"]*)\s*$/

function csvValue(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('"')
    ? trimmed.slice(1, -1).replaceAll('""', '"').trim()
    : trimmed
}

export function parseCsvRows(text: string): PayoutInput[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const rows: PayoutInput[] = []
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    const match = line.match(CSV_PAIR)
    if (!match) throw new Error(`Line ${index + 1}: expected address,amount CSV columns`)
    const [, address, amount] = match
    const row = { address: csvValue(address), amount: csvValue(amount) }
    if (rows.length === 0 && row.address.toLowerCase() === 'address' && row.amount.toLowerCase() === 'amount') {
      continue
    }
    rows.push(row)
  }
  if (rows.length === 0) throw new Error('Enter at least one payout')
  return rows
}

export function validatePayouts(rows: PayoutInput[], contractAddress?: string): Batch {
  if (rows.length === 0 || rows.length > MAX_RECIPIENTS) {
    throw new Error(`Enter 1 to ${MAX_RECIPIENTS} recipients`)
  }
  const payouts: Payout[] = []
  const seen = new Set<string>()
  let total = 0n
  for (const [index, row] of rows.entries()) {
    const addressText = row.address.trim()
    if (!isAddress(addressText) || addressText.toLowerCase() === zeroAddress) {
      throw new Error(`Row ${index + 1}: address must be a valid, nonzero EVM address`)
    }
    const address = getAddress(addressText)
    if (contractAddress && address.toLowerCase() === contractAddress.toLowerCase()) {
      throw new Error(`Row ${index + 1}: recipient is the payout contract`)
    }
    if (seen.has(address.toLowerCase())) {
      throw new Error(`Row ${index + 1}: duplicate recipient`)
    }
    seen.add(address.toLowerCase())

    const amount = row.amount.trim()
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amount)) {
      throw new Error(`Row ${index + 1}: amount must be positive USDC with up to 6 decimals`)
    }
    const units = parseUnits(amount, 6) * 10n ** 12n
    if (units === 0n || units > MAX_UINT256 || total + units > MAX_UINT256) {
      throw new Error(`Row ${index + 1}: amount exceeds valid USDC range`)
    }
    total += units
    payouts.push({ address, amount, units })
  }
  return { payouts, total }
}
