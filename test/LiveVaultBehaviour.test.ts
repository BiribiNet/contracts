import { viem } from "hardhat";

import { expect } from "chai";
import { encodeFunctionData, parseUnits, zeroAddress, type Address, type Hex } from "viem";

import { customErrorPattern } from "./helpers/customErrorPattern";

/**
 * Behaviour that implementation `0x6e84c0ED…f3cC` (Arbitrum One, 2026-11-05) added besides `setFlatWithdrawFee`,
 * found by bytecode reconstruction (`reports/vault-2026-11-05/`) and ported unchanged:
 *  - deposit/mint: the receiver's resulting position must exceed the fee (top-ups below it are accepted);
 *  - enqueue: a request worth no more than the fee reverts `WithdrawalTooSmall`;
 *  - a request whose receiver refuses the transfer pays the fee in shares to infra (`SkippedWithdrawalFeeCharged`);
 *  - shares of an owner with a queued request cannot be transferred (`SharesLockedByPendingWithdrawal`);
 *  - `drainWithdrawalQueue` also waits for `lockedBetLiquidity == 0`.
 */
const MARKETS = [
    { label: "6 decimals", token: "MockUSDC", decimals: 6 },
    { label: "18 decimals", token: "MockDAI", decimals: 18 },
] as const;

async function deployVault(token: "MockUSDC" | "MockDAI" | "MockBlockedRecipient", decimals: number) {
    const [admin, alice, bob, carol] = await viem.getWalletClients();
    const asset = await viem.deployContract(token);
    const engine = await viem.deployContract("MockEngine");
    const impl = await viem.deployContract("BankVault4626");
    const proxy = await viem.deployContract("ERC1967Proxy", [
        impl.address,
        initData(asset.address, engine.address, admin.account.address, parseUnits("1", decimals)),
    ]);
    const vault = await viem.getContractAt("BankVault4626", proxy.address);
    for (const wallet of [alice, bob]) {
        await asset.write.mint([wallet.account.address, parseUnits("1000", decimals)]);
        await asset.write.approve([vault.address, parseUnits("1000", decimals)], { account: wallet.account });
    }
    return { admin, alice, bob, carol, asset, engine, vault, publicClient: await viem.getPublicClient() };
}

