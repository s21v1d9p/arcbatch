import hardhatKeystore from '@nomicfoundation/hardhat-keystore'
import hardhatNodeTestRunner from '@nomicfoundation/hardhat-node-test-runner'
import hardhatViem from '@nomicfoundation/hardhat-viem'
import { configVariable, defineConfig } from 'hardhat/config'

export default defineConfig({
  plugins: [hardhatKeystore, hardhatNodeTestRunner, hardhatViem],
  solidity: {
    version: '0.8.28',
    settings: { evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    arcTestnet: {
      type: 'http',
      chainType: 'l1',
      url: 'https://rpc.testnet.arc.io',
      accounts: [configVariable('ARC_DEPLOYER_PRIVATE_KEY')],
    },
    arcMainnet: {
      type: 'http',
      chainType: 'l1',
      url: 'https://rpc.mainnet.arc.io',
      accounts: [configVariable('ARC_DEPLOYER_PRIVATE_KEY')],
    },
  },
})
