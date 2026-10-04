import { useEffect, useMemo, useState } from 'react'
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  http,
  isAddress,
  keccak256,
} from 'viem'
import type { Address, Chain, Hash } from 'viem'
import { assertMatchesReviewedBatch } from '../lib/chain'
import { ARC_BATCH_RUNTIME_CODE } from '../lib/contractCode'
import { arcFeeCaps } from '../lib/fees'
import { arcMainnet, arcTestnet } from '../lib/networks'
import { validatePayouts } from '../lib/payouts'
import type { Batch } from '../lib/payouts'
import { batchAbi, parsePaidReceipt } from '../lib/receipts'
import { connectToChain, injectedWallet, selectChain } from '../lib/wallet'
import { validateArtifact, verifyRuntime } from './artifact'
import type { CompiledArtifact } from './artifact'

export type LabNetwork = 'testnet' | 'mainnet'

const networks = {
  testnet: { chain: arcTestnet, rpcPath: '/arc-testnet-rpc', label: 'Arc Testnet', currency: 'testnet USDC' },
  mainnet: { chain: arcMainnet, rpcPath: '/arc-rpc', label: 'Arc Mainnet', currency: 'USDC' },
} as const
const artifactPath = '/artifacts/contracts/ArcBatch.sol/ArcBatch.json'
const MAINNET_CONFIRMATION = 'DEPLOY ON MAINNET'

function createLabClient(chain: Chain, rpcPath: string) {
  return createPublicClient({ chain, transport: http(new URL(rpcPath, window.location.origin).toString()) })
}
type LabClient = ReturnType<typeof createLabClient>

type GasQuote = {
  balance: bigint
  gasLimit: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  maximumCost: bigint
}
type PayoutQuote = { batch: Batch; gas: GasQuote; recipientBefore: bigint }

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function matchesVerifiedCode(artifact: CompiledArtifact): boolean {
  return artifact.deployedBytecode.toLowerCase() === ARC_BATCH_RUNTIME_CODE.toLowerCase()
}

async function assertNetwork(client: LabClient, chain: Chain) {
  const chainId = await client.getChainId()
  if (chainId !== chain.id) {
    throw new Error(`Refusing to use RPC on chain ${chainId}; expected ${chain.name} ${chain.id}`)
  }
}

async function quoteGas(
  client: LabClient,
  currency: string,
  gasEstimate: bigint,
  value: bigint,
  account: Address,
): Promise<GasQuote> {
  const { maxFeePerGas, maxPriorityFeePerGas } = arcFeeCaps(
    await client.estimateFeesPerGas({ type: 'eip1559' }),
  )
  const gasLimit = (gasEstimate * 120n) / 100n + 1n
  const maximumCost = value + gasLimit * maxFeePerGas
  const balance = await client.getBalance({ address: account })
  if (balance < maximumCost) {
    throw new Error(`Not enough ${currency}: need up to ${formatUnits(maximumCost, 18)} including gas; wallet has ${formatUnits(balance, 18)}`)
  }
  return { balance, gasLimit, maxFeePerGas, maxPriorityFeePerGas, maximumCost }
}

