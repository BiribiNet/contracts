import { artifacts } from "hardhat";
import { vars } from "hardhat/config";
import { encodeAbiParameters, type Address } from "viem";
import { Etherscan } from "@nomicfoundation/hardhat-verify/internal/etherscan";

/** Publishes the exact saved compiler input, including constructor-created contracts and linked libraries. */
export async function verifyExactCompilerBuild(params: {
    address: Address; artifact: string; constructorArguments: unknown[];
    buildContract?: string; libraries?: Record<string, string>;
}) {
    const artifact = await artifacts.readArtifact(params.artifact);
    const fqn = `${artifact.sourceName}:${artifact.contractName}`;
    const build = await artifacts.getBuildInfo(params.buildContract ?? fqn);
    if (!build) throw new Error(`Missing exact compiler build for ${fqn}`);
    const explorer = new Etherscan(vars.get("ETHERSCAN_API_KEY"), "https://api.etherscan.io/v2/api", "https://arbiscan.io", 42161);
    if (await explorer.isVerified(params.address)) {
        console.log(`Already source verified: ${artifact.contractName} ${params.address}`);
        return;
    }
    const input = JSON.parse(JSON.stringify(build.input));
    if (params.libraries) {
        input.settings.libraries = {};
        for (const [key, address] of Object.entries(params.libraries)) {
            const index = key.lastIndexOf(":");
            if (index < 1) throw new Error("Library verification requires fully qualified names");
            (input.settings.libraries[key.slice(0, index)] ??= {})[key.slice(index + 1)] = address;
        }
    }
    const constructor = artifact.abi.find(entry => entry.type === "constructor");
    const args = encodeAbiParameters(constructor?.inputs ?? [], params.constructorArguments as never).slice(2);
    const submission = await explorer.verify(params.address, JSON.stringify(input), fqn, `v${build.solcLongVersion}`, args);
    const status = await explorer.getVerificationStatus(submission.message);
    if (!status.isSuccess()) throw new Error(`Explorer did not verify ${artifact.contractName}`);
    console.log(`Source verified: ${artifact.contractName} ${params.address}`);
}
