import { describe, expect, it } from 'vitest'
import { ARC_BATCH_RUNTIME_CODE } from './contractCode'

const artifacts = import.meta.glob<string>('/artifacts/contracts/ArcBatch.sol/ArcBatch.json', {
  eager: true,
  import: 'deployedBytecode',
})

describe('pinned ArcBatch runtime bytecode', () => {
  it('matches the current compiled contract and contains no coverage instrumentation', () => {
    const compiled = Object.values(artifacts)[0]
    expect(compiled, 'Run npm test so Hardhat compiles contracts first').toBeTypeOf('string')
    expect(compiled.toLowerCase()).toBe(ARC_BATCH_RUNTIME_CODE.toLowerCase())
    expect(ARC_BATCH_RUNTIME_CODE.toLowerCase()).not.toContain('c0bec0bec0bec0be')
  })
})
