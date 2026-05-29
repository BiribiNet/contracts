import { expect } from "chai";
import { encodeFunctionData, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { viem } from "hardhat";

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
        await vault.write.placeBet([parseUnits("10", 6), "0x"], { account: alice.account });
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

        await expect(vault.write.placeBet([0n, "0x"], { account: alice.account })).to.be.rejected;
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
        await vault.write.placeBet([parseUnits("40", 6), "0x"], { account: alice.account });
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
        await expect(vault.write.placeBet([parseUnits("4", 6), "0x"], { account: alice.account })).to.be.rejected;
        await vault.write.placeBet([parseUnits("5", 6), "0x"], { account: alice.account });
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
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
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
        await vault.write.placeBetWithPermit([amount, "0x", deadline, v, r, s], { account: pkAccount });

        await token.write.mint([pkAccount.address, amount]);
        await token.write.approve([vault.address, amount], { account: pkAccount });
        await vault.write.placeBetWithPermit([amount, "0x", deadline, v, r, s], { account: pkAccount });
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
            },
        ],
    });
}
