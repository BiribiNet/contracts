import { viem } from "hardhat";

import type { Address } from "viem";

export async function createMarketWithBeacon(
    registry: { read: { getMarket: (args: [number]) => Promise<{ bank: Address }> }; write: { setVaultBeacon: (args: [Address]) => Promise<void>; createMarket: (args: [{ asset: Address; bankAdmin: Address; minBet: bigint }]) => Promise<void> } },
    admin: Address,
    asset: Address,
    minBet = 1_000_000n,
) {
    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin });
    await registry.write.createMarket([{ asset, bankAdmin: admin, minBet }], { account: admin });
    const cfg = await registry.read.getMarket([1]);
    return viem.getContractAt("BankVault4626", cfg.bank);
}

/**
 * Same as `createMarketWithBeacon` but behind the frozen pre-mask-bets vault (`LegacySideBetBankVault4626`),
 * the only implementation that still exposes `lockSideBetStake`. Used by the SideBet suites: SideBet is
 * unchanged and stays deployed (disabled), while the production vault no longer serves it.
 */
export async function createMarketWithLegacySideBetBeacon(
    registry: Parameters<typeof createMarketWithBeacon>[0],
    admin: Address,
    asset: Address,
    minBet = 1_000_000n,
) {
    const vaultImpl = await viem.deployContract("LegacySideBetBankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin });
    await registry.write.createMarket([{ asset, bankAdmin: admin, minBet }], { account: admin });
    const cfg = await registry.read.getMarket([1]);
    return viem.getContractAt("LegacySideBetBankVault4626", cfg.bank);
}
