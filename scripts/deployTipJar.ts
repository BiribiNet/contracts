import { ethers, network } from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

async function main() {
    const output = `deployments/tip-jar-${network.name}.json`;
    if (existsSync(output)) throw new Error(`Deployment record already exists: ${output}. Verify it before any new deployment.`);
    const token = process.env.TIP_BRB_TOKEN;
    const engine = process.env.TIP_ENGINE;
    const expectedChain = process.env.TIP_CHAIN_ID;
    const chain = await ethers.provider.getNetwork();
    if (!token || !engine || !ethers.isAddress(token) || !ethers.isAddress(engine) || expectedChain !== String(chain.chainId)) {
        throw new Error("Set TIP_BRB_TOKEN, TIP_ENGINE and TIP_CHAIN_ID explicitly for this deployment.");
    }
    const brb = new ethers.Contract(token, ["function decimals() view returns (uint8)"], ethers.provider);
    if (await brb.decimals() !== 18n) throw new Error("Expected the protocol's 18-decimal BRB token");
    const jar = await (await ethers.getContractFactory("TipJar")).deploy(token, engine);
    await jar.waitForDeployment();
    const receipt = await jar.deploymentTransaction()!.wait();
    if (!receipt || receipt.status !== 1) throw new Error("Deployment unconfirmed");
    const metadata = { chainId: Number(chain.chainId), address: await jar.getAddress(), token,
        recipient: await jar.RECIPIENT(), engine, startBlock: receipt.blockNumber, transactionHash: receipt.hash };
    await mkdir("deployments", { recursive: true });
    await writeFile(output, JSON.stringify(metadata, null, 2) + "\n", { flag: "wx" });
    console.log(metadata);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
