import hre, { viem } from "hardhat";
import { expect } from "chai";
import { encodeAbiParameters, encodeFunctionData, encodePacked } from "viem";
import { boundedInteger, checkProductionArtifacts, handoffProtocolRoles } from "../scripts/utils/mainnetRelease";
import { deployCreAutomation } from "../scripts/utils/deployCreAutomation";
import { vrfKeyHashTriple } from "../scripts/utils/protocolDeployEnv";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCreWorkflowConfigs } from "../scripts/utils/writeCreWorkflowConfigs";

import { verifyErc1967ProxyWithDelay, verifyBeaconProxyWithDelay } from "../scripts/utils/proxyVerification";

describe("Mainnet release safeguards", function () {
    it("does not report proxy verification complete when explorer log lookup failed", async function () {
        const previous = hre.run;
        const address = "0x1111111111111111111111111111111111111111";
        try {
            hre.run = (async () => { throw new Error("Missing chainid parameter"); }) as typeof hre.run;
            await expect(verifyErc1967ProxyWithDelay(address, address, "0x", 0, true)).to.be.rejectedWith("Missing chainid parameter");
            await expect(verifyBeaconProxyWithDelay(address, address, "0x", 0, true)).to.be.rejectedWith("Missing chainid parameter");
        } finally { hre.run = previous; }
    });
    it("generates distinct mainnet CRE names without overwriting the Sepolia project", function () {
        const source = join(__dirname, "../cre/workflows/biribi-roulette-lane/workflow.yaml");
        const before = readFileSync(source, "utf8");
        const outputDirectory = mkdtempSync(join(tmpdir(), "biribi-cre-release-"));
        const address = "0x1111111111111111111111111111111111111111";
        try {
            writeCreWorkflowConfigs({ outputDirectory, network: "arbitrum-one", engine: address, scheduler: address, receiver: address, laneCount: 2, httpAuthorizedKeys: [address] });
            const yaml = readFileSync(join(outputDirectory, "workflow.yaml"), "utf8");
            expect(yaml).to.include('workflow-name: "biribi-arbitrum-one-roulette-lane-1-production"');
            expect(yaml).to.include('workflow-name: "biribi-arbitrum-one-trigger-vrf-production"');
            expect(JSON.parse(readFileSync(join(outputDirectory, "config.lane1.production.json"), "utf8")).chainSelectorName).to.equal("ethereum-mainnet-arbitrum-1");
            expect(readFileSync(source, "utf8")).to.equal(before);
        } finally { rmSync(outputDirectory, { recursive: true, force: true }); }
    });
    it("rejects invalid settings and preserves distinct VRF gas lanes", async function () {
        const name = "BIRIBI_TEST_INTEGER";
        try {
            for (const bad of ["-1", "1.5", "0x10", "101"]) {
                process.env[name] = bad;
                expect(() => boundedInteger(name, 1n, 1n, 100n)).to.throw();
            }
            process.env[name] = "100";
            expect(boundedInteger(name, 1n, 1n, 100n)).to.equal(100n);
        } finally { delete process.env[name]; }
        const names = ["VRF_KEY_HASH_2_GWEI", "VRF_KEY_HASH_30_GWEI", "VRF_KEY_HASH_150_GWEI"];
        const saved = names.map(name => process.env[name]);
        try {
            names.forEach(name => delete process.env[name]);
            const hashes = ["0x" + "11".repeat(32), "0x" + "22".repeat(32), "0x" + "33".repeat(32)] as const;
            expect(vrfKeyHashTriple(hashes as any)).to.deep.equal(hashes);
        } finally { names.forEach((name, i) => saved[i] === undefined ? delete process.env[name] : process.env[name] = saved[i]); }
        const sizes = await checkProductionArtifacts();
        expect(sizes.RouletteEngine).to.be.lessThan(24577);
    });

    it("binds CRE reports before approving the bridge and transfers ownership/roles to a distinct admin", async function () {
        const [bootstrap, admin, workflowOwner, stranger, forwarder] = await viem.getWalletClients();
        const publicClient = await viem.getPublicClient();
        const { scheduler, engine, registry, sideBet, funder, treasury } = await deployProtocolStack();
        const waitWrite = async (hash: Promise<`0x${string}`>) => {
            expect((await publicClient.waitForTransactionReceipt({ hash: await hash })).status).to.equal("success");
        };
        const bridge = await deployCreAutomation({ scheduler: scheduler.address, admin: bootstrap.account.address,
            expectedWorkflowOwner: workflowOwner.account.address, receiverOwner: admin.account.address,
            keystoneForwarder: forwarder.account.address, wallet: bootstrap, publicClient, waitWrite });
        const receiver = await viem.getContractAt("AutomationReceiver", bridge.automationReceiver);
        expect((await receiver.read.owner()).toLowerCase()).to.equal(admin.account.address.toLowerCase());
        const data = encodeFunctionData({ abi: scheduler.abi, functionName: "performUpkeep", args: ["0x"] });
        const report = encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [scheduler.address, data]);
        const metadata = (owner: `0x${string}`) => encodePacked(["bytes32", "bytes10", "address"], ["0x" + "11".repeat(32) as `0x${string}`, "0x" + "22".repeat(10) as `0x${string}`, owner]);
        await expect(receiver.write.onReport([metadata(stranger.account.address), report], { account: forwarder.account })).to.be.rejected;
        await expect(receiver.write.onReport(["0x", report], { account: forwarder.account })).to.be.rejected;
        await waitWrite(receiver.write.onReport([metadata(workflowOwner.account.address), report], { account: forwarder.account }));
        await expect(receiver.write.setExpectedAuthor([stranger.account.address], { account: bootstrap.account })).to.be.rejected;
        const authority = await viem.getContractAt("CreExecutionAuthority", bridge.creExecutionAuthority);
        const roleSets = [
            { contract: engine, roles: ["DEFAULT_ADMIN_ROLE", "ENGINE_WITHDRAWAL_ROLE", "ENGINE_PAYOUT_ROLE", "ENGINE_ROUND_ROLE", "ENGINE_FEE_ROLE"] },
            { contract: sideBet, roles: ["DEFAULT_ADMIN_ROLE", "SIDE_BET_CONFIG_ROLE", "SIDE_BET_LIMITS_ROLE"] },
            { contract: registry, roles: ["DEFAULT_ADMIN_ROLE", "MARKET_FACTORY_ROLE"] },
            { contract: scheduler, roles: ["DEFAULT_ADMIN_ROLE", "SCHEDULER_ADMIN_ROLE"] },
            { contract: funder, roles: ["DEFAULT_ADMIN_ROLE", "FUNDER_ADMIN_ROLE"] },
            { contract: treasury, roles: ["DEFAULT_ADMIN_ROLE", "TREASURY_ADMIN_ROLE"] },
            { contract: authority, roles: ["DEFAULT_ADMIN_ROLE", "EXECUTOR_ADMIN_ROLE"] },
        ];
        await handoffProtocolRoles(roleSets, bootstrap.account.address, admin.account.address, waitWrite);
        for (const { contract, roles } of roleSets) {
            for (const getter of roles) {
                const role = await (contract as any).read[getter]();
                expect(await (contract as any).read.hasRole([role, admin.account.address])).to.equal(true);
                expect(await (contract as any).read.hasRole([role, bootstrap.account.address])).to.equal(false);
            }
        }
        expect(await sideBet.read.hasRole([await sideBet.read.SETTLEMENT_ROLE(), scheduler.address])).to.equal(true);
        await expect(scheduler.write.setForwarderAuthority([stranger.account.address], { account: bootstrap.account })).to.be.rejected;
    });
});
