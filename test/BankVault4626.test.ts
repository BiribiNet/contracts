import { viem } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { expect } from "chai";
import { encodeFunctionData, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { vaultInitMinBet18, vaultInitMinBetUsdc6 } from "./helpers/marketLimits";

describe("BankVault4626", function () {
    it("handles bets, liquidity locking and total assets", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address, vaultInitMinBetUsdc6),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await usdc.write.mint([alice.account.address, parseUnits("1000", 6)]);
        await usdc.write.approve([vault.address, parseUnits("500", 6)], { account: alice.account });
        await vault.write.deposit([parseUnits("100", 6), alice.account.address], { account: alice.account });

        expect(await vault.read.totalAssets()).to.equal(parseUnits("100", 6));
        await vault.write.placeBet([parseUnits("10", 6), "0x", zeroAddress], { account: alice.account });
        expect(await vault.read.lockedBetLiquidity()).to.equal(parseUnits("10", 6));
        expect(await vault.read.totalAssets()).to.equal(parseUnits("100", 6));
    });

    it("enforces guards and engine-only methods", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address, vaultInitMinBetUsdc6),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await expect(vault.write.placeBet([0n, "0x", zeroAddress], { account: alice.account })).to.be.rejected;
        await expect(vault.write.releaseBets([1n], { account: alice.account })).to.be.rejected;
        await expect(vault.write.payoutBatch([[{ player: alice.account.address, amount: 1n }]], { account: alice.account })).to
            .be.rejected;
    });

    it("caps release and pays out via engine", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address, vaultInitMinBetUsdc6),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([vault.address, parseUnits("100", 6)], { account: alice.account });
        await vault.write.placeBet([parseUnits("40", 6), "0x", zeroAddress], { account: alice.account });
        expect(await vault.read.lockedBetLiquidity()).to.equal(parseUnits("40", 6));

        await mockEngine.write.releaseFromVault([vault.address, parseUnits("999", 6)]);
        expect(await vault.read.lockedBetLiquidity()).to.equal(0n);

        await usdc.write.mint([vault.address, parseUnits("10", 6)]);
        await mockEngine.write.payoutFromVault([vault.address, [{ player: alice.account.address, amount: parseUnits("1", 6) }]]);
        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(parseUnits("61", 6));
    });

    it("reverts when bet is below minBet", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address, parseUnits("5", 6)),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);
        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([vault.address, parseUnits("100", 6)], { account: alice.account });
        await expect(vault.write.placeBet([parseUnits("4", 6), "0x", zeroAddress], { account: alice.account })).to.be.rejected;
        await vault.write.placeBet([parseUnits("5", 6), "0x", zeroAddress], { account: alice.account });
    });

    it("reverts when deposit is at or below flat fee", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address, vaultInitMinBetUsdc6),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([vault.address, parseUnits("100", 6)], { account: alice.account });
        await expect(
            vault.write.deposit([1_000_000n, alice.account.address], { account: alice.account }),
        ).to.be.rejected;
        await vault.write.deposit([parseUnits("2", 6), alice.account.address], { account: alice.account });
    });

    it("allows withdraw requests below the flat fee when bps is nonzero", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address, vaultInitMinBetUsdc6),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([vault.address, parseUnits("100", 6)], { account: alice.account });
        await vault.write.deposit([parseUnits("50", 6), alice.account.address], { account: alice.account });

        await vault.write.withdraw([1_000_000n, alice.account.address, alice.account.address], { account: alice.account });
    });

    it("charges one asset unit flat fee when processing a queued withdrawal", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address, vaultInitMinBetUsdc6),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        expect(await vault.read.flatWithdrawFee()).to.equal(1_000_000n);
        expect(await vault.read.assetDecimals()).to.equal(6);

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([vault.address, parseUnits("100", 6)], { account: alice.account });
        await vault.write.deposit([parseUnits("50", 6), alice.account.address], { account: alice.account });

        const withdrawGross = parseUnits("10", 6);
        const balanceBefore = await usdc.read.balanceOf([alice.account.address]);
        const vaultBefore = await usdc.read.balanceOf([vault.address]);
        const sharesBefore = await vault.read.balanceOf([alice.account.address]);
        await vault.write.withdraw([withdrawGross, alice.account.address, alice.account.address], {
            account: alice.account,
        });
        await mockEngine.write.processWithdrawals([vault.address, 10n]);

        const fee = 1_000_000n;
        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(balanceBefore + withdrawGross - fee);
        expect(await usdc.read.balanceOf([vault.address])).to.equal(vaultBefore - withdrawGross + fee);
        expect(await vault.read.balanceOf([alice.account.address])).to.equal((sharesBefore * 8_000n) / 10_000n);
    });

    it("settles 100% bps at process-time NAV after vault loss", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address, vaultInitMinBetUsdc6),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([vault.address, parseUnits("100", 6)], { account: alice.account });
        await vault.write.deposit([parseUnits("50", 6), alice.account.address], { account: alice.account });

        const balanceBefore = await usdc.read.balanceOf([alice.account.address]);
        await vault.write.redeemBps([10_000, alice.account.address, alice.account.address], { account: alice.account });

        const loss = parseUnits("10", 6);
        await mockEngine.write.transferOutFromVault([vault.address, admin.account.address, loss]);
        await mockEngine.write.processWithdrawals([vault.address, 10n]);

        const fee = 1_000_000n;
        const expectedPayout = parseUnits("40", 6) - fee;
        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(balanceBefore + expectedPayout);
        expect(await vault.read.balanceOf([alice.account.address])).to.equal(0n);
    });

    it("burns shares and pays zero when post-settlement gross is below flat fee", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address, vaultInitMinBetUsdc6),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([vault.address, parseUnits("100", 6)], { account: alice.account });
        await vault.write.deposit([parseUnits("2", 6), alice.account.address], { account: alice.account });

        const balanceBefore = await usdc.read.balanceOf([alice.account.address]);
        await vault.write.redeemBps([10_000, alice.account.address, alice.account.address], { account: alice.account });
        await mockEngine.write.transferOutFromVault([vault.address, admin.account.address, parseUnits("1.5", 6)]);
        await mockEngine.write.processWithdrawals([vault.address, 10n]);

        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(balanceBefore);
        expect(await vault.read.balanceOf([alice.account.address])).to.equal(0n);
    });

    it("rejects zero-share withdrawal requests so sybils cannot fill the queue (H-2)", async function () {
        const [admin, alice, sybil] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address, vaultInitMinBetUsdc6),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([vault.address, parseUnits("100", 6)], { account: alice.account });
        await vault.write.deposit([parseUnits("50", 6), alice.account.address], { account: alice.account });

        // A holder-less address could queue a request that can never pay out, consuming one of the
        // queue's bounded slots. All three entrypoints must reject it consistently.
        expect(await vault.read.balanceOf([sybil.account.address])).to.equal(0n);
        await expect(
            vault.write.redeemBps([10_000, sybil.account.address, sybil.account.address], { account: sybil.account }),
        ).to.be.rejected;
        await expect(
            vault.write.redeem([0n, sybil.account.address, sybil.account.address], { account: sybil.account }),
        ).to.be.rejected;
        await expect(
            vault.write.withdraw([0n, sybil.account.address, sybil.account.address], { account: sybil.account }),
        ).to.be.rejected;

        // A real holder is unaffected.
        await vault.write.redeemBps([10_000, alice.account.address, alice.account.address], { account: alice.account });
    });

    it("processes a queued request whose shares were transferred away after enqueueing", async function () {
        const [admin, alice, bob] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address, vaultInitMinBetUsdc6),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([vault.address, parseUnits("100", 6)], { account: alice.account });
        await vault.write.deposit([parseUnits("50", 6), alice.account.address], { account: alice.account });

        await vault.write.redeemBps([10_000, alice.account.address, alice.account.address], { account: alice.account });

        // Shares are not escrowed at enqueue time, so the position can still empty before processing.
        // The queue must absorb that (zero shares -> no payout) rather than revert.
        const shares = await vault.read.balanceOf([alice.account.address]);
        await vault.write.transfer([bob.account.address, shares], { account: alice.account });

        const balanceBefore = await usdc.read.balanceOf([alice.account.address]);
        await mockEngine.write.processWithdrawals([vault.address, 10n]);

        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(balanceBefore);
        expect(await vault.read.balanceOf([bob.account.address])).to.equal(shares);
    });

    it("placeBetWithPermit succeeds even if permit is stale (try/catch)", async function () {
        const [admin] = await viem.getWalletClients();
        const pk =
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
        const pkAccount = privateKeyToAccount(pk);
        const token = await viem.deployContract("MockERC20Permit");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(token.address, "Bank P", "bP", 1, mockEngine.address, admin.account.address, vaultInitMinBet18),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        const amount = parseUnits("10", 18);
        await token.write.mint([pkAccount.address, amount]);
        const publicClient = await viem.getPublicClient();
        const chainId = await publicClient.getChainId();
        const nonce = await token.read.nonces([pkAccount.address]);
        const name = await token.read.name();
        // Use chain time, not wall-clock: earlier suites advance the chain with time.increase.
        const deadline = BigInt(await time.latest()) + 3600n;
        const domain = {
            name,
            version: "1",
            chainId,
            verifyingContract: token.address as Address,
        } as const;
        const types = {
            Permit: [
                { name: "owner", type: "address" },
                { name: "spender", type: "address" },
                { name: "value", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" },
            ],
        } as const;
        const message = {
            owner: pkAccount.address,
            spender: vault.address as Address,
            value: amount,
            nonce,
            deadline,
        } as const;
        const signature = await pkAccount.signTypedData({ domain, types, primaryType: "Permit", message });
        const r = `0x${signature.slice(2, 66)}` as Hex;
        const s = `0x${signature.slice(66, 130)}` as Hex;
        const v = Number.parseInt(signature.slice(130, 132), 16);

        await token.write.approve([vault.address, 0n], { account: pkAccount });
        await vault.write.placeBetWithPermit([amount, "0x", zeroAddress, deadline, v, r, s], { account: pkAccount });

        await token.write.mint([pkAccount.address, amount]);
        await token.write.approve([vault.address, amount], { account: pkAccount });
        await vault.write.placeBetWithPermit([amount, "0x", zeroAddress, deadline, v, r, s], { account: pkAccount });
    });

    it("uses decimals offset 6 and resists donation inflation on second deposit", async function () {
        const [admin, attacker, victim] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address, vaultInitMinBetUsdc6),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        expect(await vault.read.decimals()).to.equal(12);

        const minDeposit = parseUnits("1.000001", 6);
        const victimDeposit = parseUnits("100", 6);
        const donation = parseUnits("1000000", 6);

        await usdc.write.mint([attacker.account.address, minDeposit + donation], { account: admin.account });
        await usdc.write.mint([victim.account.address, victimDeposit], { account: admin.account });

        await usdc.write.approve([vault.address, minDeposit + donation], { account: attacker.account });
        await vault.write.deposit([minDeposit, attacker.account.address], { account: attacker.account });
        await usdc.write.transfer([vault.address, donation], { account: attacker.account });

        await usdc.write.approve([vault.address, victimDeposit], { account: victim.account });
        await vault.write.deposit([victimDeposit, victim.account.address], { account: victim.account });

        expect(await vault.read.balanceOf([victim.account.address])).to.be.gt(0n);
        expect(await vault.read.convertToAssets([await vault.read.balanceOf([victim.account.address])])).to.be.closeTo(
            victimDeposit,
            parseUnits("1", 6),
        );
    });
});

function vaultInitData(
    asset: Address,
    name: string,
    symbol: string,
    marketId: number,
    engine: Address,
    admin: Address,
    minBet: bigint,
): Hex {
    return encodeFunctionData({
        abi: [
            {
                type: "function",
                name: "initialize",
                stateMutability: "nonpayable",
                inputs: [
                    {
                        name: "p",
                        type: "tuple",
                        components: [
                            { name: "assetToken", type: "address" },
                            { name: "name", type: "string" },
                            { name: "symbol", type: "string" },
                            { name: "marketId", type: "uint32" },
                            { name: "engine", type: "address" },
                            { name: "admin", type: "address" },
                            { name: "minBet", type: "uint256" },
                            { name: "sideBetController", type: "address" },
                        ],
                    },
                ],
                outputs: [],
            },
        ],
        functionName: "initialize",
        args: [
            {
                assetToken: asset,
                name,
                symbol,
                marketId,
                engine,
                admin,
                minBet,
                sideBetController: "0x0000000000000000000000000000000000000000",
            },
        ],
    });
}
