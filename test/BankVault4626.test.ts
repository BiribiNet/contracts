import { expect } from "chai";
import { encodeFunctionData, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { viem } from "hardhat";

describe("BankVault4626", function () {
    it("handles bets, liquidity locking and total assets", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address),
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
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address),
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
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address),
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
            vaultInitData(usdc.address, "Bank USDC", "bUSDC", 1, mockEngine.address, admin.account.address),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);
        await vault.write.setMinBet([parseUnits("5", 6)], { account: admin.account });
        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([vault.address, parseUnits("100", 6)], { account: alice.account });
        await expect(vault.write.placeBet([parseUnits("4", 6), "0x"], { account: alice.account })).to.be.rejected;
        await vault.write.placeBet([parseUnits("5", 6), "0x"], { account: alice.account });
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
            vaultInitData(token.address, "Bank P", "bP", 1, mockEngine.address, admin.account.address),
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
): Hex {
    return encodeFunctionData({
        abi: [
            {
                type: "function",
                name: "initialize",
                stateMutability: "nonpayable",
                inputs: [
                    { name: "assetToken_", type: "address" },
                    { name: "name_", type: "string" },
                    { name: "symbol_", type: "string" },
                    { name: "marketId_", type: "uint32" },
                    { name: "engine_", type: "address" },
                    { name: "admin", type: "address" },
                ],
                outputs: [],
            },
        ],
        functionName: "initialize",
        args: [asset, name, symbol, marketId, engine, admin],
    });
}
