import { expect } from "chai";
import { rejects } from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { network, viem } from "hardhat";
import { createPublicClient, createWalletClient, custom, http } from "viem";
import { deployStablecoinMarkets } from "../scripts/utils/deployStablecoinMarkets";
const suite = process.env.RUN_ARBITRUM_FORK === "1" ? describe : describe.skip;
suite("USDC then DAI addition to deployed Arbitrum architecture", function () {
    this.timeout(300_000);
    after(async () => { await network.provider.request({ method: "hardhat_reset", params: [] }); });
    it("preserves BRB market and pool, creates empty stablecoin vaults in order, rejects repeated creation", async () => {
        if (network.name !== "hardhat" || await (await viem.getPublicClient()).getChainId() !== 31337) throw new Error("Isolated fork chain required");
        const m = JSON.parse(readFileSync("deployments/arbitrum-one.json", "utf8"));
        const url = "https://arb1.arbitrum.io/rpc";
        const source = createPublicClient({ transport: http(url) });
        expect(await source.getChainId()).to.equal(42161);
        let pinnedBlock = Number(await source.getBlockNumber());
        if (m.stablecoinMarkets) {
            const receipts = readFileSync("deployments/arbitrum-one-stablecoin-markets-transactions.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line));
            const first = receipts.find(record => record.event === "receipt" && record.status === "success");
            if (!first) throw new Error("Missing market creation receipt for historical rehearsal");
            pinnedBlock = Number(first.blockNumber) - 1;
        }
        await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: url, blockNumber: pinnedBlock } }] });
        const client = await viem.getPublicClient();
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [m.protocolAdmin] });
        const wallet = createWalletClient({ account: m.protocolAdmin as `0x${string}`, chain: client.chain, transport: custom(network.provider) });
        const a = m.addresses;
        const pool = await viem.getContractAt("UniswapV2Pair", m.liquidity.pair);
        const reservesBefore = await pool.read.getReserves();
        const lpBefore = await pool.read.balanceOf([m.deployer]);
        const brbBank = await viem.getContractAt("BankVault4626", m.markets.brb.bank);
        const infraShares = await brbBank.read.balanceOf([m.infraWallet]);
        const params = { wallet, client, registry: a.registry, engine: a.engine, sideBet: a.sideBet, beacon: a.vaultBeacon, brb: a.brb, admin: m.protocolAdmin,
            waitWrite: async (hash: Promise<`0x${string}`>) => { expect((await client.waitForTransactionReceipt({ hash: await hash })).status).to.equal("success"); } };
        const result = await deployStablecoinMarkets(params);
        expect(result.markets.usdc.marketId).to.equal(2);
        expect(result.markets.dai.marketId).to.equal(3);
        expect(await pool.read.getReserves()).to.deep.equal(reservesBefore);
        expect(await pool.read.balanceOf([m.deployer])).to.equal(lpBefore);
        expect(await brbBank.read.balanceOf([m.infraWallet])).to.equal(infraShares);
        await rejects(deployStablecoinMarkets(params), /Expected only existing BRB/);
        const report = { checkedAt: new Date().toISOString(), localChainId: 31337, sourceChainId: 42161, pinnedBlock,
            order: ["BRB:1", "USDC:2", "DAI:3"], ...result, poolReservesUnchanged: true, lpOwnerUnchanged: true,
            limitation: "Only local fork impersonation was used; no live private key signed a fork transaction" };
        mkdirSync("reports/fork", { recursive: true });
        writeFileSync("reports/fork/arbitrum-one-stablecoin-markets.json", JSON.stringify(report, null, 2) + "\n");
        console.log(JSON.stringify(report));
    });
});
