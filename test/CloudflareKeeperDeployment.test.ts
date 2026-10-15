import { rejects } from "node:assert/strict";
import { expect } from "chai";
import { viem } from "hardhat";
import { parseEther } from "viem";
import { deployProductionRouletteEngine } from "../scripts/utils/deployRouletteEngine";
import { deployKeeperAutomation } from "../scripts/utils/deployKeeperAutomation";

describe("Cloudflare production deployment wiring", function () {
    it("deploys real prefix addresses and referral, and approves only the dedicated keeper", async function () {
        const [admin, keeper, stranger] = await viem.getWalletClients();
        const client = await viem.getPublicClient();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const coordinator = await viem.deployContract("MockVrfCoordinator");
        const router = await viem.deployContract("MockUniswapV2Router");
        const key = "0x" + "11".repeat(32) as `0x${string}`;
        const stack = await deployProductionRouletteEngine({
            brb: brb.address, router: router.address, admin: admin.account.address,
            infraRecipient: stranger.account.address, coordinator: coordinator.address,
            subscriptionId: 1n, callbackGasLimit: 2_500_000, confirmations: 3, roundDuration: 300,
            vrfKeyHashes: [key, key, key],
            scheduler: { admin: admin.account.address, scanLimit: 25, maxPayoutsPerCall: 60 },
        });
        expect((await stack.engine.read.REGISTRY()).toLowerCase()).to.equal(stack.registry.address.toLowerCase());
        expect((await stack.engine.read.JACKPOT_TREASURY()).toLowerCase()).to.equal(stack.jackpotTreasury.address.toLowerCase());
        expect((await stack.engine.read.JACKPOT_FUNDER()).toLowerCase()).to.equal(stack.funder.address.toLowerCase());
        expect((await stack.engine.read.UPKEEP_SCHEDULER()).toLowerCase()).to.equal(stack.scheduler.address.toLowerCase());
        expect((await stack.funder.read.router()).toLowerCase()).to.equal(router.address.toLowerCase());
        expect((await stack.registry.read.SIDE_BET()).toLowerCase()).to.equal(stack.sideBet.address.toLowerCase());
        expect((await stack.sideBet.read.ENGINE()).toLowerCase()).to.equal(stack.engine.address.toLowerCase());
        const referral = await viem.getContractAt("BRBReferal", stack.brbReferral);
        expect(await client.getBytecode({ address: referral.address })).not.to.equal("0x");
        expect(await stack.sideBet.read.hasRole([await stack.sideBet.read.SETTLEMENT_ROLE(), stack.scheduler.address])).to.equal(true);
        const waitWrite = async (hash: Promise<`0x${string}`>) => {
            expect((await client.waitForTransactionReceipt({ hash: await hash })).status).to.equal("success");
        };
        const automation = await deployKeeperAutomation({ scheduler: stack.scheduler.address, admin: admin.account.address,
            keeper: keeper.account.address, wallet: admin, publicClient: client, waitWrite });
        const authority = await viem.getContractAt("CreExecutionAuthority", automation.creExecutionAuthority);
        expect(await authority.read.isApprovedAutomationForwarder([keeper.account.address])).to.equal(true);
        expect(await authority.read.isApprovedAutomationForwarder([stranger.account.address])).to.equal(false);
        expect(await authority.read.hasRole([await authority.read.DEFAULT_ADMIN_ROLE(), keeper.account.address])).to.equal(false);
        expect((await stack.scheduler.read.forwarderAuthority()).toLowerCase()).to.equal(authority.address.toLowerCase());
        await rejects(stack.scheduler.write.performUpkeep(["0x"], { account: stranger.account }));
        expect(await client.getBalance({ address: keeper.account.address })).to.be.greaterThan(parseEther("0.005"));
    });
});
