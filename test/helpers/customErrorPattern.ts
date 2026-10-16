import { toFunctionSelector } from "viem";

/** Hardhat may expose via-IR / linked-library errors as raw return data. */
export function customErrorPattern(signature: `${string}(${string})`): RegExp {
    const name = signature.slice(0, signature.indexOf("("));
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const selector = toFunctionSelector(signature);
    return new RegExp(`custom error '${escaped}\\([^']*\\)'|return data: ${selector}[0-9a-fA-F]*\\)`);
}
