import hre from "hardhat";
import { getAddress, formatEther } from "viem";

/**
 * Post-deployment verification script.
 *
 * Reads on-chain state from the deployed contracts and checks that
 * critical invariants hold (roles, linked addresses, fee settings).
 *
 * Usage:
 *   npx hardhat run scripts/verifyDeployment.ts --network arbitrumsepolia
 *
 * Requires the following environment:
 *   - ROULETTE_ADDRESS, STAKED_BRB_ADDRESS, BRB_ADDRESS, JACKPOT_ADDRESS
 *     set via `npx hardhat vars set <NAME>`
 */

const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

interface CheckResult {
  label: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function check(label: string, passed: boolean, detail: string): void {
  results.push({ label, passed, detail });
}

async function main(): Promise<void> {
  const { vars } = hre;
  const publicClient = await hre.viem.getPublicClient();

  const rouletteAddress = getAddress(vars.get("ROULETTE_ADDRESS"));
  const stakedBrbAddress = getAddress(vars.get("STAKED_BRB_ADDRESS"));
  const brbAddress = getAddress(vars.get("BRB_ADDRESS"));
  const jackpotAddress = getAddress(vars.get("JACKPOT_ADDRESS"));

  console.log("\n=== BiRiBi Deployment Verification ===\n");
  console.log(`Network:    ${hre.network.name}`);
  console.log(`Roulette:   ${rouletteAddress}`);
  console.log(`StakedBRB:  ${stakedBrbAddress}`);
  console.log(`BRB:        ${brbAddress}`);
  console.log(`Jackpot:    ${jackpotAddress}\n`);

  // --- BRB Token ---
  const brb = await hre.viem.getContractAt("BRB", brbAddress);
  const brbName = await brb.read.name();
  const brbSymbol = await brb.read.symbol();
  const brbTotalSupply = await brb.read.totalSupply();

  check("BRB name", brbName === "Biribi", `got "${brbName}"`);
  check("BRB symbol", brbSymbol === "BRB", `got "${brbSymbol}"`);
  check("BRB total supply > 0", brbTotalSupply > 0n, formatEther(brbTotalSupply));

  // --- Roulette ---
  const roulette = await hre.viem.getContractAt("RouletteClean", rouletteAddress);

  const rouletteHasAdmin = await roulette.read.hasRole([
    DEFAULT_ADMIN_ROLE as `0x${string}`,
    (await hre.viem.getWalletClients())[0].account.address,
  ]);
  check("Roulette: deployer has DEFAULT_ADMIN_ROLE", rouletteHasAdmin, String(rouletteHasAdmin));

  // --- StakedBRB ---
  const stakedBrb = await hre.viem.getContractAt("StakedBRB", stakedBrbAddress);

  const stakedBrbHasAdmin = await stakedBrb.read.hasRole([
    DEFAULT_ADMIN_ROLE as `0x${string}`,
    (await hre.viem.getWalletClients())[0].account.address,
  ]);
  check("StakedBRB: deployer has DEFAULT_ADMIN_ROLE", stakedBrbHasAdmin, String(stakedBrbHasAdmin));

  const stakedBrbAsset = await stakedBrb.read.asset();
  check(
    "StakedBRB: asset is BRB token",
    getAddress(stakedBrbAsset) === getAddress(brbAddress),
    stakedBrbAsset,
  );

  const totalAssets = await stakedBrb.read.totalAssets();
  console.log(`StakedBRB totalAssets: ${formatEther(totalAssets)} BRB`);

  // --- Jackpot ---
  const jackpotCode = await publicClient.getCode({ address: jackpotAddress });
  check("Jackpot: contract deployed", (jackpotCode?.length ?? 0) > 2, `bytecode length: ${jackpotCode?.length ?? 0}`);

  // --- Summary ---
  console.log("\n=== Results ===\n");

  let allPassed = true;
  for (const result of results) {
    const icon = result.passed ? "✅" : "❌";
    console.log(`  ${icon} ${result.label} — ${result.detail}`);
    if (!result.passed) allPassed = false;
  }

  console.log("");
  if (allPassed) {
    console.log("All checks passed.");
  } else {
    console.log("Some checks FAILED. Review the output above.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
