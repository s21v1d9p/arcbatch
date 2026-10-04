import { describe, expect, it } from 'vitest'
import { validateArtifact, verifyRuntime } from './artifact'

const artifact = {
  _format: 'hh3-artifact-1',
  contractName: 'ArcBatch',
  abi: [
    { type: 'function', name: 'pay', stateMutability: 'payable', inputs: [] },
    { type: 'event', name: 'Paid', inputs: [] },
  ],
  bytecode: '0x60016000',
  deployedBytecode: '0x6001',
}

describe('local compilation artifact', () => {
  it('accepts the expected payable ArcBatch ABI and runtime code', () => {
    expect(validateArtifact(artifact).deployedBytecode).toBe('0x6001')
  })

  it('rejects wrong, uncompiled, or structurally invalid artifacts before deployment', () => {
    expect(() => validateArtifact({ ...artifact, contractName: 'Other' })).toThrow('ArcBatch')
    expect(() => validateArtifact({ ...artifact, bytecode: '0x' })).toThrow('bytecode')
    expect(() => validateArtifact({ ...artifact, abi: [] })).toThrow('payable')
  })

  it('rejects a deployed address with different runtime bytecode', () => {
    const compiled = validateArtifact(artifact)
    expect(() => verifyRuntime('0x6002', compiled)).toThrow('does not match')
    expect(() => verifyRuntime(undefined, compiled)).toThrow('no contract code')
    expect(() => verifyRuntime('0x6001', compiled)).not.toThrow()
  })
})
