import { ethers, viem } from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { maxUint256, zeroAddress } from "viem";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { createMarketWithBeacon } from "./helpers/createMarket";
import { encodeSingleBet } from "./helpers/multiBetEncode";
import { runParallelLanesUntilIdle } from "./helpers/parallelUpkeep";
import { customErrorPattern } from "./helpers/customErrorPattern";

// Generated from the same validated sources used by the production cleanup upgrades.
const clean = require("../reports/incident-2026-11-04/future-upgrade-artifacts.json");
const recovery = require("../reports/incident-2026-11-04/recovery-artifacts.json");

describe("Normal operations after removing both incident recovery functions", function () {
    for (const decimals of [6, 18] as const) {
        it(`preserves roles and completes a normal wager/settlement/queued withdrawal with clean bytecode (${decimals} decimals)`, async function () {
            const [admin, alice] = await viem.getWalletClients();
            const [signer] = await ethers.getSigners();
            const s = await deployProtocolStack({ maxPayoutsPerCall: 1 });
            const token = await viem.deployContract(decimals === 6 ? "MockUSDC" : "MockDAI");
            const unit = 10n ** BigInt(decimals);
            const bank = await createMarketWithBeacon(s.registry, admin.account.address, token.address, unit);
            for (const who of [admin, alice]) {
                await token.write.mint([who.account.address, 10_000n * unit]);
                await token.write.approve([bank.address, maxUint256], { account: who.account });
            }
            await bank.write.deposit([1000n * unit, admin.account.address]);
            await bank.write.deposit([100n * unit, alice.account.address], { account: alice.account });
            const beacon = await ethers.getContractAt("UpgradeableBeacon", await s.registry.read.vaultBeacon(), signer);
            const recoveryBank = await new ethers.ContractFactory(recovery.BankVault4626.abi, recovery.BankVault4626.bytecode, signer).deploy();
            await recoveryBank.waitForDeployment();
            const recoverySide = await new ethers.ContractFactory(recovery.SideBet.abi, recovery.SideBet.bytecode, signer).deploy();
            await recoverySide.waitForDeployment();
            await (await beacon.upgradeTo(await recoveryBank.getAddress())).wait();
            const side = await ethers.getContractAt("SideBet", s.sideBet.address, signer);
            await (await side.upgradeToAndCall(await recoverySide.getAddress(), "0x")).wait();
            await s.sideBet.write.setSideBetsDisabled([true]);
            const role = await s.sideBet.read.SETTLEMENT_ROLE();
            expect(await s.sideBet.read.hasRole([role, s.scheduler.address])).to.equal(true);
            const before = {
                supply: await bank.read.totalSupply(), assets: await bank.read.totalAssets(),
                aliceShares: await bank.read.balanceOf([alice.account.address]),
                adminShares: await bank.read.balanceOf([admin.account.address]),
                balance: await token.read.balanceOf([bank.address]),
                configs: await s.sideBet.read.configCount(),
            };
            const nextBank = await new ethers.ContractFactory(clean.BankVault4626.abi, clean.BankVault4626.bytecode, signer).deploy();
            await nextBank.waitForDeployment();
            const nextSide = await new ethers.ContractFactory(clean.SideBet.abi, clean.SideBet.bytecode, signer).deploy();
            await nextSide.waitForDeployment();
            await (await beacon.upgradeTo(await nextBank.getAddress())).wait();
            await (await side.upgradeToAndCall(await nextSide.getAddress(), "0x")).wait();
            await expect(ethers.provider.call({ from: admin.account.address, to: bank.address,
                data: ethers.id("recoverNovember2026()").slice(0, 10) })).to.be.rejected;
            await expect(ethers.provider.call({ from: bank.address, to: s.sideBet.address,
                data: ethers.id("recoverNovember2026Tickets()").slice(0, 10) })).to.be.rejected;
            expect(await bank.read.totalSupply()).to.equal(before.supply);
            expect(await bank.read.totalAssets()).to.equal(before.assets);
            expect(await bank.read.balanceOf([alice.account.address])).to.equal(before.aliceShares);
            expect(await bank.read.balanceOf([admin.account.address])).to.equal(before.adminShares);
            expect(await token.read.balanceOf([bank.address])).to.equal(before.balance);
            expect(await s.sideBet.read.configCount()).to.equal(before.configs);
            expect(await s.sideBet.read.sideBetsDisabled()).to.equal(true);
            expect(await s.sideBet.read.hasRole([role, s.scheduler.address])).to.equal(true);
            expect(await bank.read.hasRole([await bank.read.DEFAULT_ADMIN_ROLE(), admin.account.address])).to.equal(true);
            expect((await beacon.owner()).toLowerCase()).to.equal(admin.account.address.toLowerCase());
            // Even the still-authorized scheduler is blocked by the flag, not by a lost role.
            await expect(ethers.provider.call({ from: s.scheduler.address, to: s.sideBet.address,
                data: side.interface.encodeFunctionData("settleBatchV2", [[], []]) }))
                .to.be.rejectedWith(customErrorPattern("SideBetsDisabled()"));

            const quote = await bank.read.previewDeposit([2n * unit]);
            const playerBalance = await token.read.balanceOf([alice.account.address]);
            await bank.write.placeBet([10n * unit, encodeSingleBet(1n, 7n, 10n * unit), zeroAddress], { account: alice.account });
            expect(await bank.read.totalAssets()).to.equal(before.assets);
            expect(await bank.read.previewDeposit([2n * unit])).to.equal(quote);
            await bank.write.redeemBps([10_000, alice.account.address, alice.account.address], { account: alice.account });
            expect((await bank.read.pendingWithdrawalStatus([alice.account.address]))[1]).to.equal(true);
            await time.increase(550);
            await s.scheduler.write.performUpkeep([(await s.scheduler.read.checkUpkeep(["0x"]))[1]]);
            expect(await s.engine.read.hasPendingVrf()).to.equal(true);
            await s.vrf.write.fulfill([s.engine.address, 1n, 7n]);
            await runParallelLanesUntilIdle(s.scheduler);
            expect(await s.engine.read.hasPendingVrf()).to.equal(false);
            expect(await s.engine.read.isBankLiquidityRestricted([1])).to.equal(false);
            expect(await bank.read.lockedBetLiquidity()).to.equal(0n);
            expect(await bank.read.balanceOf([alice.account.address])).to.equal(0n);
            expect((await bank.read.pendingWithdrawalStatus([alice.account.address]))[1]).to.equal(false);
            expect(await token.read.balanceOf([alice.account.address])).to.be.gt(playerBalance);
            expect(await bank.read.totalSupply()).to.equal(before.supply - before.aliceShares);
            const shares = await bank.read.previewDeposit([2n * unit]);
            await bank.write.deposit([2n * unit, admin.account.address]);
            expect(await bank.read.balanceOf([admin.account.address])).to.equal(before.adminShares + shares);
            expect(await s.sideBet.read.sideBetsDisabled()).to.equal(true);
            expect(await s.sideBet.read.hasRole([role, s.scheduler.address])).to.equal(true);
        });
    }
});
