import { describe, expect, it } from 'vitest'
import { arcFeeCaps } from './fees'

describe('Arc fee caps', () => {
  it('covers the minimum 20 Gwei base fee plus priority', () => {
    expect(arcFeeCaps({ maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }))
      .toEqual({ maxFeePerGas: 21_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n })
  })

  it('retains a higher RPC-estimated fee instead of lowering it', () => {
    expect(arcFeeCaps({ maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 100_000_000n }))
      .toEqual({ maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 100_000_000n })
  })
})
