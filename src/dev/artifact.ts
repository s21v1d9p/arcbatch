import type { Hex } from 'viem'

export type CompiledArtifact = { bytecode: Hex; deployedBytecode: Hex }

export function validateArtifact(input: unknown): CompiledArtifact {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('ArcBatch compilation artifact is missing')
  }
  const value = input as Record<string, unknown>
  if (value._format !== 'hh3-artifact-1' || value.contractName !== 'ArcBatch') {
    throw new Error('Expected a locally compiled ArcBatch artifact')
  }
  if (
    typeof value.bytecode !== 'string' ||
    typeof value.deployedBytecode !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(value.bytecode) ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(value.deployedBytecode)
  ) {
    throw new Error('ArcBatch artifact has missing or invalid bytecode')
  }
  if (
    !Array.isArray(value.abi) ||
    !value.abi.some(
      (entry: unknown) =>
        entry &&
        typeof entry === 'object' &&
        'type' in entry &&
        'name' in entry &&
        'stateMutability' in entry &&
        entry.type === 'function' &&
        entry.name === 'pay' &&
        entry.stateMutability === 'payable',
    ) ||
    !value.abi.some(
      (entry: unknown) =>
        entry && typeof entry === 'object' && 'type' in entry && 'name' in entry &&
        entry.type === 'event' && entry.name === 'Paid',
    )
  ) {
    throw new Error('ArcBatch artifact must expose a payable pay function and Paid event')
  }
  return { bytecode: value.bytecode as Hex, deployedBytecode: value.deployedBytecode as Hex }
}

export function verifyRuntime(code: Hex | undefined, artifact: CompiledArtifact): void {
  if (!code || code === '0x') throw new Error('Deployment address has no contract code')
  if (code.toLowerCase() !== artifact.deployedBytecode.toLowerCase()) {
    throw new Error('Deployed runtime bytecode does not match the locally compiled ArcBatch contract')
  }
}
