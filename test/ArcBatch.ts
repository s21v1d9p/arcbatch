import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { network } from 'hardhat'
import { decodeEventLog, getAddress, parseUnits, zeroAddress } from 'viem'
import { parsePaidReceipt } from '../src/lib/receipts'

const { viem } = await network.create()
const one = parseUnits('1', 18)

describe('ArcBatch', () => {
  async function setup() {
    const [sender, first, second] = await viem.getWalletClients()
    const publicClient = await viem.getPublicClient()
    const batch = await viem.deployContract('ArcBatch')
    return { sender, first, second, publicClient, batch }
  }

  it('pays every recipient atomically and emits independently verifiable receipts', async () => {
    const { sender, first, second, publicClient, batch } = await setup()
    const beforeFirst = await publicClient.getBalance({ address: first.account.address })
    const beforeSecond = await publicClient.getBalance({ address: second.account.address })

    const hash = await batch.write.pay(
      [[first.account.address, second.account.address], [one, 2n * one]],
      { value: 3n * one },
    )
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    assert.equal(receipt.status, 'success')
    assert.equal(
      await publicClient.getBalance({ address: first.account.address }),
      beforeFirst + one,
    )
    assert.equal(
      await publicClient.getBalance({ address: second.account.address }),
      beforeSecond + 2n * one,
    )
    assert.equal(await publicClient.getBalance({ address: batch.address }), 0n)
    const events = receipt.logs
      .filter((log) => log.address.toLowerCase() === batch.address.toLowerCase())
      .map((log) => decodeEventLog({ abi: batch.abi, data: log.data, topics: log.topics }))
    assert.deepEqual(
      events.map((event) => event.args),
      [
        { sender: getAddress(sender.account.address), recipient: getAddress(first.account.address), amount: one, index: 0n },
        { sender: getAddress(sender.account.address), recipient: getAddress(second.account.address), amount: 2n * one, index: 1n },
      ],
    )
  })

  it('rejects empty, mismatched, zero, oversized, and underfunded batches', async () => {
    const { first, batch } = await setup()
    const address = first.account.address
    const invalid = [
      [[], [], 0n],
      [[address], [], one],
      [[zeroAddress], [one], one],
      [[address], [0n], 0n],
      [Array(26).fill(address), Array(26).fill(one), 26n * one],
      [[address], [one], one - 1n],
      [[address], [one], one + 1n],
    ] as const
    for (const [recipients, amounts, value] of invalid) {
      await assert.rejects(batch.write.pay([recipients, amounts], { value }))
    }
  })

  it('reverts all previous transfers if a later recipient rejects funds', async () => {
    const { first, publicClient, batch } = await setup()
    const rejector = await viem.deployContract('RejectFunds')
    const before = await publicClient.getBalance({ address: first.account.address })

    await assert.rejects(
      batch.write.pay(
        [[first.account.address, rejector.address], [one, one]],
        { value: 2n * one },
      ),
    )

    assert.equal(await publicClient.getBalance({ address: first.account.address }), before)
    assert.equal(await publicClient.getBalance({ address: batch.address }), 0n)
  })

  it('stays within a reasonable gas budget with the full 25 recipients', async () => {
    const { publicClient, batch } = await setup()
    const recipients = Array.from({ length: 25 }, (_, i) =>
      `0x${(1000 + i).toString(16).padStart(40, '0')}` as `0x${string}`,
    )
    const amounts = Array(25).fill(parseUnits('0.000001', 18)) as bigint[]
    const hash = await batch.write.pay([recipients, amounts], {
      value: 25n * amounts[0],
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    assert.equal(receipt.status, 'success')
    assert.ok(receipt.gasUsed < 3_000_000n, `batch used ${receipt.gasUsed} gas`)
    assert.equal(
      parsePaidReceipt(receipt, batch.address, (await viem.getWalletClients())[0].account.address)
        .length,
      25,
    )
  })

  it('keeps the payer receipt accurate when a recipient reenters with its own funds', async () => {
    const { sender, first, second, publicClient, batch } = await setup()
    const reenter = await viem.deployContract('ReenterFunds', [batch.address, second.account.address])
    const beforeFirst = await publicClient.getBalance({ address: first.account.address })
    const beforeSecond = await publicClient.getBalance({ address: second.account.address })

    const hash = await batch.write.pay(
      [[first.account.address, reenter.address], [one, one]],
      { value: 2n * one },
    )
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    const payments = parsePaidReceipt(receipt, batch.address, sender.account.address)
    assert.deepEqual(
      payments.map((payment) => [payment.recipient, payment.amount, payment.index]),
      [[getAddress(first.account.address), one, 0], [getAddress(reenter.address), one, 1]],
    )
    assert.equal(await publicClient.getBalance({ address: first.account.address }), beforeFirst + one)
    assert.equal(await publicClient.getBalance({ address: second.account.address }), beforeSecond + 1n)
    assert.equal(await publicClient.getBalance({ address: batch.address }), 0n)
  })
})
