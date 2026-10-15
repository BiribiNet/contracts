import { artifacts, network, viem } from "hardhat";
import { vars } from "hardhat/config";
import { expect } from "chai";
import { createPublicClient, http, parseAbi, parseEther, parseUnits, zeroAddress } from "viem";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { mkdirSync, writeFileSync } from "node:fs";
import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";
import { vrfCreateSubscription, vrfAddConsumerIfNeeded, vrfFundSubscriptionWithLink } from "../scripts/utils/vrfSubscription";
import { encodeMultiBet, straightLegs, encodeSingleBet } from "./helpers/multiBetEncode";
import { createMarketWithBeacon } from "./helpers/createMarket";
import { runParallelLanesUntilIdle, runParallelLanesUntilVrfPending } from "./helpers/parallelUpkeep";
import { checkProductionArtifacts } from "../scripts/utils/mainnetRelease";

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const DAI = "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" as const;
const LINK = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4" as const;
const COORDINATOR = "0x3C0Ca683b403E37668AE3DC4FB62F4B29B6f7a3e" as const;
// Official Uniswap/contracts deployments/json/42161.json (not the vendored Sepolia factory).
const ROUTER = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" as const;
const FACTORY = "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9" as const;
const KEYS = ["0x9e9e46732b32662b9adc6f3abdf6c5e926a666d174a4d6b8e39c4cca76a38897", "0x8472ba59cf7134dfe321f4d61a430c4857e8b19cdd5230b09952a92671c24409", "0xe9f223d7d83ec85c4f78042a4845af3a1c8df7757b4997b815ce4b8d07aca68c"] as const;

