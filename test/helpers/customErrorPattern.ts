import { toFunctionSelector } from "viem";

/** Hardhat may expose via-IR / linked-library errors as raw return data. */
export function customErrorPattern(signature: `${string}()`): RegExp {
    const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const selector = toFunctionSelector(signature);
    return new RegExp(`custom error '${escaped}'|return data: ${selector}\\)`);
}
