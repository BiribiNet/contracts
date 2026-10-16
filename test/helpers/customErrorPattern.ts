import { toFunctionSelector } from "viem";

/** Hardhat may expose via-IR / linked-library errors as raw return data. */
export function customErrorPattern(signature: `${string}(${string})`): RegExp {
    const name = signature.slice(0, signature.indexOf("("));
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const selector = toFunctionSelector(signature);
    // These probes use static ABI arguments, each encoded as one 32-byte word.
    const args = signature.slice(signature.indexOf("(") + 1, -1);
    const wordCount = args ? args.split(",").length : 0;
    const namedArgs = wordCount ? "[^']*" : "";
    return new RegExp(`custom error '${escaped}\\(${namedArgs}\\)'|return data: ${selector}[0-9a-fA-F]{${wordCount * 64}}\\)`);
}
