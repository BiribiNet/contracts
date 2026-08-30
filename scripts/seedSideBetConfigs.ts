import { readFileSync } from "node:fs";
import { join } from "node:path";

import { viem } from "hardhat";

import { formatUnits, isAddress, parseAbi, parseUnits } from "viem";

/**
 * Seed the BRBGAME side-bet catalogue onto the live `SideBet` contract.
 *
 * The deployed `SideBet` has `configCount == 0` because no deploy path ever called `addConfig`,
 * which is why no side bet is offered in the UI. This script creates the catalogue in
 * `scripts/utils/sideBetCatalogue.ts` for every registered market and then activates each config.
 *
 * Two transactions are needed per config, under two different roles:
 *   1. `addConfig`             (SIDE_BET_CONFIG_ROLE) — creates the template, forcing stake limits to 0
 *   2. `setConfigStakeLimits`  (SIDE_BET_LIMITS_ROLE)  — the switch that makes it playable;
 *                                                        `placeBet` reverts `StakeLimitsNotSet` until then
 *
 * The script is idempotent: it reads every existing config first and skips templates already
 * present, so a re-run after topping up a vault only activates what was previously left inactive.
 *
 * Env:
 * - SIDE_BET_ADDRESS       — SideBet proxy (default: ../subgraph/deployments/arbitrum-sepolia.json)
 * - SEED_APPLY             — set to `true` to broadcast; otherwise this is a dry run
 * - SEED_MIN_STAKE_UNITS   — minimum stake in whole asset units (default 1)
 * - SEED_SAFETY_BPS        — share of vault liquidity one max-size bet may reserve (default 2000 = 20%)
 *
 * Run: `yarn seed:side-bets:arbitrum-sepolia`            (dry run)
 *      `SEED_APPLY=true yarn seed:side-bets:arbitrum-sepolia`
 */
import "dotenv/config";

import {
    BPS_DENOMINATOR,
    DEFAULT_LIQUIDITY_SAFETY_BPS,
    MAX_MULTIPLIER_BPS,
    MIN_MULTIPLIER_BPS,
    buildCatalogueForMarket,
    computeMaxStake,
    matchesConfig,
    toConfigStruct,
    type SideBetCatalogueEntry,
    type SideBetConfigStruct,
} from "./utils/sideBetCatalogue";

const DEPLOY_JSON = join(__dirname, "..", "..", "subgraph", "deployments", "arbitrum-sepolia.json");

const DEFAULT_MIN_STAKE_WHOLE_UNITS = "1";

/** Only the ERC-20 metadata the seed needs; avoids binding a market asset to an unrelated artifact. */
const ERC20_METADATA_ABI = parseAbi([
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
]);

async function getSideBetContract(address: `0x${string}`) {
    return viem.getContractAt("SideBet", address);
}

type SideBetContract = Awaited<ReturnType<typeof getSideBetContract>>;

interface MarketInfo {
    marketId: number;
    asset: `0x${string}`;
    bank: `0x${string}`;
    symbol: string;
    decimals: number;
    availableLiquidity: bigint;
}

/** What the script decided to do with one catalogue entry. */
interface PlannedAction {
    entry: SideBetCatalogueEntry;
    market: MarketInfo;
    minStake: bigint;
    maxStake: bigint;
    /** Existing on-chain config id, when the template was already seeded. */
    existingConfigId?: number;
    /** Set when the vault cannot back this multiplier — the config is created but left inactive. */
    skipReason?: string;
}

function envAddress(name: string, fallback: `0x${string}`): `0x${string}` {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    if (!isAddress(raw)) throw new Error(`${name} must be a valid address: ${raw}`);
    return raw;
}

function envBigInt(name: string, fallback: bigint): bigint {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const parsed = BigInt(raw);
    if (parsed <= 0n) throw new Error(`${name} must be a positive integer`);
    return parsed;
}

function readSideBetAddress(): `0x${string}` {
    const deploy = JSON.parse(readFileSync(DEPLOY_JSON, "utf8")) as {
        addresses: { sideBet: `0x${string}` };
    };
    return envAddress("SIDE_BET_ADDRESS", deploy.addresses.sideBet);
}

/** Read every market from the registry, with the liquidity that actually backs side bets. */
async function loadMarkets(sideBet: SideBetContract): Promise<MarketInfo[]> {
    const publicClient = await viem.getPublicClient();
    const registryAddress = await sideBet.read.REGISTRY();
    const registry = await viem.getContractAt("MarketRegistry", registryAddress);
    const marketCount = await registry.read.marketCount();

    const markets: MarketInfo[] = [];
    for (let marketId = 1; marketId <= Number(marketCount); marketId += 1) {
        const config = await registry.read.getMarket([marketId]);
        const [symbol, decimals, availableLiquidity] = await Promise.all([
            publicClient.readContract({ address: config.asset, abi: ERC20_METADATA_ABI, functionName: "symbol" }),
            publicClient.readContract({ address: config.asset, abi: ERC20_METADATA_ABI, functionName: "decimals" }),
            sideBet.read.availableVaultLiquidity([marketId]),
        ]);
        markets.push({
            marketId,
            asset: config.asset,
            bank: config.bank,
            symbol,
            decimals: Number(decimals),
            availableLiquidity,
        });
    }
    return markets;
}

