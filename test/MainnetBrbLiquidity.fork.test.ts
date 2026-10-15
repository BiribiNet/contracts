import { expect } from "chai";
import { rejects } from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { network, viem } from "hardhat";
import { createPublicClient, createWalletClient, custom, http, parseUnits } from "viem";
import { seedMainnetBrbUsdcPool } from "../scripts/utils/seedMainnetBrbUsdcPool";

const suite = process.env.RUN_ARBITRUM_FORK === "1" ? describe : describe.skip;
suite("Deployed mainnet BRB/USDC initial liquidity rehearsal", function () {
    this.timeout(300_000);
    after(async () => { await network.provider.request({ method: "hardhat_reset", params: [] }); });
    it("creates and funds the actual token pair, keeps LP on deployer, and rejects duplicate seeding", async () => {
        if (network.name !== "hardhat" || await (await viem.getPublicClient()).getChainId() !== 31337) throw new Error("Isolated fork chain required");
        const manifest = JSON.parse(readFileSync("deployments/arbitrum-one.json", "utf8"));
        const url = "https://arb1.arbitrum.io/rpc";
        const source = createPublicClient({ transport: http(url) });
        expect(await source.getChainId()).to.equal(42161);
        // Remain reproducible after live funding: rehearse immediately before the first pool transaction.
        const liquidityJournal = readFileSync("deployments/arbitrum-one-liquidity-transactions.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line));
        const firstReceipt = liquidityJournal.find(record => record.event === "receipt" && record.status === "success");
        const pinnedBlock = manifest.liquidity?.seeded && firstReceipt
            ? Number(firstReceipt.blockNumber) - 1 : Number(await source.getBlockNumber());
        await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: url, blockNumber: pinnedBlock } }] });
        const client = await viem.getPublicClient();
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [manifest.deployer] });
        const deployer = createWalletClient({ account: manifest.deployer as `0x${string}`, chain: client.chain, transport: custom(network.provider) });
        const bank = await viem.getContractAt("BankVault4626", manifest.markets.brb.bank);
        const bankroll = await bank.read.totalAssets();
        const shares = await bank.read.balanceOf([manifest.infraWallet]);
        const nonce = await client.getTransactionCount({ address: deployer.account.address });
        await rejects(seedMainnetBrbUsdcPool({ deployer, client, brb: manifest.addresses.brb,
            brbAmount: parseUnits("2400001", 18), usdcAmount: parseUnits("24000", 6), waitWrite: async () => { throw new Error("Unexpected write"); } }), /balances below/);
        expect(await client.getTransactionCount({ address: deployer.account.address })).to.equal(nonce);
        const seeded = await seedMainnetBrbUsdcPool({ deployer, client, brb: manifest.addresses.brb,
            brbAmount: parseUnits("2400000", 18), usdcAmount: parseUnits("24000", 6), waitWrite: async hash => {
                expect((await client.waitForTransactionReceipt({ hash: await hash })).status).to.equal("success");
            } });
        expect(seeded.lpRecipient.toLowerCase()).to.equal(manifest.deployer.toLowerCase());
        expect(BigInt(seeded.lpBalance)).to.be.gt(0n);
        expect(seeded.lpVestingLockDeployed).to.equal(false);
        expect(seeded.lpVestingLockFunded).to.equal(false);
        expect(await bank.read.totalAssets()).to.equal(bankroll);
        expect(await bank.read.balanceOf([manifest.infraWallet])).to.equal(shares);
        await rejects(seedMainnetBrbUsdcPool({ deployer, client, brb: manifest.addresses.brb,
            brbAmount: parseUnits("2400000", 18), usdcAmount: parseUnits("24000", 6), waitWrite: async () => { throw new Error("Unexpected write"); } }), /balances below|must be empty/);
        const report = { checkedAt: new Date().toISOString(), sourceChainId: 42161, localChainId: 31337,
            pinnedBlock, brb: manifest.addresses.brb, ...seeded, infrastructureBankrollUnchanged: true,
            usesActualDeployedContracts: true, savedMainnetKeysUsedForSigning: false,
            limitation: "Writes and deployer impersonation occurred only on the isolated local fork" };
        mkdirSync("reports/fork", { recursive: true });
        writeFileSync("reports/fork/arbitrum-one-brb-liquidity.json", JSON.stringify(report, null, 2) + "\n");
        console.log(JSON.stringify(report));
    });
});
