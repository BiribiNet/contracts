import { parseUnits } from "viem";

export const marketLimitsUsdc6 = {
    minBet: 1_000_000n,
} as const;

export const vaultInitMinBetUsdc6 = 1_000_000n;

export const vaultInitMinBet18 = parseUnits("1", 18);
