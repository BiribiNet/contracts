// Audit probes: these document current risks, not desired security guarantees.
// All transactions run on the ephemeral Hardhat network.
import { viem } from "hardhat";
import { loadFixture, takeSnapshot, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { concatHex, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, parseAbiParameters, parseUnits, toFunctionSelector, toHex, zeroAddress } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";
import { buildRouletteEngineLibraryMap } from "../scripts/utils/verifyWithEtherscan";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { encodeMultiBet, encodeSingleBet } from "./helpers/multiBetEncode";
import { customErrorPattern } from "./helpers/customErrorPattern";

async function auditStack() {
    const stack = await deployProtocolStack();
    return { ...stack, scheduler: await viem.getContractAt("UpkeepScheduler", stack.scheduler.address),
        vrf: await viem.getContractAt("MockVrfCoordinator", stack.vrf.address) };
}

async function auditMarket(stack: Awaited<ReturnType<typeof auditStack>>, asset: `0x${string}`) {
    const impl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [impl.address, stack.admin]);
    await stack.registry.write.setVaultBeacon([beacon.address]);
    await stack.registry.write.createMarket([{ asset, bankAdmin: stack.admin, minBet: 1_000_000n }]);
    const market = await stack.registry.read.getMarket([1]);
    return viem.getContractAt("BankVault4626", market.bank);
}

async function populatedStack() {
    const [admin, attacker] = await viem.getWalletClients();
    const stack = await auditStack();
    const usdc = await viem.deployContract("MockUSDC");
    const bank = await auditMarket(stack, usdc.address);
    await usdc.write.mint([admin.account.address, parseUnits("1000000", 6)]);
    await usdc.write.approve([bank.address, parseUnits("1000000", 6)]);
    await bank.write.deposit([parseUnits("500000", 6), admin.account.address]);
    await stack.sideBet.write.addConfig([{ marketId: 1, betType: 1, color: 0, targetNumber: 7,
        targetCount: 1, redRatioBps: 0, windowSpins: 1, multiplierBps: 100_000, minStake: 0n, maxStake: 0n }]);
    await stack.sideBet.write.setConfigStakeLimits([0n, parseUnits("1", 6), parseUnits("10", 6)]);
    await stack.sideBet.write.placeBet([0n, parseUnits("1", 6)]);
    await bank.write.placeBet([parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6)), zeroAddress]);
    await bank.write.redeemBps([1000, admin.account.address, admin.account.address]);
    await time.increase(550);
    const [, trigger] = await stack.scheduler.read.checkUpkeep(["0x"]);
    await stack.scheduler.write.performUpkeep([trigger]);
    return { ...stack, adminWallet: admin, attacker, usdc, bank };
}