(process.env.RUN_ARBITRUM_FORK === "1" ? describe : describe.skip)("Arbitrum One isolated deployment rehearsal", function () {
  this.timeout(900_000);
  let pinnedBlock: number;
  before(async () => {
    if (network.name !== "hardhat" || await (await viem.getPublicClient()).getChainId() !== 31337) throw new Error("Fork writes require the isolated Hardhat chain 31337");
    const url = process.env.ARBITRUM_FORK_URL || (vars.has("ARBITRUM_RPC_URL") ? vars.get("ARBITRUM_RPC_URL") : "https://arb1.arbitrum.io/rpc");
    // The upstream client is read-only and has no wallet/private key.
    const source = createPublicClient({ transport: http(url, { timeout: 20_000, retryCount: 0 }) });
    if (await source.getChainId() !== 42161) throw new Error("Fork source is not Arbitrum One");
    pinnedBlock = process.env.ARBITRUM_FORK_BLOCK ? Number(process.env.ARBITRUM_FORK_BLOCK) : Number(await source.getBlockNumber());
    if (!Number.isSafeInteger(pinnedBlock) || pinnedBlock < 1) throw new Error("Invalid fork block");
    console.log(`Read-only Arbitrum source pinned at block ${pinnedBlock}; all transactions remain on local chain 31337.`);
    await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: url, blockNumber: pinnedBlock } }] });
  });
  after(async () => { await network.provider.request({ method: "hardhat_reset", params: [] }); });

  it("deploys within bytecode limits, uses real USDC/V2/VRF, settles and drains queued funding", async () => {
    const pc = await viem.getPublicClient();
    expect(await pc.getChainId()).to.equal(31337);
    const [wallet, alice] = await viem.getWalletClients();
    const admin = wallet.account.address;
    const sizes = await checkProductionArtifacts();
    const router = await viem.getContractAt("UniswapV2Router02", ROUTER);
    expect((await router.read.factory()).toLowerCase()).to.equal(FACTORY.toLowerCase());
    const tokenAbi = parseAbi(["function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)"]);
    for (const [token, decimals] of [[USDC, 6], [DAI, 18], [LINK, 18]] as const) {
      expect(await pc.readContract({ address: token, abi: tokenAbi, functionName: "decimals" })).to.equal(decimals);
    }
    // Local fixture funding only: impersonation never targets the upstream RPC.
    const usdcAdminAbi = parseAbi(["function masterMinter() view returns (address)", "function configureMinter(address,uint256) returns (bool)", "function mint(address,uint256) returns (bool)"]);
    const minter = await pc.readContract({ address: USDC, abi: usdcAdminAbi, functionName: "masterMinter" });
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [minter] });
    await network.provider.request({ method: "hardhat_setBalance", params: [minter, "0x56bc75e2d63100000"] });
    await wallet.writeContract({ address: USDC, abi: usdcAdminAbi, functionName: "configureMinter", args: [admin, parseUnits("1000000", 6)], account: minter });
    await wallet.writeContract({ address: USDC, abi: usdcAdminAbi, functionName: "mint", args: [admin, parseUnits("300000", 6)] });

    const brb = await viem.deployContract("BRBToken", [admin]);
    const subId = await vrfCreateSubscription(wallet as any, pc as any, COORDINATOR);
    // Borrow LINK from the coordinator only in the disposable fork, then return
    // it via transferAndCall. This does not prove real mainnet funding solvency.
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [COORDINATOR] });
    await network.provider.request({ method: "hardhat_setBalance", params: [COORDINATOR, "0x56bc75e2d63100000"] });
    await wallet.writeContract({ address: LINK, abi: tokenAbi, functionName: "transfer", args: [admin, parseEther("10")], account: COORDINATOR });
    await vrfFundSubscriptionWithLink(wallet as any, pc as any, LINK, COORDINATOR, subId, parseEther("10"));
    const stack = await deployRouletteEngine(KEYS, [zeroAddress, zeroAddress, zeroAddress, admin, COORDINATOR, subId, 2_500_000, 3, 100_000, admin],
      { admin, scanLimit: 25, maxPayoutsPerCall: 60 }, { protocolPrefix: { brb: brb.address, mockRouter: ROUTER, admin } });
    const { engine, scheduler, registry, funder, jackpotTreasury } = stack;
    await vrfAddConsumerIfNeeded(wallet as any, pc as any, COORDINATOR, subId, engine.address);
    const bank = await createMarketWithBeacon(registry as any, admin, USDC);
    for (const [asset, minBet] of [[DAI, parseEther("1")], [brb.address, parseEther("1")]] as const) {
      await registry!.write.createMarket([{ asset, bankAdmin: admin, minBet }]);
    }
    expect(await registry!.read.marketCount()).to.equal(3);
    await wallet.writeContract({ address: USDC, abi: tokenAbi, functionName: "approve", args: [bank.address, parseUnits("100000", 6)] });
    await bank.write.deposit([parseUnits("100000", 6), admin]);
    await wallet.writeContract({ address: USDC, abi: tokenAbi, functionName: "approve", args: [ROUTER, parseUnits("100000", 6)] });
    await brb.write.approve([ROUTER, parseEther("100000")]);
    const deadline = (await pc.getBlock()).timestamp + 100_000n;
    await router.write.addLiquidity([USDC, brb.address, parseUnits("100000", 6), parseEther("100000"), 0n, 0n, admin, deadline]);
    const factory = await viem.getContractAt("UniswapV2Factory", FACTORY);
    const pair = await factory.read.getPair([USDC, brb.address]);
    const pairMath = await viem.deployContract("UniswapV2TwapLibHarness");
    expect((await pairMath.read.pairFor([FACTORY, USDC, brb.address])).toLowerCase()).to.equal(pair.toLowerCase());
    await funder!.write.updateObservation([USDC]);
    await brb.write.transfer([jackpotTreasury!.address, parseEther("1000")]);
    await wallet.writeContract({ address: USDC, abi: tokenAbi, functionName: "transfer", args: [alice.account.address, parseUnits("10000", 6)] });
    await wallet.writeContract({ address: USDC, abi: tokenAbi, functionName: "approve", args: [bank.address, parseUnits("10000", 6)], account: alice.account });
    const bet = encodeMultiBet(straightLegs(37, parseUnits("1", 6)));
    for (let i = 0; i < 10; i++) await bank.write.placeBet([parseUnits("37", 6), bet, zeroAddress], { account: alice.account });
    await time.increase(100_100);
    await runParallelLanesUntilVrfPending(engine, scheduler);
    expect(await engine.read.hasPendingVrf()).to.equal(true); // Real coordinator accepted request/consumer/lane.
    const events = await pc.getContractEvents({ address: engine.address, abi: engine.abi, eventName: "VrfRequested", fromBlock: BigInt(pinnedBlock) });
    // Simulate oracle delivery, not the Chainlink cryptographic proof or fee accounting.
    await engine.write.rawFulfillRandomWords([events.at(-1)!.args.requestId!, [7n, 7n]], { account: COORDINATOR, gas: 2_500_000n });
    await runParallelLanesUntilIdle(scheduler);
    expect(await engine.read.currentGlobalRound()).to.equal(2n);
    expect(await jackpotTreasury!.read.jackpotPool()).to.equal(0n);
    const queue = await funder!.read.fundingAccounts([1]);
    expect(queue[1]).to.be.gt(0n);
    await funder!.write.processFundingBatch([[1]], { gas: 1_500_000n });
    expect((await funder!.read.fundingAccounts([1]))[1]).to.equal(0n);
    expect(await funder!.read.consecutiveFailures([1])).to.equal(0);

    // Populate a live wager, upgrade the vault beacon to the same compiled code,
    // and prove user shares/locked assets survive before settling another round.
    const shares = await bank.read.balanceOf([admin]);
    await bank.write.placeBet([parseUnits("1", 6), encodeSingleBet(1n, 8n, parseUnits("1", 6)), zeroAddress], { account: alice.account });
    const cfg = await registry!.read.getMarket([1]);
    const beaconAddress = await registry!.read.vaultBeacon();
    const beacon = await viem.getContractAt("UpgradeableBeacon", beaconAddress);
    const vaultImpl = await viem.deployContract("BankVault4626");
    await beacon.write.upgradeTo([vaultImpl.address]);
    expect(await bank.read.balanceOf([admin])).to.equal(shares);
    expect((await registry!.read.getMarket([1])).bank).to.equal(cfg.bank);
    await time.increase(100_100);
    await runParallelLanesUntilVrfPending(engine, scheduler);
    const next = await pc.getContractEvents({ address: engine.address, abi: engine.abi, eventName: "VrfRequested", fromBlock: BigInt(pinnedBlock) });
    await engine.write.rawFulfillRandomWords([next.at(-1)!.args.requestId!, [7n, 8n]], { account: COORDINATOR, gas: 2_500_000n });
    await runParallelLanesUntilIdle(scheduler);
    expect(await engine.read.currentGlobalRound()).to.equal(3n);
    const report = { sourceChainId: 42161, localChainId: 31337, pinnedBlock, router: ROUTER, factory: FACTORY, usdc: USDC, dai: DAI,
      coordinator: COORDINATOR, sizes, realCoordinatorRequest: true, realUsdcVault: true, realV2FundingSwap: true, vaultUpgrade: true,
      limitations: ["USDC minted and LINK borrowed only in local fixture", "oracle fulfillment simulated by local coordinator impersonation", "DAI market registered/read-checked, not wagered", "mock scheduler authority; hosted CRE and live admin credentials not rehearsed", "Hardhat EVM does not model Arbitrum sequencer or L1 fee behavior"] };
    mkdirSync("reports/fork", { recursive: true });
    writeFileSync("reports/fork/arbitrum-one.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  });
});
