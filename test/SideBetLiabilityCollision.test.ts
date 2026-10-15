import { viem } from "hardhat";

import { expect } from "chai";
import { parseUnits, zeroAddress } from "viem";

import { createMarketWithBeacon } from "./helpers/createMarket";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { encodeSingleBet } from "./helpers/multiBetEncode";

const USDC = (amount: string) => parseUnits(amount, 6);

/**
 * A side bet reserves its gross payout inside `lockedBetLiquidity`, which the roulette solvency
 * check used to ignore: it read the vault's raw ERC-20 balance, so the same tokens backed both a
 * side-bet payout and a roulette worst case. Whichever settled second could not be paid, the payout
 * lane reverted, and the round never finalized.
 *
 * `sideBetController` is pointed at an EOA so the reserve can be locked directly, without standing
 * up the whole SideBet contract.
 */
async function deployMarketWithSideBetReserve() {
    const [admin, alice, sideBetOperator] = await viem.getWalletClients();
    const { engine, registry } = await deployProtocolStack();

    const usdc = await viem.deployContract("MockUSDC");
    const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);
    await bank.write.setSideBetController([sideBetOperator.account.address], { account: admin.account });

    // LP liquidity.
    const lp = USDC("1000");
    await usdc.write.mint([admin.account.address, lp]);
    await usdc.write.approve([bank.address, lp], { account: admin.account });
    await bank.write.deposit([lp, admin.account.address], { account: admin.account });

    await usdc.write.mint([alice.account.address, USDC("500")]);
    await usdc.write.approve([bank.address, USDC("500")], { account: alice.account });

    return { admin, alice, sideBetOperator, engine, usdc, bank };
}

describe("Roulette vs side-bet liquidity collision (H-6)", function () {
    it("refuses a roulette bet whose worst case is already reserved by a side bet", async function () {
        const { alice, sideBetOperator, usdc, bank } = await deployMarketWithSideBetReserve();

        // Reserve almost the whole vault for a side-bet payout: 10 staked, 900 reserved.
        await usdc.write.mint([sideBetOperator.account.address, USDC("10")]);
        await usdc.write.approve([bank.address, USDC("10")], { account: sideBetOperator.account });
        await bank.write.lockSideBetStake([sideBetOperator.account.address, USDC("10"), USDC("900")], {
            account: sideBetOperator.account,
        });
        expect(await bank.read.lockedBetLiquidity()).to.equal(USDC("900"));

        // Raw balance is 1010, but only ~110 of it is genuinely unreserved. A 10 USDC straight bet
        // carries a 36x worst case (~360), which the vault cannot honour alongside the side bet.
        await expect(
            bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
                account: alice.account,
            }),
        ).to.be.rejected;
    });

    it("refuses a side bet that would reserve liquidity the open round still owes (H-6)", async function () {
        const { alice, sideBetOperator, usdc, bank } = await deployMarketWithSideBetReserve();

        // Roulette first: a 10 USDC straight carries a ~360 worst case against 1000 of LP liquidity.
        await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
            account: alice.account,
        });

        // The engine's solvency check is never re-run after this point, so a side bet reserving most
        // of the vault used to succeed and leave the round unable to pay its own winners.
        await usdc.write.mint([sideBetOperator.account.address, USDC("10")]);
        await usdc.write.approve([bank.address, USDC("10")], { account: sideBetOperator.account });
        await expect(
            bank.write.lockSideBetStake([sideBetOperator.account.address, USDC("10"), USDC("900")], {
                account: sideBetOperator.account,
            }),
        ).to.be.rejected;

        // A reserve that leaves the roulette liability intact is still allowed.
        await bank.write.lockSideBetStake([sideBetOperator.account.address, USDC("10"), USDC("100")], {
            account: sideBetOperator.account,
        });
    });

    it("still accepts a roulette bet that the unreserved liquidity can cover", async function () {
        const { alice, sideBetOperator, usdc, bank } = await deployMarketWithSideBetReserve();

        // A much smaller reserve leaves room for the same bet.
        await usdc.write.mint([sideBetOperator.account.address, USDC("10")]);
        await usdc.write.approve([bank.address, USDC("10")], { account: sideBetOperator.account });
        await bank.write.lockSideBetStake([sideBetOperator.account.address, USDC("10"), USDC("100")], {
            account: sideBetOperator.account,
        });

        await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
            account: alice.account,
        });
        expect(await bank.read.lockedBetLiquidity()).to.equal(USDC("110"));
    });
});
