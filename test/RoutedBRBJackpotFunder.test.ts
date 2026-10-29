import { artifacts, viem } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { getAddress, parseEventLogs, parseUnits, zeroAddress, type Address } from "viem";
import { deployUniswapV2Local } from "../scripts/utils/deployUniswapV2Local";
import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";
import { encodeSingleBet } from "./helpers/multiBetEncode";
import { runParallelLanesUntilIdle } from "./helpers/parallelUpkeep";

const daiAmount = (value: string) => parseUnits(value, 18);
const usdcAmount = (value: string) => parseUnits(value, 6);

async function fixture() {
    const [admin, treasury, stranger] = await viem.getWalletClients();
    const pc = await viem.getPublicClient();
    const brb = await viem.deployContract("BRBToken", [admin.account.address]);
    const dai = await viem.deployContract("MockDAI");
    const usdc = await viem.deployContract("MockUSDC");
    const amm = await deployUniswapV2Local(admin);
    const router = await viem.getContractAt("UniswapV2Router02", amm.router);
    const factory = await viem.getContractAt("UniswapV2Factory", amm.factory);
    await dai.write.mint([admin.account.address, daiAmount("1000000")]);
    await usdc.write.mint([admin.account.address, usdcAmount("1000000")]);
    await dai.write.approve([router.address, daiAmount("1000000")]);
    await usdc.write.approve([router.address, usdcAmount("1000000")]);
    await brb.write.approve([router.address, daiAmount("1000000")]);
    const deadline = (await pc.getBlock()).timestamp + 100000n;
    await router.write.addLiquidity([dai.address, usdc.address, daiAmount("100000"), usdcAmount("100000"),
        0n, 0n, admin.account.address, deadline]);
    await router.write.addLiquidity([usdc.address, brb.address, usdcAmount("1000"), daiAmount("100000"),
        0n, 0n, admin.account.address, deadline]);
    const args: [Address, Address, Address, Address, Address, Address, Address, Address] = [
        admin.account.address, brb.address, router.address, treasury.account.address,
        admin.account.address, admin.account.address, dai.address, usdc.address];
    const funder = await viem.deployContract("RoutedBRBJackpotFunder", args);
    const harness = await viem.deployContract("RoutedBRBJackpotFunderHarness", args);
    const firstPair = await viem.getContractAt("UniswapV2Pair", await factory.read.getPair([dai.address, usdc.address]));
    const secondPair = await viem.getContractAt("UniswapV2Pair", await factory.read.getPair([usdc.address, brb.address]));
    const process = async (market: number) => pc.waitForTransactionReceipt({
        hash: await funder.write.processFunding([market], { gas: 1500000n }),
    });
    const queue = async (market: number, amount: bigint) => {
        await dai.write.transfer([funder.address, amount]);
        await funder.write.queueFunding([market, dai.address, amount]);
    };
    return { admin, treasury, stranger, pc, brb, dai, usdc, router, factory, funder, harness,
        firstPair, secondPair, args, process, queue, deadline };
}

