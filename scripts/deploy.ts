import { network } from 'hardhat'

const { viem } = await network.create()
const publicClient = await viem.getPublicClient()
const chainId = await publicClient.getChainId()
if (![31337, 5042, 5042002].includes(chainId)) {
  throw new Error(`Refusing to deploy on unexpected chain ${chainId}`)
}

const batch = await viem.deployContract('ArcBatch')
const code = await publicClient.getCode({ address: batch.address })
if (!code || code === '0x') {
  throw new Error(`ArcBatch deployment at ${batch.address} is not confirmed`)
}
console.log(`ArcBatch deployed on chain ${chainId}: ${batch.address}`)
