import { expect } from "chai";
import { mkdirSync, writeFileSync } from "node:fs";
import { network, viem } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { createPublicClient, createWalletClient, custom, http, parseAbi, parseEther } from "viem";
import * as config from "../scripts/constants/arbitrumOne";
import { deployProductionRouletteEngine } from "../scripts/utils/deployRouletteEngine";
import { deployKeeperAutomation } from "../scripts/utils/deployKeeperAutomation";
import { createInfrastructureVrfSubscription, fundHouseBot, gasShortfall, stakeInfrastructureBrb, topUpGasWallets } from "../scripts/utils/mainnetBrbTest";
import { checkProductionArtifacts } from "../scripts/utils/mainnetRelease";
import { vrfAddConsumerIfNeeded } from "../scripts/utils/vrfSubscription";
import { laneCheckData } from "./helpers/parallelUpkeep";
import { encodeSingleBet } from "./helpers/multiBetEncode";

const suite = process.env.RUN_ARBITRUM_FORK === "1" ? describe : describe.skip;
suite("Arbitrum BRB architecture rehearsal without DEX liquidity", function () {
    this.timeout(900_000);
    let pinnedBlock: number;
    before(async () => {
        if (network.name !== "hardhat" || await (await viem.getPublicClient()).getChainId() !== 31337) throw new Error("Fork writes require isolated Hardhat chain 31337");
        const sourceUrl = "https://arb1.arbitrum.io/rpc";
        const source = createPublicClient({ transport: http(sourceUrl, { timeout: 30_000, retryCount: 1 }) });
        if (await source.getChainId() !== 42161) throw new Error("Wrong fork source chain");
        pinnedBlock = Number(await source.getBlockNumber());
        await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: sourceUrl, blockNumber: pinnedBlock } }] });
        console.log(`Fork pinned at Arbitrum block ${pinnedBlock}; writes only to local chain 31337`);
    });
    after(async () => { await network.provider.request({ method: "hardhat_reset", params: [] }); });

    it("funds configured wallets, stakes infra, settles BRB and processes funding without a pair", async () => {
        const pc = await viem.getPublicClient();
        expect(await pc.getChainId()).to.equal(31337);
        const [deployer, stranger] = await viem.getWalletClients();
        const admin = deployer.account.address;
        // All recipient signatures are JSON-RPC impersonation on the isolated fork. No saved key is loaded.
        for (const address of [config.INFRA_WALLET, config.MARKETING_WALLET, config.KEEPER_WALLET]) {
            await network.provider.request({ method: "hardhat_impersonateAccount", params: [address] });
        }
        for (const address of [config.INFRA_WALLET, config.MARKETING_WALLET, config.KEEPER_WALLET, config.HOUSE_BOT_WALLET]) {
            await network.provider.request({ method: "hardhat_setBalance", params: [address, "0x0"] });
        }
        const infrastructure = createWalletClient({ account: config.INFRA_WALLET, chain: pc.chain, transport: custom(network.provider) });
        const marketing = createWalletClient({ account: config.MARKETING_WALLET, chain: pc.chain, transport: custom(network.provider) });
        const waitWrite = async (hash: Promise<`0x${string}`>) => {
            const receipt = await pc.waitForTransactionReceipt({ hash: await hash });
            expect(receipt.status).to.equal("success");
        };
        const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
        const usdcBefore = await pc.readContract({ address: config.USDC, abi: tokenAbi, functionName: "balanceOf", args: [admin] });
        const sizes = await checkProductionArtifacts();
        expect(gasShortfall(2n, 1n)).to.equal(0n);
        const gasFunding = await topUpGasWallets({ deployer, client: pc, waitWrite, recipients: [
            { name: "keeper", address: config.KEEPER_WALLET, target: config.KEEPER_GAS_TARGET },
            { name: "infrastructure", address: config.INFRA_WALLET, target: config.INFRA_GAS_TARGET },
            { name: "marketing", address: config.MARKETING_WALLET, target: config.MARKETING_GAS_TARGET + config.HOUSE_BOT_GAS_TARGET + config.MARKETING_TRANSFER_GAS_BUFFER },
        ] });
        // A second top-up sends no duplicate ETH when targets are already reached.
        const again = await topUpGasWallets({ deployer, client: pc, waitWrite, recipients: [
            { name: "keeper", address: config.KEEPER_WALLET, target: config.KEEPER_GAS_TARGET },
        ] });
        expect(again[0].amountWei).to.equal("0");
        expect(again[0].hash).to.equal(undefined);
        console.log("Wallet gas targets funded; deploying real protocol stack");
        const brb = await viem.deployContract("BRBToken", [admin]);
        // Fixture-only LINK borrowing: no real holder is funded/debited on Arbitrum.
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [config.VRF_COORDINATOR] });
        await network.provider.request({ method: "hardhat_setBalance", params: [config.VRF_COORDINATOR, "0x56bc75e2d63100000"] });
        await waitWrite(deployer.writeContract({ address: config.LINK_TOKEN, abi: tokenAbi, functionName: "transfer", args: [admin, parseEther("11.952032734339140742")], account: config.VRF_COORDINATOR }));
        const infrastructureVrf = await createInfrastructureVrfSubscription({ deployer, infrastructure, client: pc,
            link: config.LINK_TOKEN, coordinator: config.VRF_COORDINATOR, waitWrite });
        const subscriptionId = infrastructureVrf.subscriptionId;
        expect(infrastructureVrf.owner.toLowerCase()).to.equal(config.INFRA_WALLET.toLowerCase());
        expect(infrastructureVrf.fundedJuels).to.equal(parseEther("11.952032734339140742"));
        expect(await pc.readContract({ address: config.LINK_TOKEN, abi: tokenAbi, functionName: "balanceOf", args: [admin] })).to.equal(0n);
        const stack = await deployProductionRouletteEngine({ brb: brb.address, router: config.UNISWAP_V2_ROUTER,
            admin, infraRecipient: config.INFRA_WALLET, coordinator: config.VRF_COORDINATOR, subscriptionId,
            callbackGasLimit: config.VRF_CALLBACK_GAS_LIMIT, confirmations: config.VRF_CONFIRMATIONS,
            roundDuration: config.ROUND_DURATION_SECONDS,
            vrfKeyHashes: [config.VRF_KEY_HASH_2_GWEI, config.VRF_KEY_HASH_30_GWEI, config.VRF_KEY_HASH_150_GWEI],
            scheduler: { admin, scanLimit: config.UPKEEP_SCAN_LIMIT, maxPayoutsPerCall: config.UPKEEP_MAX_PAYOUTS_PER_CALL },
        });
        const { engine, scheduler, registry, funder, jackpotTreasury, sideBet } = stack;
        await vrfAddConsumerIfNeeded(infrastructure, pc, config.VRF_COORDINATOR, subscriptionId, engine.address);
        await waitWrite(engine.write.setPayoutLaneCount([config.PAYOUT_LANE_COUNT]));
        const automation = await deployKeeperAutomation({ scheduler: scheduler.address, admin, keeper: config.KEEPER_WALLET, wallet: deployer, publicClient: pc, waitWrite });
        const vaultImpl = await viem.deployContract("BankVault4626");
        const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin]);
        await waitWrite(registry.write.setVaultBeacon([beacon.address]));
        await waitWrite(registry.write.createMarket([{ asset: brb.address, bankAdmin: admin, minBet: config.MIN_BET_BRB }]));
        const bank = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([1])).bank);
        const tipJar = await viem.deployContract("TipJar", [brb.address, engine.address]);
        expect((await engine.read.INFRA_RECIPIENT()).toLowerCase()).to.equal(config.INFRA_WALLET.toLowerCase());
        expect(await registry.read.marketCount()).to.equal(1);
        expect((await registry.read.getMarket([1])).asset.toLowerCase()).to.equal(brb.address.toLowerCase());
        expect(BigInt(await sideBet.read.CHALLENGE_EVALUATOR())).to.be.gt(0n);
        await waitWrite(brb.write.transfer([config.INFRA_WALLET, config.BRB_INFRA_AMOUNT]));
        await waitWrite(brb.write.transfer([config.MARKETING_WALLET, config.BRB_MARKETING_AMOUNT]));
        const infrastructureStake = await stakeInfrastructureBrb({ token: brb.address, bank: bank.address, infrastructure, client: pc, amount: config.BRB_INFRA_STAKE_AMOUNT, waitWrite });
        const houseBotFunding = await fundHouseBot({ token: brb.address, marketing, houseBot: config.HOUSE_BOT_WALLET, client: pc,
            brbAmount: config.HOUSE_BOT_BRB_AMOUNT, ethTarget: config.HOUSE_BOT_GAS_TARGET, marketingEthReserve: config.MARKETING_GAS_TARGET, waitWrite });
        expect(await bank.read.totalAssets()).to.equal(config.BRB_INFRA_AMOUNT);
        expect(await bank.read.balanceOf([config.INFRA_WALLET])).to.be.gt(0n);
        expect(await bank.read.balanceOf([admin])).to.equal(0n);
        expect(await brb.read.balanceOf([config.INFRA_WALLET])).to.equal(0n);
        expect(await brb.read.balanceOf([config.MARKETING_WALLET])).to.equal(config.BRB_MARKETING_AMOUNT - config.HOUSE_BOT_BRB_AMOUNT);
        expect(await brb.read.balanceOf([config.HOUSE_BOT_WALLET])).to.equal(config.HOUSE_BOT_BRB_AMOUNT);
        expect(await brb.read.balanceOf([admin])).to.equal(config.BRB_LIQUIDITY_AMOUNT);
        expect(await pc.getBalance({ address: config.HOUSE_BOT_WALLET })).to.equal(config.HOUSE_BOT_GAS_TARGET);
        const factory = await viem.getContractAt("UniswapV2Factory", config.UNISWAP_V2_FACTORY);
        for (const asset of [config.USDC, config.DAI]) expect(BigInt(await factory.read.getPair([asset, brb.address]))).to.equal(0n);
        expect(await pc.readContract({ address: config.USDC, abi: tokenAbi, functionName: "balanceOf", args: [admin] })).to.equal(usdcBefore);
        console.log("Genesis allocation, infra shares, marketing/house bot and deferred liquidity verified");
        // Only the fork places a wager. Live deployment does not gamble the liquidity reserve.
        await waitWrite(brb.write.approve([bank.address, parseEther("1")]));
        await waitWrite(bank.write.placeBet([parseEther("1"), encodeSingleBet(1n, 1n, parseEther("1")), stranger.account.address]));
        await time.increase(config.ROUND_DURATION_SECONDS + 1);
        const infraBrbBeforeRound = await brb.read.balanceOf([config.INFRA_WALLET]);
        const sweep = async () => {
            let progressed = false;
            for (let lane = 0n; lane < BigInt(config.PAYOUT_LANE_COUNT); lane++) {
                const [needed, data] = await scheduler.read.checkUpkeep([laneCheckData(lane)]);
                if (needed) { await waitWrite(scheduler.write.performUpkeep([data], { account: config.KEEPER_WALLET, gas: 3_000_000n })); progressed = true; }
            }
            return progressed;
        };
        for (let i = 0; i < 15 && !await engine.read.hasPendingVrf(); i++) await sweep();
        expect(await engine.read.hasPendingVrf()).to.equal(true);
        const requests = await pc.getContractEvents({ address: engine.address, abi: engine.abi, eventName: "VrfRequested", fromBlock: BigInt(pinnedBlock) });
        await waitWrite(engine.write.rawFulfillRandomWords([requests.at(-1)!.args.requestId!, [8n, 9n]], { account: config.VRF_COORDINATOR, gas: 2_500_000n }));
        for (let i = 0; i < 15; i++) if (!await sweep()) break;
        expect(await engine.read.currentGlobalRound()).to.equal(2n);
        const roundFee = await brb.read.balanceOf([config.INFRA_WALLET]) - infraBrbBeforeRound;
        expect(roundFee).to.equal(parseEther("0.02"));
        // A separate fork-only LP deposit/withdrawal proves the existing 1-token withdrawal fee routing.
        await waitWrite(brb.write.approve([bank.address, parseEther("10")]));
        const infraBeforeDeposit = await brb.read.balanceOf([config.INFRA_WALLET]);
        await waitWrite(bank.write.deposit([parseEther("10"), admin]));
        expect(await brb.read.balanceOf([config.INFRA_WALLET])).to.equal(infraBeforeDeposit);
        await waitWrite(bank.write.redeemBps([10_000, admin, admin]));
        await waitWrite(bank.write.drainWithdrawalQueue([10n]));
        expect(await brb.read.balanceOf([config.INFRA_WALLET]) - infraBeforeDeposit).to.equal(parseEther("1"));
        expect((await funder.read.fundingAccounts([1]))[1]).to.be.gt(0n);
        const supplyBeforeFunding = await brb.read.totalSupply();
        const treasuryBeforeFunding = await brb.read.balanceOf([jackpotTreasury.address]);
        await waitWrite(funder.write.processFundingBatch([[1]], { account: config.KEEPER_WALLET, gas: 1_500_000n }));
        expect((await funder.read.fundingAccounts([1]))[1]).to.equal(0n);
        expect(await funder.read.consecutiveFailures([1])).to.equal(0);
        expect(await brb.read.totalSupply()).to.be.lt(supplyBeforeFunding);
        expect(await brb.read.balanceOf([jackpotTreasury.address])).to.be.gt(treasuryBeforeFunding);
        expect(await pc.readContract({ address: config.USDC, abi: tokenAbi, functionName: "balanceOf", args: [admin] })).to.equal(usdcBefore);
        for (const asset of [config.USDC, config.DAI]) expect(BigInt(await factory.read.getPair([asset, brb.address]))).to.equal(0n);
        const report = { checkedAt: new Date().toISOString(), sourceChainId: 42161, localChainId: 31337, pinnedBlock,
            deploymentMode: config.MAINNET_DEPLOYMENT_MODE, vrfOwner: infrastructureVrf.owner, vrfFundedJuels: infrastructureVrf.fundedJuels.toString(), roundInfrastructureFee: roundFee.toString(), withdrawalInfrastructureFee: parseEther("1").toString(), sizes, gasFunding, infrastructureStake, houseBotFunding,
            addresses: { brb: brb.address, engine: engine.address, sideBet: sideBet.address, registry: registry.address,
                scheduler: scheduler.address, bank: bank.address, tipJar: tipJar.address, ...automation },
            marketCount: 1, infrastructureStakedBrb: "300000", houseBotBrb: "1000", marketingRemainingBrb: "299000",
            pairsCreated: false, usdcUntouched: true, realCoordinatorRequestAccepted: true,
            keeperSettlementCompleted: true, brbFundingWithoutPairCompleted: true,
            limitations: ["Recipient accounts impersonated only on local chain; saved mainnet keys not used for fork signatures", "LINK borrowed only in disposable fork", "Oracle fulfillment simulated; live DON delivery and Cloudflare hosting not proven", "Hardhat fork does not reproduce Arbitrum sequencer or L1 fee behavior", "Shared production deployment helpers exercised; live-only entrypoint chain gates not bypassed"] };
        mkdirSync("reports/fork", { recursive: true });
        writeFileSync("reports/fork/arbitrum-one-brb-architecture.json", JSON.stringify(report, null, 2) + "\n");
        console.log(JSON.stringify(report));
    });
});
