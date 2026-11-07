import { viem } from "hardhat";

import { expect } from "chai";
import { encodeFunctionData, keccak256, parseUnits, toHex, zeroAddress, type Address, type Hex } from "viem";

import { customErrorPattern } from "./helpers/customErrorPattern";

/**
 * `setFlatWithdrawFee` as served on Arbitrum One by implementation `0x6e84c0ED…f3cC` (2026-11-05),
 * reconstructed in `reports/vault-2026-11-05/`: `BANK_ADMIN_ROLE`, refuses 0 (`ZeroAmount`) and a
 * non-empty queue (`WithdrawalQueueNotEmpty`), emits `FlatWithdrawFeeUpdated(previous, new)`.
 */
const BANK_ADMIN_ROLE = keccak256(toHex("BANK_ADMIN_ROLE"));
const MARKETS = [
    { label: "6 decimals", token: "MockUSDC", decimals: 6 },
    { label: "18 decimals", token: "MockDAI", decimals: 18 },
] as const;

async function deployVault(token: "MockUSDC" | "MockDAI", decimals: number) {
    const [admin, alice, bob, stranger] = await viem.getWalletClients();
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
    const publicClient = await viem.getPublicClient();
    return { admin, alice, bob, stranger, asset, engine, vault, publicClient };
}

describe("BankVault4626 setFlatWithdrawFee (implementation 0x6e84…f3cC)", function () {
    for (const market of MARKETS) {
        describe(market.label, function () {
            const unit = (value: string) => parseUnits(value, market.decimals);

            it("should start at one whole unit and emit FlatWithdrawFeeUpdated(previous, new) when the admin sets it", async function () {
                const { admin, vault, publicClient } = await deployVault(market.token, market.decimals);
                expect(await vault.read.flatWithdrawFee()).to.equal(unit("1"));

                const hash = await vault.write.setFlatWithdrawFee([unit("100")], { account: admin.account });
                await publicClient.waitForTransactionReceipt({ hash });
                const events = await vault.getEvents.FlatWithdrawFeeUpdated({}, { blockHash: (await publicClient.getTransactionReceipt({ hash })).blockHash });
                expect(events).to.have.length(1);
                expect(events[0].args).to.deep.equal({ previousFee: unit("1"), newFee: unit("100") });
                expect(await vault.read.flatWithdrawFee()).to.equal(unit("100"));

                // The mainnet probe values (1 wei, 1e30) are accepted too.
                await vault.write.setFlatWithdrawFee([1n], { account: admin.account });
                await vault.write.setFlatWithdrawFee([10n ** 30n], { account: admin.account });
                expect(await vault.read.flatWithdrawFee()).to.equal(10n ** 30n);
            });

            it("should revert AccessControlUnauthorizedAccount(BANK_ADMIN_ROLE) when the caller is not a bank admin", async function () {
                const { stranger, vault } = await deployVault(market.token, market.decimals);
                await expect(vault.write.setFlatWithdrawFee([unit("2")], { account: stranger.account }))
                    .to.be.rejectedWith(customErrorPattern("AccessControlUnauthorizedAccount(address,bytes32)"));
                await expect(vault.simulate.setFlatWithdrawFee([unit("2")], { account: stranger.account }))
                    .to.be.rejectedWith(new RegExp(BANK_ADMIN_ROLE.slice(2, 18), "i"));
                expect(await vault.read.flatWithdrawFee()).to.equal(unit("1"));
            });

            it("should revert ZeroAmount when the new fee is 0", async function () {
                const { admin, vault } = await deployVault(market.token, market.decimals);
                await expect(vault.write.setFlatWithdrawFee([0n], { account: admin.account }))
                    .to.be.rejectedWith(customErrorPattern("ZeroAmount()"));
            });

            it("should revert WithdrawalQueueNotEmpty while a request is queued, then accept once the queue is processed", async function () {
                const { admin, alice, engine, vault } = await deployVault(market.token, market.decimals);
                await vault.write.deposit([unit("50"), alice.account.address], { account: alice.account });
                await vault.write.redeemBps([5_000, alice.account.address, alice.account.address], { account: alice.account });

                await expect(vault.write.setFlatWithdrawFee([unit("5")], { account: admin.account }))
                    .to.be.rejectedWith(customErrorPattern("WithdrawalQueueNotEmpty()"));

                await engine.write.processWithdrawals([vault.address, 10n]);
                await vault.write.setFlatWithdrawFee([unit("5")], { account: admin.account });
                expect(await vault.read.flatWithdrawFee()).to.equal(unit("5"));
            });

            it("should revert DepositTooSmall on deposit/mint of a new position at or below the updated fee", async function () {
                const { admin, alice, vault } = await deployVault(market.token, market.decimals);
                await vault.write.setFlatWithdrawFee([unit("100")], { account: admin.account });

                await expect(vault.write.deposit([unit("100"), alice.account.address], { account: alice.account }))
                    .to.be.rejectedWith(customErrorPattern("DepositTooSmall()"));
                const sharesForFee = await vault.read.previewDeposit([unit("100")]);
                await expect(vault.write.mint([sharesForFee, alice.account.address], { account: alice.account }))
                    .to.be.rejectedWith(customErrorPattern("DepositTooSmall()"));

                await vault.write.deposit([unit("100") + 1n, alice.account.address], { account: alice.account });
                await vault.write.mint([await vault.read.previewDeposit([unit("101")]), admin.account.address], { account: alice.account });
                expect(await vault.read.balanceOf([admin.account.address])).to.be.gt(0n);
            });

            it("should charge the updated fee when the queue is processed", async function () {
                const { admin, alice, asset, engine, vault } = await deployVault(market.token, market.decimals);
                await vault.write.setFlatWithdrawFee([unit("3")], { account: admin.account });
                await vault.write.deposit([unit("50"), alice.account.address], { account: alice.account });

                const infra = await engine.read.INFRA_RECIPIENT();
                const before = await asset.read.balanceOf([alice.account.address]);
                await vault.write.redeemBps([10_000, alice.account.address, alice.account.address], { account: alice.account });
                await engine.write.processWithdrawals([vault.address, 10n]);

                expect(await asset.read.balanceOf([infra])).to.equal(unit("3"));
                expect(await asset.read.balanceOf([alice.account.address])).to.equal(before + unit("50") - unit("3"));
                expect(await vault.read.balanceOf([alice.account.address])).to.equal(0n);
            });
        });
    }
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