describe("Mainnet readiness audit probes (current behavior)", function () {
    this.timeout(120_000);

    it("reproduces deployment failure when protocol admin differs from deployer", async function () {
        const [deployer, multisig] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [multisig.account.address]);
        const vrf = await viem.deployContract("MockVrfCoordinator");
        const router = await viem.deployContract("MockUniswapV2Router");
        const key = ("0x" + "11".repeat(32)) as `0x${string}`;
        await expect(deployRouletteEngine([key, key, key],
            [zeroAddress, zeroAddress, zeroAddress, multisig.account.address, vrf.address, 1n, 2_000_000, 1, 500, multisig.account.address],
            { admin: multisig.account.address, scanLimit: 25, maxPayoutsPerCall: 10 },
            { protocolPrefix: { brb: brb.address, router: router.address, admin: multisig.account.address }, wireMockForwarder: false },
        )).to.be.rejectedWith("AccessControlUnauthorizedAccount");
        expect(deployer.account.address).not.to.equal(multisig.account.address);
    });

    it("shows the standalone vault implementation is not initializer-locked", async function () {
        const [, attacker] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const engine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        await impl.write.initialize([{ assetToken: usdc.address, name: "Audit", symbol: "AUD", marketId: 1,
            engine: engine.address, admin: attacker.account.address, minBet: 1n, sideBetController: zeroAddress }],
            { account: attacker.account });
        expect(await impl.read.hasRole([await impl.read.DEFAULT_ADMIN_ROLE(), attacker.account.address])).to.equal(true);
    });

    it("preserves pending VRF, queued LP withdrawal, balances and roles through same-version UUPS and beacon upgrades", async function () {
        const s = await loadFixture(populatedStack);
        const before = {
            round: await s.engine.read.currentGlobalRound(), pending: await s.engine.read.hasPendingVrf(),
            locked: await s.bank.read.lockedBetLiquidity(), shares: await s.bank.read.totalSupply(),
            balance: await s.usdc.read.balanceOf([s.bank.address]), queue: await s.bank.read.pendingWithdrawalStatus([s.adminWallet.account.address]),
            sideBet: await s.sideBet.read.getBet([0n]), reserved: await s.sideBet.read.reservedOf([1]),
            config: await s.sideBet.read.getConfig([0n]),
        };
        const newEngine = await viem.deployContract("RouletteEngine", [s.vrf.address,
            await s.engine.read.VRF_KEY_HASH_2_GWEI(), await s.engine.read.VRF_KEY_HASH_30_GWEI(), await s.engine.read.VRF_KEY_HASH_150_GWEI(),
            await s.engine.read.VRF_CONFIRMATIONS(), await s.engine.read.BRB_REFERRAL()],
            { libraries: { ...buildRouletteEngineLibraryMap(s.linkedLibraries),
                "contracts/libraries/JackpotBatchLib.sol:JackpotBatchLib": s.linkedLibraries.jackpotBatchLib } });
        await expect(s.engine.write.upgradeToAndCall([newEngine.address, "0x"], { account: s.attacker.account })).to.be.rejected;
        await s.engine.write.upgradeToAndCall([newEngine.address, "0x"]);
        const beacon = await viem.getContractAt("UpgradeableBeacon", await s.registry.read.vaultBeacon());
        const vaultImpl = await viem.deployContract("BankVault4626");
        await expect(beacon.write.upgradeTo([vaultImpl.address], { account: s.attacker.account })).to.be.rejected;
        await beacon.write.upgradeTo([vaultImpl.address]);
        const sideImpl = await viem.deployContract("SideBet");
        await expect(s.sideBet.write.upgradeToAndCall([sideImpl.address, "0x"], { account: s.attacker.account })).to.be.rejected;
        await s.sideBet.write.upgradeToAndCall([sideImpl.address, "0x"]);
        const uuid = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
        expect(await newEngine.read.proxiableUUID()).to.equal(uuid);
        expect(await sideImpl.read.proxiableUUID()).to.equal(uuid);
        await expect(sideImpl.write.initialize([s.adminWallet.account.address, s.engine.address, s.registry.address, 50_000, 5_000_000])).to.be.rejectedWith(customErrorPattern("InvalidInitialization()"));
        await expect(s.sideBet.write.initialize([s.adminWallet.account.address, s.engine.address, s.registry.address, 50_000, 5_000_000])).to.be.rejectedWith(customErrorPattern("InvalidInitialization()"));
        expect(await s.engine.read.currentGlobalRound()).to.equal(before.round);
        expect(await s.engine.read.hasPendingVrf()).to.equal(before.pending);
        expect(await s.bank.read.lockedBetLiquidity()).to.equal(before.locked);
        expect(await s.bank.read.totalSupply()).to.equal(before.shares);
        expect(await s.usdc.read.balanceOf([s.bank.address])).to.equal(before.balance);
        expect(await s.bank.read.pendingWithdrawalStatus([s.adminWallet.account.address])).to.deep.equal(before.queue);
        expect(await s.sideBet.read.getBet([0n])).to.deep.equal(before.sideBet);
        expect(await s.sideBet.read.reservedOf([1])).to.equal(before.reserved);
        expect(await s.sideBet.read.getConfig([0n])).to.deep.equal(before.config);
        expect(await s.engine.read.hasRole([await s.engine.read.DEFAULT_ADMIN_ROLE(), s.adminWallet.account.address])).to.equal(true);
        await s.vrf.write.fulfill([s.engine.address, 1n, 7n]);
        for (let lane = 0n; lane < 10n; lane++) {
            for (let step = 0; step < 5; step++) {
                const [needed, data] = await s.scheduler.read.checkUpkeep([encodeAbiParameters([{ type: "uint256" }], [lane])]);
                if (!needed) break;
                await s.scheduler.write.performUpkeep([data]);
            }
        }
        expect(await s.engine.read.currentGlobalRound()).to.equal(2n);
        expect((await s.bank.read.pendingWithdrawalStatus([s.adminWallet.account.address]))[1]).to.equal(false);
        expect((await s.sideBet.read.getBet([0n])).status).to.equal(1);
        expect(await s.sideBet.read.reservedOf([1])).to.equal(0n);
    });

    it("demonstrates that a report through the forwarder can redirect a roulette winner while workflow identity is unset", async function () {
        const s = await loadFixture(populatedStack);
        await s.vrf.write.fulfill([s.engine.address, 1n, 7n]);
        const forwarder = await viem.deployContract("MockCreForwarder");
        const receiver = await viem.deployContract("AutomationReceiver", [forwarder.address]);
        const authority = await viem.deployContract("CreExecutionAuthority", [s.adminWallet.account.address]);
        await authority.write.setExecutorApproved([receiver.address, true]);
        await s.scheduler.write.setForwarderAuthority([authority.address]);
        await receiver.write.setCallAllowed([s.scheduler.address, toFunctionSelector("performUpkeep(bytes)"), true]);
        expect(await receiver.read.getExpectedAuthor()).to.equal(zeroAddress);
        const [, data] = await s.scheduler.read.checkUpkeep(["0x"]);
        const types = parseAbiParameters("uint8,uint256,(uint8,uint32,uint64,uint32,uint32,uint32),(address,uint256)[],address[],uint256[]");
        const [kind, lane, job, payouts, jackpotWinners, jackpotAmounts] = decodeAbiParameters(types, data);
        expect(payouts.length).to.equal(1);
        const changed = encodeAbiParameters(types, [kind, lane, job, [[s.attacker.account.address, payouts[0][1]]], jackpotWinners, jackpotAmounts]);
        const call = encodeFunctionData({ abi: s.scheduler.abi, functionName: "performUpkeep", args: [changed] });
        const report = encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [s.scheduler.address, call]);
        const before = await s.usdc.read.balanceOf([s.attacker.account.address]);
        await forwarder.write.deliverReport([receiver.address, report]);
        expect(await s.usdc.read.balanceOf([s.attacker.account.address])).to.equal(before + payouts[0][1]);
    });

    it("checks real Chainlink signature verification separately from consumer workflow-owner authorization", async function () {
        const s = await loadFixture(populatedStack);
        await s.vrf.write.fulfill([s.engine.address, 1n, 7n]);
        const forwarder = await viem.deployContract("KeystoneForwarder");
        const receiver = await viem.deployContract("AutomationReceiver", [forwarder.address]);
        const authority = await viem.deployContract("CreExecutionAuthority", [s.adminWallet.account.address]);
        await authority.write.setExecutorApproved([receiver.address, true]);
        await s.scheduler.write.setForwarderAuthority([authority.address]);
        await receiver.write.setCallAllowed([s.scheduler.address, toFunctionSelector("performUpkeep(bytes)"), true]);
        // Local mock DON keys only. A real attacker does not possess production DON keys.
        const signers = [10, 11, 12, 13].map(accountIndex => mnemonicToAccount(
            "test test test test test test test test test test test junk", { accountIndex }));
        await forwarder.write.setConfig([1, 1, 1, signers.map(signer => signer.address)]);
        const [, data] = await s.scheduler.read.checkUpkeep(["0x"]);
        const types = parseAbiParameters("uint8,uint256,(uint8,uint32,uint64,uint32,uint32,uint32),(address,uint256)[],address[],uint256[]");
        const [kind, lane, job, payouts, jw, ja] = decodeAbiParameters(types, data);
        const changed = encodeAbiParameters(types, [kind, lane, job, [[s.attacker.account.address, payouts[0][1]]], jw, ja]);
        const call = encodeFunctionData({ abi: s.scheduler.abi, functionName: "performUpkeep", args: [changed] });
        const payload = encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [s.scheduler.address, call]);
        const context = "0x" as const;
        async function signed(execution: bigint) {
            const raw = encodePacked(["uint8", "bytes32", "uint32", "uint32", "uint32", "bytes32", "bytes10", "address", "bytes2", "bytes"],
                [1, toHex(execution, { size: 32 }), 0, 1, 1, toHex(99n, { size: 32 }), toHex(1n, { size: 10 }), s.attacker.account.address, "0x0001", payload]);
            const hash = keccak256(concatHex([keccak256(raw), context]));
            const signatures = await Promise.all(signers.slice(0, 2).map(async signer => {
                const sig = await signer.sign({ hash });
                return concatHex([sig.slice(0, -2) as `0x${string}`, toHex(parseInt(sig.slice(-2), 16) - 27, { size: 1 })]);
            }));
            return { raw, signatures };
        }
        const a = await signed(1n);
        await expect(receiver.write.onReport(["0x", payload], { account: s.attacker.account })).to.be.rejected;
        await expect(receiver.write.setForwarderAddress([s.attacker.account.address], { account: s.attacker.account })).to.be.rejected;
        await expect(forwarder.write.route([toHex(5n, { size: 32 }), s.attacker.account.address, receiver.address, "0x", payload], { account: s.attacker.account })).to.be.rejected;
        await expect(forwarder.write.report([receiver.address, a.raw, context, []], { account: s.attacker.account })).to.be.rejectedWith("InvalidSignatureCount");
        const before = await s.usdc.read.balanceOf([s.attacker.account.address]);
        const snapshot = await takeSnapshot();
        await forwarder.write.report([receiver.address, a.raw, context, a.signatures], { account: s.attacker.account });
        expect(await s.usdc.read.balanceOf([s.attacker.account.address])).to.equal(before + payouts[0][1]);
        await snapshot.restore();
        await receiver.write.setExpectedAuthor([s.adminWallet.account.address]);
        await forwarder.write.report([receiver.address, a.raw, context, a.signatures], { account: s.attacker.account });
        expect((await forwarder.read.getTransmissionInfo([receiver.address, toHex(1n, { size: 32 }), "0x0001"])).success).to.equal(false);
        expect(await s.usdc.read.balanceOf([s.attacker.account.address])).to.equal(before);
        // Explicitly authorize this test workflow owner: the same DON-valid report can now deliver.
        await receiver.write.setExpectedAuthor([s.attacker.account.address]);
        await forwarder.write.report([receiver.address, a.raw, context, a.signatures], { account: s.attacker.account });
        expect((await forwarder.read.getTransmissionInfo([receiver.address, toHex(1n, { size: 32 }), "0x0001"])).success).to.equal(true);
        expect(await s.usdc.read.balanceOf([s.attacker.account.address])).to.equal(before + payouts[0][1]);
    });

    it("reproduces a callback gas failure with an accepted excessive lane count and verifies dust legs are accepted", async function () {
        const s = await auditStack();
        const usdc = await viem.deployContract("MockUSDC");
        const bank = await auditMarket(s, usdc.address);
        await usdc.write.mint([s.admin, parseUnits("10000", 6)]);
        await usdc.write.approve([bank.address, parseUnits("10000", 6)]);
        await bank.write.deposit([parseUnits("5000", 6), s.admin]);
        const legs = Array.from({ length: 250 }, () => ({ betType: 8n, number: 0n, amount: 4000n }));
        await bank.write.placeBet([1_000_000n, encodeMultiBet(legs), zeroAddress]);
        await s.engine.write.setPayoutLaneCount([2000]);
        await time.increase(550);
        const [, trigger] = await s.scheduler.read.checkUpkeep(["0x"]);
        await s.scheduler.write.performUpkeep([trigger]);
        // The real coordinator caps the engine callback at 2.5M. This wrapper
        // has small overhead, while 2000 shard writes alone exceed the budget.
        await expect(s.vrf.write.fulfill([s.engine.address, 1n, 7n], { gas: 2_500_000n })).to.be.rejected;
        expect(await s.engine.read.hasPendingVrf()).to.equal(true);
        await expect(s.engine.write.setPayoutLaneCount([10])).to.be.rejectedWith("PayoutLaneCountLockedWhileSettling");
    });

    it("skips a blocked withdrawal recipient without stalling settlement; owner keeps shares and may re-request", async function () {
        const s = await auditStack();
        const [, blockedRecipient] = await viem.getWalletClients();
        const token = await viem.deployContract("MockBlockedRecipient");
        const bank = await auditMarket(s, token.address);
        await token.write.mint([s.admin, parseUnits("10000", 6)]);
        await token.write.approve([bank.address, parseUnits("10000", 6)]);
        await bank.write.deposit([parseUnits("5000", 6), s.admin]);
        const sharesBefore = await bank.read.balanceOf([s.admin]);
        await bank.write.placeBet([parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6)), zeroAddress]);
        await token.write.setBlocked([blockedRecipient.account.address, true]);
        // LP is NOT blocked. The freely chosen destination is already blocked at enqueue time.
        expect(await token.read.blocked([s.admin])).to.equal(false);
        await bank.write.redeemBps([1000, blockedRecipient.account.address, s.admin]);
        await time.increase(550);
        const [, trigger] = await s.scheduler.read.checkUpkeep(["0x"]);
        await s.scheduler.write.performUpkeep([trigger]);
        await s.vrf.write.fulfill([s.engine.address, 1n, 8n]);
        const [needed, payout] = await s.scheduler.read.checkUpkeep(["0x"]);
        expect(needed).to.equal(true);
        await s.scheduler.write.performUpkeep([payout]);
        expect(await s.engine.read.currentGlobalRound()).to.equal(2n);
        expect((await bank.read.pendingWithdrawalStatus([s.admin]))[1]).to.equal(false);
        expect(await bank.read.balanceOf([s.admin])).to.equal(sharesBefore);
        // Owner can re-request to a receivable address after the skip.
        await bank.write.redeemBps([1000, s.admin, s.admin]);
        expect((await bank.read.pendingWithdrawalStatus([s.admin]))[1]).to.equal(true);
    });
});
