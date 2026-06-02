import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { getAddress, keccak256, parseUnits, toBytes, zeroAddress, type Address } from "viem";

import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { uniswapV2PairAddress } from "./helpers/uniswapV2PairAddress";

/** Places `MockUniswapV2Pair` bytecode at the CREATE2 address `pairFor(factory, tokenA, tokenB)` expects. */
async function seedCanonicalPairAtTwapAddress(
    factory: Address,
    tokenA: Address,
    tokenB: Address,
    reserve0: bigint,
    reserve1: bigint,
) {
    const publicClient = await viem.getPublicClient();
    const testClient = await viem.getTestClient();
    const pair = uniswapV2PairAddress(factory, tokenA, tokenB);
    const impl = await viem.deployContract("MockUniswapV2Pair", [tokenA, tokenB]);
    const bytecode = await publicClient.getBytecode({ address: impl.address });
    await testClient.setCode({ address: pair, bytecode: bytecode! });
    const pairContract = await viem.getContractAt("MockUniswapV2Pair", pair);
    await pairContract.write.setReserves([reserve0, reserve1]);
    return pair;
}

async function deployFunder(opts?: { engine?: Address; sideBet?: Address }) {
    const [admin] = await viem.getWalletClients();
    const brb = await viem.deployContract("BRBToken", [admin.account.address]);
    const treasury = await viem.deployContract("JackpotTreasury", [
        brb.address,
        admin.account.address,
        admin.account.address,
    ]);
    const router = await viem.deployContract("MockUniswapV2Router");
    const engine = opts?.engine ?? admin.account.address;
    const sideBet = opts?.sideBet ?? admin.account.address;
    const funder = await viem.deployContract("BRBJackpotFunder", [
        engine,
        brb.address,
        router.address,
        treasury.address,
        sideBet,
        admin.account.address,
    ]);
    return { admin, brb, treasury, router, funder, engine, sideBet };
}

