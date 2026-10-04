import { parseGwei } from 'viem'

export function arcFeeCaps(fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }) {
  const minimumFee = parseGwei('20') + fees.maxPriorityFeePerGas
  return {
    maxFeePerGas: fees.maxFeePerGas > minimumFee ? fees.maxFeePerGas : minimumFee,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  }
}