describe("BankVault4626 behaviour of implementation 0x6e84…f3cC", function () {
    for (const market of MARKETS) {
        describe(market.label, function () {
            const unit = (value: string) => parseUnits(value, market.decimals);

            it("should accept a top-up below the fee when the receiver's position then exceeds it", async function () {
                const { admin, alice, vault } = await deployVault(market.token, market.decimals);
                await vault.write.setFlatWithdrawFee([unit("10")], { account: admin.account });
                await expect(vault.write.deposit([0n, alice.account.address], { account: alice.account }))
                    .to.be.rejectedWith(customErrorPattern("DepositTooSmall()"));
                await expect(vault.write.deposit([unit("10"), alice.account.address], { account: alice.account }))
                    .to.be.rejectedWith(customErrorPattern("DepositTooSmall()"));
                await vault.write.deposit([unit("20"), alice.account.address], { account: alice.account });

                await vault.write.deposit([unit("1"), alice.account.address], { account: alice.account });
                await vault.write.mint([await vault.read.previewDeposit([unit("1")]), alice.account.address], { account: alice.account });
                await expect(vault.write.mint([0n, alice.account.address], { account: alice.account }))
                    .to.be.rejectedWith(customErrorPattern("DepositTooSmall()"));
                expect(await vault.read.convertToAssets([await vault.read.balanceOf([alice.account.address])])).to.be.closeTo(unit("22"), 10n);
            });

            it("should revert WithdrawalTooSmall when the queued request is worth no more than the fee", async function () {
                const { admin, alice, vault } = await deployVault(market.token, market.decimals);
                await vault.write.deposit([unit("50"), alice.account.address], { account: alice.account });
                await vault.write.setFlatWithdrawFee([unit("5")], { account: admin.account });
                // 10% of 50 = 5 = fee.
                await expect(vault.write.redeemBps([1_000, alice.account.address, alice.account.address], { account: alice.account }))
                    .to.be.rejectedWith(customErrorPattern("WithdrawalTooSmall()"));
                await expect(vault.write.withdraw([unit("5"), alice.account.address, alice.account.address], { account: alice.account }))
                    .to.be.rejectedWith(customErrorPattern("WithdrawalTooSmall()"));
                await vault.write.redeemBps([1_001, alice.account.address, alice.account.address], { account: alice.account });
                expect((await vault.read.pendingWithdrawalStatus([alice.account.address]))[1]).to.equal(true);
            });

            it("should revert SharesLockedByPendingWithdrawal on a transfer by an owner with a queued request, and allow it once processed", async function () {
                const { alice, bob, engine, vault } = await deployVault(market.token, market.decimals);
                await vault.write.deposit([unit("50"), alice.account.address], { account: alice.account });
                await vault.write.deposit([unit("50"), bob.account.address], { account: bob.account });
                await vault.write.redeemBps([5_000, alice.account.address, alice.account.address], { account: alice.account });

                await expect(vault.write.transfer([bob.account.address, 1n], { account: alice.account }))
                    .to.be.rejectedWith(customErrorPattern("SharesLockedByPendingWithdrawal()"));
                await vault.write.approve([bob.account.address, 1n], { account: alice.account });
                await expect(vault.write.transferFrom([alice.account.address, bob.account.address, 1n], { account: bob.account }))
                    .to.be.rejectedWith(customErrorPattern("SharesLockedByPendingWithdrawal()"));
                // Zero-value and self transfers are not blocked; others' shares still move; deposits still mint.
                await vault.write.transfer([bob.account.address, 0n], { account: alice.account });
                await vault.write.transfer([alice.account.address, 1n], { account: alice.account });
                await vault.write.transfer([alice.account.address, 1n], { account: bob.account });
                await vault.write.deposit([unit("2"), alice.account.address], { account: bob.account });

                await engine.write.processWithdrawals([vault.address, 10n]);
                await vault.write.transfer([bob.account.address, 1n], { account: alice.account });
            });

            it("should block drainWithdrawalQueue while lockedBetLiquidity is not zero", async function () {
                const { alice, bob, engine, vault } = await deployVault(market.token, market.decimals);
                await vault.write.deposit([unit("50"), alice.account.address], { account: alice.account });
                await vault.write.redeemBps([5_000, alice.account.address, alice.account.address], { account: alice.account });
                await vault.write.placeBet([unit("1"), "0x", zeroAddress], { account: bob.account });
                await expect(vault.write.drainWithdrawalQueue([10n], { account: bob.account }))
                    .to.be.rejectedWith(customErrorPattern("WithdrawalBlockedDuringResolution()"));
                await engine.write.releaseFromVault([vault.address, unit("1")]);
                expect(await vault.read.lockedBetLiquidity()).to.equal(0n);
            });
        });
    }

    it("should charge the fee in shares to infra (SkippedWithdrawalFeeCharged) when the receiver refuses the transfer", async function () {
        const { admin, alice, carol, asset, engine, vault, publicClient } = await deployVault("MockBlockedRecipient", 6);
        const unit = (value: string) => parseUnits(value, 6);
        await vault.write.setFlatWithdrawFee([unit("2")], { account: admin.account });
        await vault.write.deposit([unit("50"), alice.account.address], { account: alice.account });
        await asset.write.setBlocked([carol.account.address, true]);
        await vault.write.redeemBps([5_000, carol.account.address, alice.account.address], { account: alice.account });

        const infra = await engine.read.INFRA_RECIPIENT();
        const sharesBefore = await vault.read.balanceOf([alice.account.address]);
        const feeShares = await vault.read.previewWithdraw([unit("2")]);
        const requestId = (await vault.read.pendingWithdrawalStatus([alice.account.address]))[0];
        const hash = await engine.write.processWithdrawals([vault.address, 10n]);
        const { blockHash } = await publicClient.waitForTransactionReceipt({ hash });

        expect(await vault.read.balanceOf([alice.account.address])).to.equal(sharesBefore - feeShares);
        expect(await vault.read.balanceOf([infra])).to.equal(feeShares);
        expect(await asset.read.balanceOf([carol.account.address])).to.equal(0n);
        expect((await vault.read.pendingWithdrawalStatus([alice.account.address]))[1]).to.equal(false);
        const charged = await vault.getEvents.SkippedWithdrawalFeeCharged({}, { blockHash });
        expect(charged).to.have.length(1);
        expect(charged[0].args).to.deep.equal({
            requestId, owner: alice.account.address, recipient: infra, sharesCharged: feeShares, fee: unit("2"),
        });
        expect(await vault.getEvents.WithdrawalSkipped({}, { blockHash })).to.have.length(1);
    });
});

function initData(asset: Address, engine: Address, admin: Address, minBet: bigint): Hex {
    return encodeFunctionData({
        abi: [{
            type: "function", name: "initialize", stateMutability: "nonpayable", outputs: [],
            inputs: [{
                name: "p", type: "tuple", components: [
                    { name: "assetToken", type: "address" }, { name: "name", type: "string" }, { name: "symbol", type: "string" },
                    { name: "marketId", type: "uint32" }, { name: "engine", type: "address" }, { name: "admin", type: "address" },
                    { name: "minBet", type: "uint256" }, { name: "sideBetController", type: "address" },
                ],
            }],
        }],
        functionName: "initialize",
        args: [{ assetToken: asset, name: "Bank", symbol: "b", marketId: 1, engine, admin, minBet, sideBetController: zeroAddress }],
    });
}
