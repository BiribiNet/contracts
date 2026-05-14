import hre from "hardhat";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isAlreadyVerifiedMessage(message: string): boolean {
    const m = message.toLowerCase();
    return m.includes("already verified") || m.includes("contract source code already verified");
}

/**
 * Best-effort Arbiscan/Etherscan verification. Requires `ETHERSCAN_API_KEY` in Hardhat vars.
 * @param contract Fully qualified name when multiple contracts share the same flattened name.
 */
export async function verifyContract(
    address: `0x${string}`,
    constructorArguments: unknown[],
    contract?: string,
): Promise<void> {
    try {
        await hre.run("verify:verify", {
            address,
            constructorArguments,
            ...(contract !== undefined ? { contract } : {}),
        });
        console.log(`Verified ${address}`);
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isAlreadyVerifiedMessage(msg)) {
            console.log(`Skip verify (already verified): ${address}`);
            return;
        }
        throw e;
    }
}

export async function verifyContractWithDelay(
    address: `0x${string}`,
    constructorArguments: unknown[],
    delayMs: number,
    contract?: string,
): Promise<void> {
    await verifyContract(address, constructorArguments, contract);
    if (delayMs > 0) await sleep(delayMs);
}

export async function verifyRouletteEngine(
    address: `0x${string}`,
    constructorArguments: unknown[],
    libraries: Record<string, string>,
    delayMs: number,
): Promise<void> {
    try {
        await hre.run("verify:verify", {
            address,
            constructorArguments,
            libraries,
        });
        console.log(`Verified RouletteEngine ${address}`);
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isAlreadyVerifiedMessage(msg)) {
            console.log(`Skip verify (already verified): ${address}`);
            return;
        }
        throw e;
    }
    if (delayMs > 0) await sleep(delayMs);
}
