import { viem } from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { encodeFunctionData, zeroAddress } from "viem";

async function fixture() {
    const [admin, alice, bob] = await viem.getWalletClients();
    const asset = await viem.deployContract("MockUSDC");
    const engine = await viem.deployContract("MockRoundEngine");
    const implementation = await viem.deployContract("BankVault4626");
    const data = encodeFunctionData({ abi: implementation.abi, functionName: "initialize", args: [{
        assetToken: asset.address, name: "Protection test", symbol: "PT", marketId: 1,
        engine: engine.address, admin: admin.account.address, minBet: 1n, sideBetController: admin.account.address,
    }] });
    const proxy = await viem.deployContract("ERC1967Proxy", [implementation.address, data]);
    const bank = await viem.getContractAt("BankVault4626", proxy.address);
    for (const wallet of [alice, bob]) {
        await asset.write.mint([wallet.account.address, 10000n]);
        await asset.write.approve([bank.address, 10000n], { account: wallet.account });
    }
    // Keep day-boundary assertions independent of the wall clock.
    await time.increaseTo(Math.ceil((await time.latest()) / 86400) * 86400 + 60);
    const set = (cap = 100n, seconds = 3600) => bank.write.setPlayerLimits([cap, seconds], { account: alice.account });
    const bet = (amount: bigint) => bank.write.placeBet([amount, "0x", zeroAddress], { account: alice.account });
    const state = () => bank.read.playerLimits([alice.account.address]);
    return { admin, alice, bob, bank, asset, set, bet, state };
}

describe("Voluntary player protection", function () {
    it("shares a gross-stake budget across roulette and side bets", async () => {
        const { admin, alice, bank, set, bet, state } = await loadFixture(fixture);
        await set();
        await bet(60n);
        await bank.write.lockSideBetStake([alice.account.address, 40n, 40n], { account: admin.account });
        expect((await state()).spent).to.equal(100n);
        await expect(bet(1n)).to.be.rejectedWith("PlayerDailyLimitExceeded");
        await expect(bank.write.lockSideBetStake([alice.account.address, 1n, 1n], { account: admin.account }))
            .to.be.rejectedWith("PlayerDailyLimitExceeded");
    });

    it("counts stakes before opt-in and never resets them on configuration", async () => {
        const { bet, set, state } = await loadFixture(fixture);
        await bet(80n);
        await set(50n);
        expect((await state()).spent).to.equal(80n);
        await expect(bet(1n)).to.be.rejectedWith("PlayerDailyLimitExceeded");
    });

    it("tightens immediately and delays increases for 24 hours", async () => {
        const { set, state } = await loadFixture(fixture);
        await set(100n, 3600);
        await set(50n, 7200);
        const limited = await state();
        expect(limited.dailyLimit).to.equal(50n);
        expect(limited.sessionSeconds).to.equal(3600);
        expect(limited.pendingSessionSeconds).to.equal(7200);
        await time.increaseTo(limited.changesAt);
        expect((await state()).sessionSeconds).to.equal(7200);
        await set(40n, 60);
        expect((await state()).changesAt).to.equal(0n);
    });

    it("blocks an expired session until its rolling 24-hour reset, including midnight", async () => {
        const { bet, set, state } = await loadFixture(fixture);
        await time.increase(86300);
        await set(100n, 60);
        await bet(1n);
        const start = (await state()).sessionStartedAt;
        await time.increaseTo(start + 60n);
        await expect(bet(1n)).to.be.rejectedWith("PlayerSessionExpired");
        await set(90n, 60);
        await expect(bet(1n)).to.be.rejectedWith("PlayerSessionExpired");
        await time.increaseTo(start + 86400n);
        await bet(1n);
    });

    it("resets daily spend at UTC midnight without granting extra session time", async () => {
        const { bet, set, state } = await loadFixture(fixture);
        await set(10n, 86400);
        await bet(10n);
        await expect(bet(1n)).to.be.rejectedWith("PlayerDailyLimitExceeded");
        const previous = await state();
        await time.increaseTo((previous.spentDay + 1n) * 86400n);
        expect((await state()).spent).to.equal(0n);
        await bet(1n);
        expect((await state()).sessionStartedAt).to.equal(previous.sessionStartedAt);
    });

    it("self-exclusion cannot be shortened and covers permit and controller paths", async () => {
        const { admin, alice, bank, bet, state } = await loadFixture(fixture);
        await bank.write.selfExclude([7 * 86400], { account: alice.account });
        await expect(bank.write.selfExclude([86400], { account: alice.account })).to.be.rejectedWith("InvalidPlayerLimits");
        await expect(bet(1n)).to.be.rejectedWith("PlayerSelfExcluded");
        await expect(bank.write.lockSideBetStake([alice.account.address, 1n, 1n], { account: admin.account })).to.be.rejectedWith("PlayerSelfExcluded");
        const zero = `0x${"00".repeat(32)}` as `0x${string}`;
        await expect(bank.write.placeBetWithPermit([1n, "0x", zeroAddress, 0n, 0, zero, zero], { account: alice.account }))
            .to.be.rejectedWith("PlayerSelfExcluded");
        await time.increaseTo((await state()).excludedUntil);
        await bet(1n);
    });

    it("isolates wallets and rolls back counters when token transfer fails", async () => {
        const { alice, bob, bank, asset, set, bet, state } = await loadFixture(fixture);
        await set(100n);
        await bank.write.selfExclude([86400], { account: bob.account });
        await asset.write.approve([bank.address, 0n], { account: alice.account });
        await expect(bet(10n)).to.be.rejected;
        expect((await state()).spent).to.equal(0n);
        expect((await state()).excludedUntil).to.equal(0n);
    });

    it("does not block withdrawals or settlement for excluded players", async () => {
        const { alice, bank, asset } = await loadFixture(fixture);
        await asset.write.mint([alice.account.address, 100000000n]);
        await asset.write.approve([bank.address, 100000000n], { account: alice.account });
        await bank.write.deposit([100000000n, alice.account.address], { account: alice.account });
        await bank.write.selfExclude([86400], { account: alice.account });
        const shares = await bank.read.balanceOf([alice.account.address]);
        await bank.write.redeem([shares, alice.account.address, alice.account.address], { account: alice.account });
        await bank.write.drainWithdrawalQueue([1n], { account: alice.account });
        expect(await bank.read.balanceOf([alice.account.address])).to.equal(0n);
    });
});