/**
 * Every *active* config currently stored on-chain, indexed by its config id.
 *
 * Removed ids are skipped via `isConfigActive` rather than read: `getConfig` reverts
 * `ConfigInactive` for them instead of returning a zeroed struct, so a blind scan would abort on
 * the first removed config. Skipping them is also correct for idempotency — a removed id can never
 * be revived (`updateConfig` reverts), so a matching template must be created afresh.
 */
async function loadExistingConfigs(sideBet: SideBetContract): Promise<Map<number, SideBetConfigStruct>> {
    const configCount = Number(await sideBet.read.configCount());
    const existing = new Map<number, SideBetConfigStruct>();
    for (let configId = 0; configId < configCount; configId += 1) {
        if (!(await sideBet.read.isConfigActive([BigInt(configId)]))) continue;
        const raw = await sideBet.read.getConfig([BigInt(configId)]);
        existing.set(configId, {
            marketId: Number(raw.marketId),
            betType: Number(raw.betType),
            color: Number(raw.color),
            targetNumber: Number(raw.targetNumber),
            targetCount: Number(raw.targetCount),
            redRatioBps: Number(raw.redRatioBps),
            windowSpins: Number(raw.windowSpins),
            multiplierBps: Number(raw.multiplierBps),
            minStake: raw.minStake,
            maxStake: raw.maxStake,
        });
    }
    return existing;
}

/** Decide, per market and per template, whether to create, activate, or skip. */
function planActions(
    markets: MarketInfo[],
    existing: Map<number, SideBetConfigStruct>,
    minStakeWholeUnits: string,
    safetyBps: bigint,
): PlannedAction[] {
    const plan: PlannedAction[] = [];

    for (const market of markets) {
        const minStake = parseUnits(minStakeWholeUnits, market.decimals);

        for (const entry of buildCatalogueForMarket(market.marketId)) {
            const maxStake = computeMaxStake(market.availableLiquidity, entry.multiplierBps, safetyBps);

            // `existing` only holds active configs, so a match here is always a live template.
            let existingConfigId: number | undefined;
            for (const [configId, onChain] of existing) {
                if (matchesConfig(entry, onChain)) {
                    existingConfigId = configId;
                    break;
                }
            }

            let skipReason: string | undefined;
            if (maxStake < minStake) {
                // Invert computeMaxStake: liquidity needed so that maxStake reaches minStake.
                const needed = (minStake * (BigInt(entry.multiplierBps) - BPS_DENOMINATOR)) / safetyBps;
                skipReason =
                    `vault holds ${formatUnits(market.availableLiquidity, market.decimals)} ${market.symbol}, ` +
                    `which backs a max stake of ${formatUnits(maxStake, market.decimals)} — below the ` +
                    `${formatUnits(minStake, market.decimals)} minimum at ${entry.multiplierBps / 10_000}x. ` +
                    `Deposit at least ~${formatUnits(needed, market.decimals)} ${market.symbol} and re-run.`;
            }

            plan.push({ entry, market, minStake, maxStake, existingConfigId, skipReason });
        }
    }

    return plan;
}

function assertCatalogueInBand(plan: PlannedAction[]): void {
    for (const action of plan) {
        const { multiplierBps, key } = action.entry;
        if (multiplierBps < MIN_MULTIPLIER_BPS || multiplierBps > MAX_MULTIPLIER_BPS) {
            throw new Error(
                `Template ${key} has multiplier ${multiplierBps} bps, outside the contract band ` +
                    `[${MIN_MULTIPLIER_BPS}, ${MAX_MULTIPLIER_BPS}] — addConfig would revert MultiplierOutOfBand.`,
            );
        }
    }
}