describe("RoutedBRBJackpotFunder", function () {
    it("preserves the existing keeper/accounting ABI and stays below EIP-170", async function () {
        const old = await artifacts.readArtifact("BRBJackpotFunder");
        const next = await artifacts.readArtifact("RoutedBRBJackpotFunder");
        for (const item of old.abi.filter(x => x.type === "function" || x.type === "event")) {
            expect(next.abi).to.deep.include(item);
        }
        expect((next.deployedBytecode.length - 2) / 2).to.be.lte(24576);
    });

    it("fixes DAI routing without a DAI/BRB pool and accounts for the exact output", async function () {
        const f = await loadFixture(fixture);
        expect(await f.factory.read.getPair([f.dai.address, f.brb.address])).to.equal(zeroAddress);
        expect((await f.funder.read.fundingPath([f.dai.address])).map(getAddress))
            .to.deep.equal([f.dai.address, f.usdc.address, f.brb.address].map(getAddress));
        const amount = daiAmount("0.03");
        const quote = await f.router.read.getAmountsOut([amount, [f.dai.address, f.usdc.address, f.brb.address]]);
        expect(await f.harness.read.minimumOutput([f.dai.address, amount])).to.equal(quote[2] * 9700n / 10000n);
        await f.queue(3, amount);
        const supplyBefore = await f.brb.read.totalSupply();
        const receipt = await f.process(3);
        const funded = parseEventLogs({ abi: f.funder.abi, logs: receipt.logs, eventName: "FundedFromMarket" });
        expect(funded).to.have.length(1);
        expect(funded[0].args.assetSwapped).to.equal(amount);
        expect(funded[0].args.brbOut).to.equal(quote[2]);
        const account = await f.funder.read.fundingAccounts([3]);
        expect(account[1]).to.equal(0n);
        expect(account[2]).to.equal(amount);
        expect(account[3]).to.equal(amount);
        expect(account[4]).to.equal(quote[2]);
        expect(account[5]).to.equal(quote[2] * 250n / 300n);
        expect(account[6]).to.equal(quote[2] - account[5]);
        expect(await f.brb.read.balanceOf([f.treasury.account.address])).to.equal(account[5]);
        expect(supplyBefore - await f.brb.read.totalSupply()).to.equal(account[6]);
        expect(await f.dai.read.balanceOf([f.funder.address])).to.equal(0n);
        expect(await f.usdc.read.balanceOf([f.funder.address])).to.equal(0n);
        expect(await f.brb.read.balanceOf([f.funder.address])).to.equal(0n);
        expect(await f.dai.read.allowance([f.funder.address, f.router.address])).to.equal(0n);
        expect(await f.funder.read.consecutiveFailures([3])).to.equal(0);
        console.log(`    DAI cold-route worker gas: ${receipt.gasUsed}`);
    });

    it("keeps direct USDC swaps and direct BRB distribution working in one keeper batch", async function () {
        const f = await loadFixture(fixture);
        expect((await f.funder.read.fundingPath([f.usdc.address])).map(getAddress))
            .to.deep.equal([f.usdc.address, f.brb.address].map(getAddress));
        expect((await f.funder.read.fundingPath([f.brb.address])).map(getAddress)).to.deep.equal([getAddress(f.brb.address)]);
        await f.usdc.write.transfer([f.funder.address, usdcAmount("0.03")]);
        await f.funder.write.queueFunding([2, f.usdc.address, usdcAmount("0.03")]);
        await f.brb.write.transfer([f.funder.address, daiAmount("0.3")]);
        await f.funder.write.queueFunding([1, f.brb.address, daiAmount("0.3")]);
        await f.queue(3, daiAmount("0.03"));
        await f.funder.write.processFundingBatch([[1, 2, 3]], { gas: 3000000n });
        for (const id of [1, 2, 3]) {
            const account = await f.funder.read.fundingAccounts([id]);
            expect(account[1]).to.equal(0n);
            expect(account[2]).to.equal(account[3]);
            expect(account[4]).to.equal(account[5] + account[6]);
            expect(account[4]).to.be.gt(0n);
        }
        expect(await f.usdc.read.allowance([f.funder.address, f.router.address])).to.equal(0n);
    });

    it("caps DAI input against the shallower second pool, retaining the remainder and cooldown", async function () {
        const f = await loadFixture(fixture);
        const cap = await f.harness.read.inputCap([f.dai.address]);
        expect(cap).to.be.lt(daiAmount("1000")); // first-pool input cap
        const quote = await f.router.read.getAmountsOut([cap, [f.dai.address, f.usdc.address, f.brb.address]]);
        expect(quote[1]).to.be.lte(usdcAmount("10")); // 1% of second-pool USDC reserves
        await f.queue(3, daiAmount("100"));
        await f.process(3);
        const account = await f.funder.read.fundingAccounts([3]);
        expect(account[3]).to.equal(cap);
        expect(account[1]).to.equal(daiAmount("100") - cap);
        expect(await f.dai.read.balanceOf([f.funder.address])).to.equal(account[1]);
        await f.process(3);
        expect((await f.funder.read.fundingAccounts([3]))[3]).to.equal(cap);
        await time.increase(60);
        await f.process(3);
        expect((await f.funder.read.fundingAccounts([3]))[3]).to.be.gt(cap);
    });

    it("also respects the first pool's input cap when it is shallower", async function () {
        const f = await loadFixture(fixture);
        const cap = await f.harness.read.inputCap([f.dai.address]);
        // Remove most first-pool liquidity, preserving its price ratio.
        const lp = await f.firstPair.read.balanceOf([f.admin.account.address]);
        await f.firstPair.write.approve([f.router.address, lp]);
        await f.router.write.removeLiquidity([f.dai.address, f.usdc.address, lp * 999n / 1000n,
            0n, 0n, f.admin.account.address, f.deadline]);
        const reserves = await f.firstPair.read.getReserves();
        const reserveIn = getAddress(await f.firstPair.read.token0()) === getAddress(f.dai.address) ? reserves[0] : reserves[1];
        const smallerCap = await f.harness.read.inputCap([f.dai.address]);
        expect(smallerCap).to.equal(reserveIn / 100n);
        expect(smallerCap).to.be.lt(cap);
    });

    for (const missing of ["first", "second"] as const) {
        it(`retains the entire queue when the ${missing} route pool is missing or empty`, async function () {
            const f = await loadFixture(fixture);
            const factory = await viem.deployContract("MockUniswapV2Factory");
            const router = await viem.deployContract("MockUniswapV2Router");
            await router.write.setFactory([factory.address]);
            // Leave the selected pool missing; the other is a real pair.
            if (missing === "first") await factory.write.setPair([f.usdc.address, f.brb.address, f.secondPair.address]);
            else await factory.write.setPair([f.dai.address, f.usdc.address, f.firstPair.address]);
            const next = await viem.deployContract("RoutedBRBJackpotFunder", [f.admin.account.address, f.brb.address,
                router.address, f.treasury.account.address, f.admin.account.address, f.admin.account.address, f.dai.address, f.usdc.address]);
            await f.dai.write.transfer([next.address, daiAmount("0.03")]);
            await next.write.queueFunding([3, f.dai.address, daiAmount("0.03")]);
            const hash = await next.write.processFunding([3], { gas: 1500000n });
            const receipt = await f.pc.waitForTransactionReceipt({ hash });
            const skipped = parseEventLogs({ abi: next.abi, logs: receipt.logs, eventName: "FundFromMarketSkipped" });
            expect(skipped[0].args.reason).to.equal(3);
            expect((await next.read.fundingAccounts([3]))[1]).to.equal(daiAmount("0.03"));
            expect(await f.dai.read.balanceOf([next.address])).to.equal(daiAmount("0.03"));
            expect(await f.dai.read.allowance([next.address, router.address])).to.equal(0n);
            const empty = await viem.deployContract("MockUniswapV2Pair", missing === "first"
                ? [f.dai.address, f.usdc.address] : [f.usdc.address, f.brb.address]);
            await factory.write.setPair(missing === "first"
                ? [f.dai.address, f.usdc.address, empty.address] : [f.usdc.address, f.brb.address, empty.address]);
            await time.increase(60);
            await next.write.processFunding([3], { gas: 1500000n });
            expect((await next.read.fundingAccounts([3]))[1]).to.equal(daiAmount("0.03"));
        });
    }

    for (const hop of ["first", "second"] as const) {
        it(`rejects a depressed ${hop}-hop price against the warm TWAP without losing input`, async function () {
            const f = await loadFixture(fixture);
            await f.funder.write.updateObservation([f.dai.address], { gas: 400000n });
            for (const pair of [f.firstPair, f.secondPair]) {
                expect((await f.funder.read.pairObservations([pair.address]))[0]).to.be.gt(0);
            }
            await time.increase(1800);
            await f.router.write.swapExactTokensForTokens(hop === "first"
                ? [daiAmount("20000"), 0n, [f.dai.address, f.usdc.address], f.admin.account.address, f.deadline]
                : [usdcAmount("500"), 0n, [f.usdc.address, f.brb.address], f.admin.account.address, f.deadline]);
            await f.queue(3, daiAmount("0.03"));
            const receipt = await f.process(3);
            const skipped = parseEventLogs({ abi: f.funder.abi, logs: receipt.logs, eventName: "FundFromMarketSkipped" });
            expect(skipped[0].args.reason).to.equal(2);
            expect((await f.funder.read.fundingAccounts([3]))[1]).to.equal(daiAmount("0.03"));
            expect(await f.dai.read.balanceOf([f.funder.address])).to.equal(daiAmount("0.03"));
            expect(await f.dai.read.allowance([f.funder.address, f.router.address])).to.equal(0n);
            expect(await f.funder.read.consecutiveFailures([3])).to.equal(1);
        });
    }

    it("executes the warm route within the deployed keeper transaction budget", async function () {
        const f = await loadFixture(fixture);
        await f.funder.write.updateObservation([f.dai.address], { gas: 400000n });
        await time.increase(1800);
        await f.queue(3, daiAmount("0.03"));
        const receipt = await f.process(3);
        expect((await f.funder.read.fundingAccounts([3]))[1]).to.equal(0n);
        expect(await f.funder.read.ATTEMPT_GAS()).to.equal(850000n);
        expect(receipt.gasUsed).to.be.lt(1500000n);
        console.log(`    DAI warm-route worker gas: ${receipt.gasUsed}`);
    });

    it("does not assume stablecoin parity or confuse DAI and USDC decimals", async function () {
        const f = await loadFixture(fixture);
        await f.router.write.swapExactTokensForTokens([daiAmount("20000"), 0n,
            [f.dai.address, f.usdc.address], f.admin.account.address, f.deadline]);
        const amount = daiAmount("0.03");
        const quote = await f.router.read.getAmountsOut([amount, [f.dai.address, f.usdc.address, f.brb.address]]);
        expect(quote[1]).to.be.lt(usdcAmount("0.025"));
        await f.queue(3, amount);
        await f.process(3);
        expect((await f.funder.read.fundingAccounts([3]))[4]).to.equal(quote[2]);
    });

    it("isolates markets, protects queued assets from sweep, and enforces worker/admin guards", async function () {
        const f = await loadFixture(fixture);
        await f.queue(3, daiAmount("0.03"));
        await f.queue(4, daiAmount("0.02"));
        await expect(f.funder.write.queueFunding([3, f.dai.address, 1n], { account: f.stranger.account })).to.be.rejected;
        await expect(f.funder.write.executeFunding([3])).to.be.rejected;
        await expect(f.funder.write.sweepToken([f.dai.address, f.admin.account.address, 0n])).to.be.rejected;
        await expect(f.funder.write.processFunding([3], { gas: 300000n })).to.be.rejected;
        expect(await f.funder.read.fundingAttemptCount()).to.equal(0n);
        await f.process(4);
        expect((await f.funder.read.fundingAccounts([3]))[1]).to.equal(daiAmount("0.03"));
        expect((await f.funder.read.fundingAccounts([4]))[1]).to.equal(0n);
        expect(await f.dai.read.balanceOf([f.funder.address])).to.equal(daiAmount("0.03"));
        expect(await f.funder.read.queuedAssetTotals([f.dai.address])).to.equal(daiAmount("0.03"));
    });

    it("rejects ambiguous deployment routes", async function () {
        const f = await loadFixture(fixture);
        for (const [routed, bridge] of [[zeroAddress, f.usdc.address], [f.dai.address, zeroAddress],
            [f.dai.address, f.dai.address], [f.brb.address, f.usdc.address], [f.dai.address, f.brb.address]]) {
            await expect(viem.deployContract("RoutedBRBJackpotFunder", [...f.args.slice(0, 6), routed, bridge] as
                [Address, Address, Address, Address, Address, Address, Address, Address])).to.be.rejected;
        }
    });

    it("stops after five failed dust quotes, retains the queue and resumes only after an admin reset", async function () {
        const f = await loadFixture(fixture);
        await f.queue(3, 1n); // Too small to produce one USDC base unit.
        for (let i = 0; i < 7; i++) {
            await f.process(3);
            await time.increase(60);
        }
        expect(await f.funder.read.fundingAttemptCount()).to.equal(5n);
        expect(await f.funder.read.consecutiveFailures([3])).to.equal(5);
        expect((await f.funder.read.fundingAccounts([3]))[1]).to.equal(1n);
        await f.queue(3, daiAmount("0.03"));
        await f.process(3);
        expect(await f.funder.read.fundingAttemptCount()).to.equal(5n);
        await expect(f.funder.write.resetFundingRetry([3], { account: f.stranger.account })).to.be.rejected;
        await f.funder.write.resetFundingRetry([3]);
        await f.process(3);
        expect((await f.funder.read.fundingAccounts([3]))[1]).to.equal(0n);
        expect(await f.funder.read.consecutiveFailures([3])).to.equal(0);
    });

    it("keeps treasury/burn debts attached to their original market and split", async function () {
        const f = await loadFixture(fixture);
        const brb = await viem.deployContract("MockBRBWithFeeHooks", [f.admin.account.address]);
        const next = await viem.deployContract("RoutedBRBJackpotFunder", [f.admin.account.address, brb.address,
            f.router.address, f.treasury.account.address, f.admin.account.address, f.admin.account.address,
            f.dai.address, f.usdc.address]);
        await brb.write.transfer([next.address, 300n]);
        await next.write.queueFunding([1, brb.address, 300n]);
        await brb.write.setFailTransfer([true]);
        await brb.write.setFailBurn([true]);
        await next.write.processFunding([1], { gas: 1500000n });
        expect(await next.read.pendingBrbByMarket([1])).to.deep.equal([250n, 50n]);
        await next.write.setTreasuryBrbSplit([0n, 300n]);
        await brb.write.setFailTransfer([false]);
        await brb.write.setFailBurn([false]);
        await time.increase(60);
        await next.write.processFunding([1], { gas: 1500000n });
        const account = await next.read.fundingAccounts([1]);
        expect(account[5]).to.equal(250n);
        expect(account[6]).to.equal(50n);
        expect(await next.read.pendingBrbByMarket([1])).to.deep.equal([0n, 0n]);
        expect(account[4]).to.equal(account[5] + account[6]);
    });

    it("rotates both oracle anchors without resetting the shared USDC/BRB lookback", async function () {
        const f = await loadFixture(fixture);
        await f.funder.write.updateObservation([f.dai.address], { gas: 400000n });
        const first = (await f.funder.read.pairObservations([f.firstPair.address]))[0];
        const second = (await f.funder.read.pairObservations([f.secondPair.address]))[0];
        for (let i = 0; i < 8; i++) {
            await time.increase(600);
            await f.funder.write.updateObservation([f.usdc.address], { gas: 400000n });
            await f.funder.write.updateObservation([f.dai.address], { gas: 400000n });
        }
        const now = await time.latest();
        for (const [pair, initial] of [[f.firstPair, first], [f.secondPair, second]] as const) {
            const anchor = (await f.funder.read.pairObservations([pair.address]))[0];
            expect(anchor).to.be.gt(initial);
            expect(now - anchor).to.be.gte(1800);
        }
    });

    for (const includeSideBet of [false, true]) {
    it(`settles a DAI round${includeSideBet ? " and an active side bet across funder cutover" : ""} with the same fee splits`, async function () {
        const f = await loadFixture(fixture);
        const vrf = await viem.deployContract("MockVrfCoordinator");
        const key = ("0x" + "11".repeat(32)) as `0x${string}`;
        const stack = await deployRouletteEngine([key, key, key], [zeroAddress, zeroAddress, zeroAddress,
            f.stranger.account.address, vrf.address, 1n, 2500000, 1, 60, f.admin.account.address],
            { admin: f.admin.account.address, scanLimit: 25, maxPayoutsPerCall: 10 },
            { protocolPrefix: { brb: f.brb.address, router: f.router.address, admin: f.admin.account.address } });
        const next = await viem.deployContract("RoutedBRBJackpotFunder", [stack.engine.address, f.brb.address,
            f.router.address, stack.jackpotTreasury!.address, stack.sideBet.address,
            f.admin.account.address, f.dai.address, f.usdc.address]);
        const vault = await viem.deployContract("BankVault4626");
        const beacon = await viem.deployContract("UpgradeableBeacon", [vault.address, f.admin.account.address]);
        await stack.registry!.write.setVaultBeacon([beacon.address]);
        await stack.registry!.write.createMarket([{ asset: f.dai.address, bankAdmin: f.admin.account.address, minBet: daiAmount("1") }]);
        const bank = await viem.getContractAt("BankVault4626", (await stack.registry!.read.getMarket([1])).bank);
        await f.dai.write.approve([bank.address, daiAmount("10002")]);
        await bank.write.deposit([daiAmount("10000"), f.admin.account.address]);
        if (includeSideBet) {
            await stack.sideBet.write.addConfig([{ marketId: 1, betType: 1, color: 0, targetNumber: 7,
                targetCount: 1, redRatioBps: 0, windowSpins: 1, multiplierBps: 100000, minStake: 0n, maxStake: 0n }]);
            await stack.sideBet.write.setConfigStakeLimits([0n, daiAmount("1"), daiAmount("1000")]);
            await stack.sideBet.write.placeBet([0n, daiAmount("1")]);
        }
        await stack.engine.write.setJackpotFunder([next.address]);
        await bank.write.placeBet([daiAmount("1"), encodeSingleBet(1n, 1n, daiAmount("1")), zeroAddress]);
        await time.increase(65);
        await runParallelLanesUntilIdle(stack.scheduler);
        await vrf.write.fulfillWithJackpot([stack.engine.address, 1n, 20n, 12n]);
        const infraBefore = await f.dai.read.balanceOf([f.stranger.account.address]);
        await runParallelLanesUntilIdle(stack.scheduler);
        expect(await f.dai.read.balanceOf([f.stranger.account.address]) - infraBefore)
            .to.equal(daiAmount(includeSideBet ? "0.04" : "0.02"));
        expect(await f.dai.read.balanceOf([bank.address])).to.equal(daiAmount(includeSideBet ? "10001.90" : "10000.95"));
        expect((await next.read.fundingAccounts([1]))[1]).to.equal(daiAmount(includeSideBet ? "0.06" : "0.03"));
        expect((await stack.funder.read.fundingAccounts([1]))[1]).to.equal(0n);
        if (includeSideBet) expect((await stack.sideBet.read.getBet([0n])).status).to.equal(2);
        expect(await next.read.fundingAttemptCount()).to.equal(0n); // settlement only queues
        await next.write.processFunding([1], { gas: 1500000n });
        expect((await next.read.fundingAccounts([1]))[1]).to.equal(0n);
        expect((await next.read.fundingAccounts([1]))[4]).to.be.gt(0n);
        expect((await stack.engine.read.marketRoundStateByRound([1n, 1])).settled).to.equal(true);
    });
    }
});
