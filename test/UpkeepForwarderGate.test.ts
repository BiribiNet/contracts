import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { viem } from "hardhat";
import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";
import { encodeAbiParameters, parseUnits } from "viem";

function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

async function deploySchedulerStack() {
    const [admin, alice, bob] = await viem.getWalletClients();

    const usdc = await viem.deployContract("MockUSDC");
    const vrf = await viem.deployContract("MockVrfCoordinator");
    const brb = await viem.deployContract("BRBToken", [admin.account.address]);
    const jackpotTreasury = await viem.deployContract("JackpotTreasury", [brb.address, admin.account.address]);
    const mockRouter = await viem.deployContract("MockUniswapV2Router");
    const funder = await viem.deployContract("BRBJackpotFunder", [
        "0x0000000000000000000000000000000000000000",
        brb.address,
        mockRouter.address,
        jackpotTreasury.address,
        admin.account.address,
    ]);
    const registry = await viem.deployContract("MarketRegistry", [admin.account.address]);

    const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
    const { engine, scheduler } = await deployRouletteEngine(
        [mockLaneKey, mockLaneKey, mockLaneKey],
        [
            registry.address,
            jackpotTreasury.address,
            funder.address,
            admin.account.address,
            vrf.address,
            1n,
            2_000_000,
            1,
            500,
            admin.account.address,
        ],
        { admin: admin.account.address, scanLimit: 25, maxPayoutsPerCall: 10 },
    );

    await jackpotTreasury.write.setEngine([engine.address]);
    await funder.write.setEngine([engine.address]);
    await registry.write.setEngine([engine.address], { account: admin.account });


    await brb.write.transfer([mockRouter.address, parseUnits("2000000", 18)], { account: admin.account });

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });

    await registry.write.createMarket(
        [
            {
                asset: usdc.address,
                bankAdmin: admin.account.address,

                minBet: 1_000_000n,
            },
        ],
        { account: admin.account },
    );

    const cfg = await registry.read.getMarket([1]);
    const bank = await viem.getContractAt("BankVault4626", cfg.bank);
    const lpAmount = parseUnits("5000", 6);
    await usdc.write.mint([admin.account.address, lpAmount]);
    await usdc.write.approve([bank.address, lpAmount], { account: admin.account });
    await bank.write.deposit([lpAmount, admin.account.address], { account: admin.account });
    await usdc.write.mint([alice.account.address, parseUnits("1000", 6)]);
    await usdc.write.approve([bank.address, parseUnits("1000", 6)], { account: alice.account });
    await bank.write.placeBet([parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6))], {
        account: alice.account,
    });
    await time.increase(550);

    return { admin, alice, bob, scheduler, engine };
}

describe("UpkeepScheduler Chainlink forwarder gate", function () {
    it("blocks performUpkeep when caller is not an approved Automation forwarder", async function () {
        const { admin, alice, bob, scheduler } = await deploySchedulerStack();

        const auth = await viem.deployContract("MockUpkeepForwarderAuthority");
        await scheduler.write.setForwarderAuthority([auth.address], { account: admin.account });
        await auth.write.setApproved([alice.account.address, true]);

        const [needed, performData] = await scheduler.read.checkUpkeep(["0x"]);
        expect(needed).to.equal(true);

        await expect(scheduler.write.performUpkeep([performData], { account: bob.account })).to.be.rejected;

        await scheduler.write.performUpkeep([performData], { account: alice.account });
    });

    it("allows any caller when forwarderAuthority is unset (legacy test / local tooling)", async function () {
        const { admin, scheduler } = await deploySchedulerStack();

        const [needed, performData] = await scheduler.read.checkUpkeep(["0x"]);
        expect(needed).to.equal(true);

        await scheduler.write.performUpkeep([performData], { account: admin.account });
    });
});