async function main(): Promise<void> {
    const publicClient = await viem.getPublicClient();
    const [signer] = await viem.getWalletClients();
    if (!signer.account) throw new Error("Signer wallet has no account");

    const apply = process.env.SEED_APPLY?.trim().toLowerCase() === "true";
    const minStakeWholeUnits = process.env.SEED_MIN_STAKE_UNITS?.trim() || DEFAULT_MIN_STAKE_WHOLE_UNITS;
    const safetyBps = envBigInt("SEED_SAFETY_BPS", DEFAULT_LIQUIDITY_SAFETY_BPS);

    const sideBetAddress = readSideBetAddress();
    const sideBet = await getSideBetContract(sideBetAddress);

    console.log("SideBet proxy:", sideBetAddress);
    console.log("Signer:", signer.account.address);
    console.log(apply ? "Mode: APPLY (transactions will be broadcast)" : "Mode: DRY RUN (no transactions)");

    // Fail before touching anything if the signer cannot complete both halves of the seed.
    const [configRole, limitsRole] = await Promise.all([
        sideBet.read.SIDE_BET_CONFIG_ROLE(),
        sideBet.read.SIDE_BET_LIMITS_ROLE(),
    ]);
    const [hasConfigRole, hasLimitsRole] = await Promise.all([
        sideBet.read.hasRole([configRole, signer.account.address]),
        sideBet.read.hasRole([limitsRole, signer.account.address]),
    ]);
    if (!hasConfigRole || !hasLimitsRole) {
        throw new Error(
            `Signer ${signer.account.address} needs both SIDE_BET_CONFIG_ROLE (has: ${hasConfigRole}) and ` +
                `SIDE_BET_LIMITS_ROLE (has: ${hasLimitsRole}) — seeding aborted before any transaction.`,
        );
    }

    const markets = await loadMarkets(sideBet);
    if (markets.length === 0) throw new Error("MarketRegistry reports no markets — nothing to seed.");

    const existing = await loadExistingConfigs(sideBet);
    const plan = planActions(markets, existing, minStakeWholeUnits, safetyBps);
    assertCatalogueInBand(plan);

    console.log(`\nMarkets: ${markets.length}, templates per market: ${plan.length / markets.length}`);
    for (const market of markets) {
        console.log(
            `  market ${market.marketId} (${market.symbol}, ${market.decimals}d) — ` +
                `available ${formatUnits(market.availableLiquidity, market.decimals)}`,
        );
    }

    const waitFor = async (hash: `0x${string}`, label: string) => {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`${label} reverted (tx ${hash})`);
    };

    let created = 0;
    let activated = 0;
    let skipped = 0;
    let alreadyPresent = 0;
    const blocked: PlannedAction[] = [];

    console.log("");
    for (const action of plan) {
        const { entry, market, minStake, maxStake } = action;
        const label = `market ${market.marketId} ${market.symbol} / ${entry.key}`;

        let configId = action.existingConfigId;

        if (configId === undefined) {
            if (!apply) {
                console.log(`  [dry-run] addConfig            ${label}`);
                created += 1;
            } else {
                const hash = await sideBet.write.addConfig([toConfigStruct(entry)], { account: signer.account });
                await waitFor(hash, `addConfig(${label})`);
                // configCount is the id just consumed, so the new config is at count - 1.
                configId = Number(await sideBet.read.configCount()) - 1;
                console.log(`  created config ${configId}       ${label}`);
                created += 1;
            }
        } else {
            alreadyPresent += 1;
        }

        if (action.skipReason) {
            console.warn(`  ! not activated             ${label}: ${action.skipReason}`);
            blocked.push(action);
            skipped += 1;
            continue;
        }

        const isAlreadyActive =
            configId !== undefined && (existing.get(configId)?.minStake ?? 0n) > 0n;
        if (isAlreadyActive) continue;

        if (!apply) {
            console.log(
                `  [dry-run] setConfigStakeLimits ${label} → ` +
                    `[${formatUnits(minStake, market.decimals)}, ${formatUnits(maxStake, market.decimals)}] ${market.symbol}`,
            );
            activated += 1;
            continue;
        }

        if (configId === undefined) throw new Error(`Internal error: no config id for ${label}`);
        const hash = await sideBet.write.setConfigStakeLimits([BigInt(configId), minStake, maxStake], {
            account: signer.account,
        });
        await waitFor(hash, `setConfigStakeLimits(${label})`);
        console.log(
            `  activated config ${configId}     ${label} → ` +
                `[${formatUnits(minStake, market.decimals)}, ${formatUnits(maxStake, market.decimals)}] ${market.symbol}`,
        );
        activated += 1;
    }

    console.log(
        `\nSummary: ${created} created, ${activated} activated, ${alreadyPresent} already present, ` +
            `${skipped} left inactive (insufficient vault liquidity).`,
    );

    if (blocked.length > 0) {
        const bySymbol = new Set(blocked.map((action) => action.market.symbol));
        console.warn(
            `\nMarkets needing liquidity before their configs can open: ${[...bySymbol].join(", ")}. ` +
                `Deposit into the vault (see scripts/seedBankVaultLiquidity.ts) and re-run this script — ` +
                `it will only activate what is still inactive.`,
        );
    }

    if (!apply) {
        console.log("\nDry run complete. Re-run with SEED_APPLY=true to broadcast.");
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
