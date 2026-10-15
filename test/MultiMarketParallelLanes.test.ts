import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { encodeAbiParameters, parseUnits, zeroAddress } from "viem";

import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";

import { decodeRoulettePerformData } from "./helpers/decodeUpkeepPerformData";
import {
    fulfillVrfForGlobalRound,
    laneCheckData,
    runParallelLanesUntilVrfPending,
} from "./helpers/parallelUpkeep";

const LANE_COUNT = 10n;
const STRAIGHT = 1n;

function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

describe("Multi-market parallel lane assignment", function () {
    it("assigns idle lanes to later markets while earlier markets still settle", async function () {
        const [admin] = await viem.getWalletClients();
        const publicClient = await viem.getPublicClient();
        const stake = parseUnits("10", 6);

        const usdc = await viem.deployContract("MockUSDC");
        const dai = await viem.deployContract("MockUSDC");
        const vrf = await viem.deployContract("MockVrfCoordinator");
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const mockRouter = await viem.deployContract("MockUniswapV2Router");
        const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;

        const { engine, scheduler, registry } = await deployRouletteEngine(
            [mockLaneKey, mockLaneKey, mockLaneKey],
            [
                zeroAddress,
                zeroAddress,
                zeroAddress,
                admin.account.address,
                vrf.address,
                1n,
                2_000_000,
                1,
                500,
                admin.account.address,
            ],
            { admin: admin.account.address, scanLimit: 25, maxPayoutsPerCall: 60 },
            {
                protocolPrefix: {
                    brb: brb.address,
                    mockRouter: mockRouter.address,
                    admin: admin.account.address,
                },
            },
        );

        const vaultImpl = await viem.deployContract("BankVault4626");
        const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
        await registry.write.setVaultBeacon([beacon.address], { account: admin.account });

        for (const asset of [usdc, dai]) {
            await registry.write.createMarket([{ asset: asset.address, bankAdmin: admin.account.address, minBet: 1_000_000n }], {
                account: admin.account,
            });
        }

        const bankUsdc = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([1])).bank);
        const bankDai = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([2])).bank);

        const lp = parseUnits("100000", 6);
        for (const [token, bank] of [
            [usdc, bankUsdc],
            [dai, bankDai],
        ] as const) {
            await token.write.mint([admin.account.address, lp], { account: admin.account });
            await token.write.approve([bank.address, lp], { account: admin.account });
            await bank.write.deposit([lp, admin.account.address], { account: admin.account });
        }

        const straight7 = encodeSingleBet(STRAIGHT, 7n, stake);
        // Market 1: few winners → only lanes 0–2 have shard work; other lanes can start market 2 immediately.
        await usdc.write.mint([admin.account.address, stake * 5n], { account: admin.account });
        await usdc.write.approve([bankUsdc.address, stake * 5n], { account: admin.account });
        for (let i = 0; i < 3; i++) {
            await bankUsdc.write.placeBet([stake, straight7, zeroAddress], { account: admin.account });
        }

        await dai.write.mint([admin.account.address, stake * 35n], { account: admin.account });
        await dai.write.approve([bankDai.address, stake * 35n], { account: admin.account });
        for (let i = 0; i < 30; i++) {
            await bankDai.write.placeBet([stake, straight7, zeroAddress], { account: admin.account });
        }

        await time.increase(550);
        await runParallelLanesUntilVrfPending(engine, scheduler, { laneCount: LANE_COUNT });
        await fulfillVrfForGlobalRound(publicClient, vrf, engine, 1n, 7n);

        const marketsByLane = new Map<number, number>();
        for (let lane = 0; lane < Number(LANE_COUNT); lane++) {
            const [needed, performData] = await scheduler.read.checkUpkeep([laneCheckData(BigInt(lane))]);
            if (!needed) continue;
            const decoded = decodeRoulettePerformData(performData);
            expect(decoded.jobKind).to.equal(2);
            marketsByLane.set(lane, decoded.marketId);
        }

        expect(marketsByLane.size).to.be.greaterThan(1, "multiple lanes should have payout work");

        const uniqueMarkets = new Set(marketsByLane.values());
        expect(uniqueMarkets.size).to.be.greaterThan(
            1,
            "idle lanes should start later markets while market 1 shards are still in flight",
        );
    });
});