describe("BRBJackpotFunder", function () {
    it("swaps with router spot quote minus slippage and completes", async function () {
        const { admin, brb, treasury, router, funder } = await deployFunder();
        await brb.write.transfer([router.address, parseUnits("100000", 18)], { account: admin.account });

        const usdc = await viem.deployContract("MockUSDC");
        await usdc.write.mint([funder.address, parseUnits("100", 6)]);

        const treasuryBefore = await brb.read.balanceOf([treasury.address]);
        await funder.write.fundFromMarket([1n, usdc.address], { account: admin.account });
        const treasuryAfter = await brb.read.balanceOf([treasury.address]);

        const swapIn = parseUnits("100", 6);
        const brbOut = swapIn * 10n ** 12n;
        const toTreasury = (brbOut * 250n) / 300n;
        expect(treasuryAfter - treasuryBefore).to.equal(toTreasury);
    });

    it("native BRB asset: splits fee slice without router swap", async function () {
        const { admin, brb, treasury, funder } = await deployFunder();

        const swapIn = parseUnits("3", 18);
        await brb.write.transfer([funder.address, swapIn], { account: admin.account });

        const supplyBefore = await brb.read.totalSupply();
        const treasuryBefore = await brb.read.balanceOf([treasury.address]);
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
        const treasuryAfter = await brb.read.balanceOf([treasury.address]);

        const toTreasury = (swapIn * 250n) / 300n;
        const toBurn = swapIn - toTreasury;
        expect(treasuryAfter - treasuryBefore).to.equal(toTreasury);
        expect(await brb.read.totalSupply()).to.equal(supplyBefore - toBurn);
    });

    it("returns without revert when router swap reverts", async function () {
        const { admin, funder, router } = await deployFunder();
        await router.write.setForceRevertSwap([true]);
        const usdc = await viem.deployContract("MockUSDC");
        await usdc.write.mint([funder.address, parseUnits("100", 6)]);

        await funder.write.fundFromMarket([1n, usdc.address], { account: admin.account });
        expect(await usdc.read.balanceOf([funder.address])).to.equal(parseUnits("100", 6));
    });

    it("reverts constructor on zero addresses", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const treasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            admin.account.address,
            admin.account.address,
        ]);
        const engine = admin.account.address;
        const sideBet = admin.account.address;

        await expect(
            viem.deployContract("BRBJackpotFunder", [zeroAddress, brb.address, router.address, treasury.address, sideBet, admin.account.address]),
        ).to.be.rejected;
        await expect(
            viem.deployContract("BRBJackpotFunder", [engine, zeroAddress, router.address, treasury.address, sideBet, admin.account.address]),
        ).to.be.rejected;
        await expect(
            viem.deployContract("BRBJackpotFunder", [engine, brb.address, zeroAddress, treasury.address, sideBet, admin.account.address]),
        ).to.be.rejected;
        await expect(
            viem.deployContract("BRBJackpotFunder", [engine, brb.address, router.address, zeroAddress, sideBet, admin.account.address]),
        ).to.be.rejected;
        await expect(
            viem.deployContract("BRBJackpotFunder", [engine, brb.address, router.address, treasury.address, sideBet, zeroAddress]),
        ).to.be.rejected;
    });

    it("exposes brbToken and admin setters with bounds", async function () {
        const { admin, brb, funder } = await deployFunder();

        expect(getAddress(await funder.read.brbToken())).to.equal(getAddress(brb.address));

        await funder.write.setSwapAssetBps([0n], { account: admin.account });
        await expect(funder.write.setSwapAssetBps([1001n], { account: admin.account })).to.be.rejected;

        await funder.write.setTreasuryBrbSplit([1n, 2n], { account: admin.account });
        await expect(funder.write.setTreasuryBrbSplit([2n, 1n], { account: admin.account })).to.be.rejected;
        await expect(funder.write.setTreasuryBrbSplit([1n, 0n], { account: admin.account })).to.be.rejected;

        await funder.write.setSlippageBps([1n], { account: admin.account });
        await expect(funder.write.setSlippageBps([10_000n], { account: admin.account })).to.be.rejected;

        await funder.write.setColdSlippageBps([300n], { account: admin.account });
        await expect(funder.write.setColdSlippageBps([10_000n], { account: admin.account })).to.be.rejected;
        expect(await funder.read.coldSlippageBps()).to.equal(300n);

        await funder.write.setTwapWindowSeconds([1800], { account: admin.account });
        expect(await funder.read.twapWindowSeconds()).to.equal(1800);
    });

    it("skips swap when quoted minOut exceeds mock router delivery", async function () {
        const { admin, brb, funder, router } = await deployFunder();
        await brb.write.transfer([router.address, parseUnits("100000", 18)], { account: admin.account });
        await router.write.setQuoteMultiplierWad([2n * 10n ** 18n], { account: admin.account });
        await funder.write.setSlippageBps([0n], { account: admin.account });

        const usdc = await viem.deployContract("MockUSDC");
        await usdc.write.mint([funder.address, parseUnits("100", 6)]);

        const treasury = await viem.getContractAt("JackpotTreasury", await funder.read.jackpotTreasury());
        const treasuryBefore = await brb.read.balanceOf([treasury.address]);
        await funder.write.fundFromMarket([1n, usdc.address], { account: admin.account });
        const treasuryAfter = await brb.read.balanceOf([treasury.address]);

        expect(treasuryAfter - treasuryBefore).to.equal(0n);
        expect(await usdc.read.balanceOf([funder.address])).to.equal(parseUnits("100", 6));
    });

    it("reverts admin setters from accounts without FUNDER_ADMIN_ROLE", async function () {
        const [, stranger] = await viem.getWalletClients();
        const { funder } = await deployFunder();

        await expect(funder.write.setSwapAssetBps([300n], { account: stranger.account })).to.be.rejected;
        await expect(funder.write.setTreasuryBrbSplit([250n, 300n], { account: stranger.account })).to.be.rejected;
        await expect(funder.write.setSlippageBps([100n], { account: stranger.account })).to.be.rejected;
        await expect(funder.write.setColdSlippageBps([300n], { account: stranger.account })).to.be.rejected;
    });

    it("fundFromMarket: fee collector guard, empty balance, and sideBet caller", async function () {
        const [admin, stranger] = await viem.getWalletClients();
        const sideBetCaller = await viem.deployContract("SideBet");
        const { brb, funder, engine } = await deployFunder({ sideBet: sideBetCaller.address });

        await expect(funder.write.fundFromMarket([1n, brb.address], { account: stranger.account })).to.be.rejected;
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });

        const testClient = await viem.getTestClient();
        await testClient.impersonateAccount({ address: sideBetCaller.address });
        await testClient.setBalance({ address: sideBetCaller.address, value: parseUnits("1", 18) });
        await brb.write.transfer([funder.address, parseUnits("1", 18)], { account: admin.account });
        await funder.write.fundFromMarket([1n, brb.address], { account: sideBetCaller.address });
        await testClient.stopImpersonatingAccount({ address: sideBetCaller.address });

        expect(getAddress(await funder.read.engine())).to.equal(getAddress(engine));
        expect(getAddress(await funder.read.sideBet())).to.equal(getAddress(sideBetCaller.address));
    });

    it("sweepToken recovers stuck asset for FUNDER_ADMIN_ROLE", async function () {
        const [admin, recipient] = await viem.getWalletClients();
        const { funder } = await deployFunder();

        const usdc = await viem.deployContract("MockUSDC");
        const stuck = parseUnits("50", 6);
        await usdc.write.mint([funder.address, stuck]);

        await funder.write.sweepToken([usdc.address, recipient.account.address, 0n], { account: admin.account });
        expect(await usdc.read.balanceOf([funder.address])).to.equal(0n);
        expect(await usdc.read.balanceOf([recipient.account.address])).to.equal(stuck);
    });

    it("fundFromMarket: treasury split edges and fee-hook failures", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("MockBRBWithFeeHooks", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            admin.account.address,
            admin.account.address,
        ]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const funder = await viem.deployContract("BRBJackpotFunder", [
            admin.account.address,
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
            admin.account.address,
        ]);

        await funder.write.setTreasuryBrbSplit([0n, 1n], { account: admin.account });
        await brb.write.transfer([funder.address, parseUnits("3", 18)], { account: admin.account });
        const supplyBeforeBurnOnly = await brb.read.totalSupply();
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
        expect(await brb.read.totalSupply()).to.equal(supplyBeforeBurnOnly - parseUnits("3", 18));

        await funder.write.setTreasuryBrbSplit([1000n, 1000n], { account: admin.account });
        await brb.write.transfer([funder.address, parseUnits("10", 18)], { account: admin.account });
        const supplyBeforeTreasuryOnly = await brb.read.totalSupply();
        const treasuryBefore = await brb.read.balanceOf([treasury.address]);
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
        expect(await brb.read.balanceOf([treasury.address])).to.be.gt(treasuryBefore);
        expect(await brb.read.totalSupply()).to.equal(supplyBeforeTreasuryOnly);

        await funder.write.setTreasuryBrbSplit([250n, 300n], { account: admin.account });
        await brb.write.transfer([funder.address, parseUnits("10", 18)], { account: admin.account });
        await brb.write.setFailTransfer([true]);
        const treasuryBeforeFail = await brb.read.balanceOf([treasury.address]);
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
        expect(await brb.read.balanceOf([treasury.address])).to.equal(treasuryBeforeFail);
        await brb.write.setFailTransfer([false]);

        await brb.write.transfer([funder.address, parseUnits("5", 18)], { account: admin.account });
        await brb.write.setRevertTransfer([true]);
        const treasuryBeforeRevert = await brb.read.balanceOf([treasury.address]);
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
        expect(await brb.read.balanceOf([treasury.address])).to.equal(treasuryBeforeRevert);
        await brb.write.setRevertTransfer([false]);

        await brb.write.setFailBurn([true]);
        await brb.write.transfer([funder.address, parseUnits("5", 18)], { account: admin.account });
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
        await brb.write.setFailBurn([false]);
    });

    it("sweepToken reverts when amount exceeds balance", async function () {
        const [admin] = await viem.getWalletClients();
        const { funder } = await deployFunder();
        const usdc = await viem.deployContract("MockUSDC");
        await expect(
            funder.write.sweepToken([usdc.address, admin.account.address, 1n], { account: admin.account }),
        ).to.be.rejected;
    });

    it("skips swap when pair has no liquidity (SKIP_NO_QUOTE)", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            admin.account.address,
            admin.account.address,
        ]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const factory = await viem.deployContract("MockUniswapV2Factory");
        await router.write.setFactory([factory.address]);
        const usdc = await viem.deployContract("MockUSDC");
        await seedCanonicalPairAtTwapAddress(factory.address, usdc.address, brb.address, 0n, 0n);
        const funder = await viem.deployContract("BRBJackpotFunderHarness", [
            admin.account.address,
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
            admin.account.address,
        ]);
        await usdc.write.mint([funder.address, parseUnits("50", 6)]);
        const treasuryBefore = await brb.read.balanceOf([treasury.address]);
        await funder.write.fundFromMarket([1n, usdc.address], { account: admin.account });
        expect(await usdc.read.balanceOf([funder.address])).to.equal(parseUnits("50", 6));
        expect(await brb.read.balanceOf([treasury.address])).to.equal(treasuryBefore);
    });

    it("uses router spot quote when pair is not deployed", async function () {
        const { admin, brb, treasury, router, funder } = await deployFunder();
        const factory = await viem.deployContract("MockUniswapV2Factory");
        await router.write.setFactory([factory.address]);
        await brb.write.transfer([router.address, parseUnits("100000", 18)], { account: admin.account });
        const dai = await viem.deployContract("MockUSDC");
        await dai.write.mint([funder.address, parseUnits("25", 6)]);
        await funder.write.fundFromMarket([1n, dai.address], { account: admin.account });
        expect(await dai.read.balanceOf([funder.address])).to.equal(0n);
    });

    it("returns zero minOut when router returns a short amounts array", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            admin.account.address,
            admin.account.address,
        ]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const funder = await viem.deployContract("BRBJackpotFunderHarness", [
            admin.account.address,
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
            admin.account.address,
        ]);
        await router.write.setReturnShortAmounts([true]);
        const usdc = await viem.deployContract("MockUSDC");
        expect(await funder.read.harnessAmountOutMin([usdc.address, parseUnits("10", 6)])).to.equal(0n);

        await router.write.setReturnShortAmounts([false]);
        await router.write.setQuoteMultiplierWad([0n]);
        expect(await funder.read.harnessAmountOutMin([usdc.address, parseUnits("10", 6)])).to.equal(0n);
    });

    it("returns zero minOut when getAmountsOut reverts", async function () {
        const { admin, brb, treasury, router, funder } = await deployFunder();
        await router.write.setForceRevertGetAmountsOut([true]);
        const usdc = await viem.deployContract("MockUSDC");
        await usdc.write.mint([funder.address, parseUnits("10", 6)]);
        const treasuryBefore = await brb.read.balanceOf([treasury.address]);
        await funder.write.fundFromMarket([1n, usdc.address], { account: admin.account });
        expect(await usdc.read.balanceOf([funder.address])).to.equal(parseUnits("10", 6));
        expect(await brb.read.balanceOf([treasury.address])).to.equal(treasuryBefore);
    });

    it("no-ops pair observation snapshot when pair is not deployed", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            admin.account.address,
            admin.account.address,
        ]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const harness = await viem.deployContract("BRBJackpotFunderHarness", [
            admin.account.address,
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
            admin.account.address,
        ]);
        const pair = uniswapV2PairAddress(zeroAddress, brb.address, brb.address);
        await harness.write.harnessSnapshotPairObservation([brb.address], { account: admin.account });
        const obs = await harness.read.pairObservations([pair]);
        expect(obs[0]).to.equal(0);
    });

    it("uses cold slippage on spot quotes before TWAP window is warm", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            admin.account.address,
            admin.account.address,
        ]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const factory = await viem.deployContract("MockUniswapV2Factory");
        await router.write.setFactory([factory.address]);
        const usdc = await viem.deployContract("MockUSDC");
        await seedCanonicalPairAtTwapAddress(
            factory.address,
            usdc.address,
            brb.address,
            100_000_000_000n,
            100_000_000_000_000_000_000_000n,
        );

        const funder = await viem.deployContract("BRBJackpotFunderHarness", [
            admin.account.address,
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
            admin.account.address,
        ]);
        await funder.write.setSlippageBps([100n], { account: admin.account });
        await funder.write.setColdSlippageBps([3000n], { account: admin.account });

        const swapIn = parseUnits("50", 6);
        const coldMinOut = await funder.read.harnessAmountOutMin([usdc.address, swapIn]);
        expect(coldMinOut).to.be.gt(0n);

        await funder.write.harnessSnapshotPairObservation([usdc.address], { account: admin.account });
        await time.increase(Number(await funder.read.twapWindowSeconds()) + 1);
        const warmMinOut = await funder.read.harnessAmountOutMin([usdc.address, swapIn]);
        expect(warmMinOut).to.be.gt(0n);
    });

    it("uses warm TWAP with slippageBps when spot is pumped above TWAP", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            admin.account.address,
            admin.account.address,
        ]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const factory = await viem.deployContract("MockUniswapV2Factory");
        await router.write.setFactory([factory.address]);
        const usdc = await viem.deployContract("MockUSDC");
        const usdcReserve = 1_000_000_000_000_000n;
        const brbReserve = usdcReserve * 1_000_000_000_000n;
        const usdcIsToken0 = usdc.address.toLowerCase() < brb.address.toLowerCase();
        const pair = await seedCanonicalPairAtTwapAddress(
            factory.address,
            usdc.address,
            brb.address,
            usdcIsToken0 ? usdcReserve : brbReserve,
            usdcIsToken0 ? brbReserve : usdcReserve,
        );

        const funder = await viem.deployContract("BRBJackpotFunderHarness", [
            admin.account.address,
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
            admin.account.address,
        ]);
        await funder.write.setTwapWindowSeconds([600], { account: admin.account });
        await funder.write.setSlippageBps([200n], { account: admin.account });
        await funder.write.setColdSlippageBps([4000n], { account: admin.account });

        await funder.write.harnessSnapshotPairObservation([usdc.address], { account: admin.account });
        await time.increase(601);

        const pairContract = await viem.getContractAt("MockUniswapV2Pair", pair);
        const pumpedBrb = brbReserve * 10n;
        await pairContract.write.setReserves([
            usdcIsToken0 ? usdcReserve : pumpedBrb,
            usdcIsToken0 ? pumpedBrb : usdcReserve,
        ]);

        const swapIn = parseUnits("50", 6);
        const [twapQuote, usedTwap] = await funder.read.harnessQuoteOut([usdc.address, swapIn]);
        expect(usedTwap).to.equal(true);
        expect(twapQuote).to.be.gt(0n);

        const minOut = await funder.read.harnessAmountOutMin([usdc.address, swapIn]);
        expect(minOut).to.equal((twapQuote * 9800n) / 10000n);
        expect(minOut).to.be.gt((twapQuote * 6000n) / 10000n);
    });

    it("records pair observation and uses TWAP after the window elapses", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            admin.account.address,
            admin.account.address,
        ]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const factory = await viem.deployContract("MockUniswapV2Factory");
        await router.write.setFactory([factory.address]);
        const usdc = await viem.deployContract("MockUSDC");
        const usdcReserve = 1_000_000_000_000_000n;
        const brbReserve = usdcReserve * 1_000_000_000_000n;
        const usdcIsToken0 = usdc.address.toLowerCase() < brb.address.toLowerCase();
        const pair = await seedCanonicalPairAtTwapAddress(
            factory.address,
            usdc.address,
            brb.address,
            usdcIsToken0 ? usdcReserve : brbReserve,
            usdcIsToken0 ? brbReserve : usdcReserve,
        );

        const funder = await viem.deployContract("BRBJackpotFunderHarness", [
            admin.account.address,
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
            admin.account.address,
        ]);
        await funder.write.harnessSnapshotPairObservation([usdc.address], { account: admin.account });

        expect(getAddress(await funder.read.harnessPairFor([usdc.address]))).to.equal(getAddress(pair));

        const obs = await funder.read.pairObservations([pair]);
        expect(Number(obs[0])).to.be.gt(0);

        await usdc.write.mint([funder.address, parseUnits("10", 6)]);
        await brb.write.transfer([router.address, parseUnits("500000", 18)], { account: admin.account });
        await funder.write.setSlippageBps([5000n], { account: admin.account });
        await funder.write.fundFromMarket([1n, usdc.address], { account: admin.account });
        expect(await usdc.read.balanceOf([funder.address])).to.equal(0n);

        const obsAfter = await funder.read.pairObservations([pair]);
        expect(Number(obsAfter[0])).to.be.gt(Number(obs[0]));
    });

    it("engine setJackpotTreasury points jackpot payouts at a new treasury", async function () {
        const [admin] = await viem.getWalletClients();
        const { engine, brb } = await deployProtocolStack();
        const treasuryV2 = await viem.deployContract("JackpotTreasury", [
            brb.address,
            engine.address,
            admin.account.address,
        ]);
        const feeRole = keccak256(toBytes("ENGINE_FEE_ROLE"));
        await engine.write.grantRole([feeRole, admin.account.address], { account: admin.account });
        await engine.write.setJackpotTreasury([treasuryV2.address], { account: admin.account });
        expect(getAddress(await engine.read.JACKPOT_TREASURY())).to.equal(getAddress(treasuryV2.address));
    });

    it("engine setJackpotFunder points settlement at a new funder", async function () {
        const [admin] = await viem.getWalletClients();
        const { engine, brb, jackpotTreasury } = await deployProtocolStack();
        const router = await viem.deployContract("MockUniswapV2Router", [], { account: admin.account });

        const registry = await viem.getContractAt("MarketRegistry", await engine.read.REGISTRY());
        const sideBetAddr = await registry.read.SIDE_BET();

        const funderV2 = await viem.deployContract(
            "BRBJackpotFunder",
            [engine.address, brb.address, router.address, jackpotTreasury.address, sideBetAddr, admin.account.address],
            { account: admin.account },
        );

        const feeRole = keccak256(toBytes("ENGINE_FEE_ROLE"));
        await engine.write.grantRole([feeRole, admin.account.address], { account: admin.account });
        await engine.write.setJackpotFunder([funderV2.address], { account: admin.account });

        expect(getAddress(await engine.read.JACKPOT_FUNDER())).to.equal(getAddress(funderV2.address));
    });
});