function DeployLab({ network = 'testnet' }: { network?: LabNetwork }) {
  const config = networks[network]
  const mainnet = network === 'mainnet'
  const client = useMemo(() => createLabClient(config.chain, config.rpcPath), [config])
  const localOnly = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  const [artifact, setArtifact] = useState<CompiledArtifact | null>(null)
  const [account, setAccount] = useState<Address | null>(null)
  const [contract, setContract] = useState<Address | null>(null)
  const [existingAddress, setExistingAddress] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [secondRecipient, setSecondRecipient] = useState('')
  const [deployQuote, setDeployQuote] = useState<GasQuote | null>(null)
  const [payoutQuote, setPayoutQuote] = useState<PayoutQuote | null>(null)
  const [deployHash, setDeployHash] = useState<Hash | null>(null)
  const [payoutHash, setPayoutHash] = useState<Hash | null>(null)
  const [verifiedPayout, setVerifiedPayout] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('Loading local contract artifact...')
  const [error, setError] = useState('')

  const deployable = !!artifact && (!mainnet || matchesVerifiedCode(artifact))
  const confirmed = !mainnet || confirmation === MAINNET_CONFIRMATION

  useEffect(() => {
    if (!localOnly) return
    let active = true
    fetch(artifactPath)
      .then(async (response) => {
        if (!response.ok) throw new Error('Compile locally with npm test first')
        return validateArtifact(await response.json())
      })
      .then((compiled) => {
        if (!active) return
        setArtifact(compiled)
        if (!mainnet) {
          setStatus('Compiled contract ready. Connect your test wallet.')
        } else if (matchesVerifiedCode(compiled)) {
          setStatus('Compiled contract matches verified ArcBatch bytecode. Connect your wallet.')
        } else {
          setError('Local artifact differs from the verified ArcBatch bytecode. Recompile with npm test; do not deploy.')
          setStatus('Mainnet deployment blocked')
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(`Local artifact unavailable: ${message(cause)}`)
          setStatus('Deployment blocked')
        }
      })
    return () => {
      active = false
    }
  }, [localOnly, mainnet])

  function link(hash: Hash): string {
    return `${config.chain.blockExplorers.default.url}/tx/${hash}`
  }

  async function signer() {
    if (!account) throw new Error('Connect a wallet first')
    await selectChain(config.chain)
    const wallet = createWalletClient({ chain: config.chain, transport: custom(injectedWallet()) })
    const [active] = await wallet.getAddresses()
    if (active?.toLowerCase() !== account.toLowerCase()) {
      throw new Error('Wallet account changed. Reconnect before signing.')
    }
    if ((await wallet.getChainId()) !== config.chain.id) {
      throw new Error(`Wallet is not on ${config.label}`)
    }
    return wallet
  }

  async function connect() {
    setBusy(true)
    setError('')
    setDeployQuote(null)
    setPayoutQuote(null)
    setAccount(null)
    try {
      const address = await connectToChain(config.chain)
      await assertNetwork(client, config.chain)
      const balance = await client.getBalance({ address })
      setAccount(address)
      setStatus(`Connected to ${config.label}. Balance: ${formatUnits(balance, 18)} ${config.currency}.`)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  async function estimateDeploy() {
    if (!account || !artifact || !deployable || !confirmed) return
    setBusy(true)
    setError('')
    try {
      await assertNetwork(client, config.chain)
      const estimate = await client.estimateGas({ account, data: artifact.bytecode })
      const quote = await quoteGas(client, config.currency, estimate, 0n, account)
      setDeployQuote(quote)
      setStatus('Deployment quote ready. Review it, then approve in MetaMask.')
    } catch (cause) {
      setError(`Cannot prepare deployment: ${message(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  async function deploy() {
    if (!artifact || !account || !deployQuote || deployHash || !deployable || !confirmed) return
    setBusy(true)
    setError('')
    try {
      const wallet = await signer()
      await assertNetwork(client, config.chain)
      const estimate = await client.estimateGas({ account, data: artifact.bytecode })
      const current = await quoteGas(client, config.currency, estimate, 0n, account)
      if (current.gasLimit > deployQuote.gasLimit || current.maxFeePerGas > deployQuote.maxFeePerGas) {
        setDeployQuote(null)
        throw new Error('Network fee increased. Prepare deployment again before signing.')
      }
      const hash = await wallet.deployContract({
        account,
        chain: config.chain,
        abi: batchAbi,
        bytecode: artifact.bytecode,
        gas: deployQuote.gasLimit,
        maxFeePerGas: deployQuote.maxFeePerGas,
        maxPriorityFeePerGas: deployQuote.maxPriorityFeePerGas,
      })
      setDeployHash(hash)
      setDeployQuote(null)
      setStatus(`Deployment submitted. Waiting for ${config.label} confirmation...`)
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
      if (receipt.status !== 'success' || !receipt.contractAddress) {
        throw new Error('Deployment reverted; no contract was created')
      }
      const code = await client.getCode({ address: receipt.contractAddress })
      verifyRuntime(code, artifact)
      setContract(getAddress(receipt.contractAddress))
      setStatus('Deployment confirmed. Runtime bytecode matches local ArcBatch compilation.')
    } catch (cause) {
      setError(`Deployment not verified: ${message(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  async function useExisting() {
    if (!artifact || !deployable || !isAddress(existingAddress)) {
      setError(`Enter a valid ${config.label} contract address`)
      return
    }
    setBusy(true)
    setError('')
    try {
      await assertNetwork(client, config.chain)
      const address = getAddress(existingAddress)
      verifyRuntime(await client.getCode({ address }), artifact)
      setContract(address)
      setStatus(`Existing ${config.label} contract verified against local runtime bytecode.`)
    } catch (cause) {
      setError(`Existing deployment rejected: ${message(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  async function estimatePayout() {
    if (mainnet || !account || !contract || !artifact) return
    setBusy(true)
    setError('')
    setPayoutQuote(null)
    try {
      await assertNetwork(client, config.chain)
      verifyRuntime(await client.getCode({ address: contract }), artifact)
      const batch = validatePayouts(
        [
          { address: account, amount: '0.001' },
          { address: secondRecipient, amount: '0.001' },
        ],
        contract,
      )
      const estimate = await client.estimateContractGas({
        account,
        address: contract,
        abi: batchAbi,
        functionName: 'pay',
        args: [
          batch.payouts.map((item) => item.address),
          batch.payouts.map((item) => item.units),
        ],
        value: batch.total,
      })
      const gas = await quoteGas(client, config.currency, estimate, batch.total, account)
      const recipientBefore = await client.getBalance({ address: batch.payouts[1].address })
      setPayoutQuote({ batch, gas, recipientBefore })
      setStatus('Tiny payout quote ready. Check recipient and amount before signing.')
    } catch (cause) {
      setError(`Cannot prepare test payout: ${message(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  async function pay() {
    if (mainnet || !account || !contract || !payoutQuote || payoutHash) return
    setBusy(true)
    setError('')
    try {
      const wallet = await signer()
      await assertNetwork(client, config.chain)
      const { batch, gas, recipientBefore } = payoutQuote
      if (secondRecipient.toLowerCase() !== batch.payouts[1].address.toLowerCase()) {
        throw new Error('Recipient changed. Review the test payout again.')
      }
      const estimate = await client.estimateContractGas({
        account,
        address: contract,
        abi: batchAbi,
        functionName: 'pay',
        args: [
          batch.payouts.map((item) => item.address),
          batch.payouts.map((item) => item.units),
        ],
        value: batch.total,
      })
      const current = await quoteGas(client, config.currency, estimate, batch.total, account)
      if (current.gasLimit > gas.gasLimit || current.maxFeePerGas > gas.maxFeePerGas) {
        setPayoutQuote(null)
        throw new Error('Network fee increased. Review the test payout again.')
      }
      const hash = await wallet.writeContract({
        account,
        chain: config.chain,
        address: contract,
        abi: batchAbi,
        functionName: 'pay',
        args: [
          batch.payouts.map((item) => item.address),
          batch.payouts.map((item) => item.units),
        ],
        value: batch.total,
        gas: gas.gasLimit,
        maxFeePerGas: gas.maxFeePerGas,
        maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
      })
      setPayoutHash(hash)
      setPayoutQuote(null)
      setStatus('Payout submitted. Verifying receipt and recipient balance...')
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
      const payments = parsePaidReceipt(receipt, contract, account)
      assertMatchesReviewedBatch(payments, batch)
      const after = await client.getBalance({ address: batch.payouts[1].address })
      if (after - recipientBefore !== batch.payouts[1].units) {
        throw new Error('Recipient balance change does not match the confirmed payment event')
      }
      setVerifiedPayout(true)
      setStatus('Testnet smoke test passed: 2 onchain payments and recipient balance verified.')
    } catch (cause) {
      setError(`Test payout not verified: ${message(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="lab">
      <div className={mainnet ? 'lab-banner mainnet' : 'lab-banner'}>
        Local only: {config.label}, {mainnet ? 'real USDC' : 'test funds only'}
      </div>
      <header><a href="/">arc<strong>payrun</strong>.</a><span>Local deploy helper, chain {config.chain.id}</span></header>
      <h1>{mainnet ? 'Arc Mainnet deploy' : 'Arc Testnet lab'}</h1>
      <p className="lab-intro">
        {mainnet
          ? 'Deploy only the exact ArcBatch bytecode already verified on Arc Testnet. MetaMask signs; this page never reads private keys or uploads your source.'
          : 'Deploy locally compiled code and verify a tiny two-recipient payout. MetaMask signs every transaction; this page never reads private keys or sends your source to a third party.'}
      </p>
      {!localOnly && <p role="alert" className="lab-error">This helper only runs on localhost or 127.0.0.1. Do not host it publicly.</p>}
      {error && <p role="alert" className="lab-error">{error}</p>}
      <p role="status" className="lab-status">{status}</p>

      <section className="lab-card">
        <h2>{mainnet ? 'Deployment wallet' : 'Test wallet'}</h2>
        <p>{mainnet ? 'Use your funded MetaMask account on Arc Mainnet. No private-key export.' : 'Use a dedicated, faucet-funded MetaMask account. No private-key export.'}</p>
        {account && <p className="lab-data">Account <code>{account}</code></p>}
        <button onClick={connect} disabled={busy || !localOnly}>Connect MetaMask</button>
      </section>

      <section className="lab-card">
        <h2>Compiled ArcBatch contract</h2>
        <p>Only compiled code from this localhost project can be deployed. Check the wallet popup says <strong>{config.label}</strong>.</p>
        {artifact && <p className="lab-data">Creation bytecode hash <code>{keccak256(artifact.bytecode)}</code></p>}
        {mainnet && (
          <>
            <label htmlFor="confirmation">Type {MAINNET_CONFIRMATION} to allow a real-USDC gas payment</label>
            <input
              id="confirmation"
              value={confirmation}
              onChange={(event) => { setConfirmation(event.target.value); setDeployQuote(null) }}
              autoComplete="off"
              spellCheck={false}
              disabled={busy || !!deployHash}
            />
          </>
        )}
        <button onClick={estimateDeploy} disabled={!account || !deployable || !confirmed || !!contract || !!deployHash || busy}>Prepare deployment</button>
        {deployQuote && !deployHash && (
          <div className="lab-review">
            <p>Wallet balance: {formatUnits(deployQuote.balance, 18)} {config.currency}</p>
            <p>Maximum gas cost: {formatUnits(deployQuote.maximumCost, 18)} {config.currency}</p>
            <button onClick={deploy} disabled={busy || !confirmed}>Deploy contract in MetaMask</button>
          </div>
        )}
        {deployHash && <p className="lab-data">Deployment transaction <a href={link(deployHash)} target="_blank" rel="noreferrer">{deployHash}</a></p>}
        {contract && <p className="lab-success">Verified contract <code>{contract}</code></p>}
        {!contract && (
          <div className="lab-existing">
            <label htmlFor="existing">Already deployed? Verify its {config.label} contract address</label>
            <div>
              <input id="existing" value={existingAddress} onChange={(event) => setExistingAddress(event.target.value)} placeholder="0x..." />
              <button onClick={useExisting} disabled={!deployable || busy}>Verify existing</button>
            </div>
          </div>
        )}
      </section>

      {mainnet ? (
        <section className="lab-card">
          <h2>First real payout</h2>
          <p>Use the Arc Payrun app, not this lab. Put the verified address in <code>.env.local</code>, restart <code>npm run dev</code>, then send a small payout from the main page.</p>
          {contract && <p className="lab-data"><code>VITE_ARC_BATCH_ADDRESS={contract}</code></p>}
        </section>
      ) : (
        <section className="lab-card">
          <h2>Two-recipient smoke test</h2>
          <p>This sends 0.001 <strong>testnet</strong> USDC back to your connected account and 0.001 to a second account you control. Paste your second account address; no real USDC is used.</p>
          <label htmlFor="recipient">Second test wallet address</label>
          <input id="recipient" value={secondRecipient} onChange={(event) => { setSecondRecipient(event.target.value); setPayoutQuote(null) }} placeholder="0x..." disabled={busy || !!payoutHash} />
          <button onClick={estimatePayout} disabled={!contract || !account || !secondRecipient || !!payoutHash || busy}>Review tiny payout</button>
          {payoutQuote && !payoutHash && (
            <div className="lab-review">
              <p>Recipients: <code>{account}</code> and <code>{payoutQuote.batch.payouts[1].address}</code></p>
              <p>Total: 0.002 testnet USDC + maximum gas {formatUnits(payoutQuote.gas.maximumCost - payoutQuote.batch.total, 18)} testnet USDC</p>
              <button onClick={pay} disabled={busy}>Send test payout in MetaMask</button>
            </div>
          )}
          {payoutHash && <p className="lab-data">Payout transaction <a href={link(payoutHash)} target="_blank" rel="noreferrer">{payoutHash}</a></p>}
          {verifiedPayout && <p className="lab-success">Verified: exact events and second recipient balance change.</p>}
        </section>
      )}
      <footer>
        {mainnet ? 'Mainnet mode spends real USDC for gas. Verify every wallet popup.' : 'No mainnet signing in testnet mode.'}{' '}
        <a href="https://docs.arc.io/arc/references/connect-to-arc" target="_blank" rel="noreferrer">Arc wallet docs</a>
      </footer>
    </main>
  )
}

export default DeployLab
