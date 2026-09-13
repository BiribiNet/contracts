import { toFunctionSelector, type AbiFunction } from "viem";

/** Refuse an oversized implementation or an ABI that silently breaks the deployed scheduler. */
export function assertSideBetCompatibility(artifact: { abi: readonly unknown[]; deployedBytecode: string }): void {
    const size = (artifact.deployedBytecode.length - 2) / 2;
    if (size <= 0 || size > 24_576) throw new Error(`SideBet runtime size ${size} exceeds deployment limits`);
    const functions = artifact.abi.filter((item): item is AbiFunction =>
        typeof item === "object" && item !== null && "type" in item && item.type === "function");
    for (const [name, fields] of [["previewSettleBundle", 3], ["previewSettleBundleV2", 4]] as const) {
        const fn = functions.find(item => item.name === name);
        const output = fn?.outputs[0];
        if (!output || !("components" in output) || output.components.length !== fields) {
            throw new Error(`Missing or incompatible ${name} return tuple`);
        }
    }
    const legacy = "settleBatch((uint256,bool,uint256)[],(address,uint32,uint256,uint256,uint256,(address,uint256)[])[])";
    if (!functions.some(fn => toFunctionSelector(fn) === toFunctionSelector(legacy))) {
        throw new Error("Missing deployed scheduler settlement selector");
    }
}
