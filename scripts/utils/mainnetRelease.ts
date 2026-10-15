import { artifacts } from 'hardhat';
import { getAddress, isAddress, parseAbi, zeroAddress, type Address, type PublicClient } from 'viem';

export const MAINNET_CONFIRMATION = 'arbitrum-one:42161';
export function requiredAddress(name: string): Address {
    const value = process.env[name]?.trim();
    if (!value || !isAddress(value) || value.toLowerCase() === zeroAddress) throw new Error(`${name} must be an explicit nonzero address`);
    return getAddress(value);
}

export function boundedInteger(name: string, fallback: bigint, minimum: bigint, maximum: bigint): bigint {
    const raw = process.env[name]?.trim();
    if (raw && !/^\d+$/.test(raw)) throw new Error(`${name} must be an unsigned decimal integer`);
    const value = raw ? BigInt(raw) : fallback;
    if (value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
    return value;
}

export async function checkProductionArtifacts() {
    const names = ['RouletteEngine', 'SideBet', 'BankVault4626', 'BRBJackpotFunder', 'JackpotTreasury',
        'MarketRegistry', 'UpkeepScheduler', 'AutomationReceiver', 'CreExecutionAuthority', 'BRBToken',
        'SideBetChallengeEvaluator', 'BRBReferal', 'ERC1967Proxy', 'UpgradeableBeacon', 'BeaconProxy',
        'RouletteLib', 'RouletteBetLib', 'JackpotBatchLib', 'RoulettePayoutMulLib', 'RouletteExposureLib',
        'RouletteJackpotCollectLib', 'RoulettePayoutSweepLib', 'RouletteLiabilityMathLib', 'RouletteBetCodecLib', 'RouletteUpkeepScanLib'];
    const sizes: Record<string, number> = {};
    for (const name of names) {
        const artifact = await artifacts.readArtifact(name);
        const bytes = (artifact.deployedBytecode.length - 2) / 2;
        if (bytes === 0 || bytes > 24576) throw new Error(`${name} runtime ${bytes} bytes fails EIP-170`);
        if ((artifact.bytecode.length - 2) / 2 > 49152) throw new Error(`${name} init code exceeds EIP-3860`);
        sizes[name] = bytes;
    }
    return sizes;
}

export async function preflightMainnet(client: PublicClient, options: {
    deployer: Address; admin: Address; router: Address; coordinator: Address; link: Address;
    forwarder: Address; usdc: Address; dai: Address; subscriptionId: bigint; brb?: Address;
}) {
    if (await client.getChainId() !== 42161) throw new Error('Expected Arbitrum One (42161)');
    const blockNumber = await client.getBlockNumber();
    for (const [name, address] of Object.entries({ router: options.router, coordinator: options.coordinator,
        link: options.link, forwarder: options.forwarder, usdc: options.usdc, dai: options.dai, ...(options.brb ? { brb: options.brb } : {}) })) {
        const code = await client.getBytecode({ address, blockNumber });
        if (!code || code === '0x') throw new Error(`${name} has no code on Arbitrum One`);
    }
    for (const [asset, decimals] of [[options.usdc, 6], [options.dai, 18], ...(options.brb ? [[options.brb, 18] as const] : [])] as const) {
        const actual = await client.readContract({ address: asset, abi: parseAbi(['function decimals() view returns (uint8)']), functionName: 'decimals', blockNumber });
        if (actual !== decimals) throw new Error('Unexpected market token decimals');
    }
    const factory = await client.readContract({ address: options.router, abi: parseAbi(['function factory() view returns (address)']), functionName: 'factory', blockNumber });
    const factoryCode = await client.getBytecode({ address: factory, blockNumber });
    if (!factoryCode || factoryCode === '0x') throw new Error('Router factory has no code');
    const subscription = await client.readContract({ address: options.coordinator,
        abi: parseAbi(['function getSubscription(uint256) view returns (uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)']),
        functionName: 'getSubscription', args: [options.subscriptionId], blockNumber });
    if (subscription[0] === 0n) throw new Error('VRF subscription LINK balance is zero');
    if (subscription[3].toLowerCase() !== options.deployer.toLowerCase()) {
        throw new Error('VRF subscription must be owned by the deployment signer to register the new engine. No deployment transaction sent.');
    }
    const sizes = await checkProductionArtifacts();
    return { blockNumber: blockNumber.toString(), chainId: 42161, admin: options.admin, subscriptionOwner: subscription[3],
        subscriptionLinkJuels: subscription[0].toString(), factory, sizes, fundingSufficiencyVerified: false };
}

// Every role held by bootstrap signer is explicitly transferred. SETTLEMENT_ROLE belongs to scheduler.
export async function handoffProtocolRoles(contracts: Array<{ contract: any; roles: string[] }>,
    bootstrap: Address, admin: Address, waitWrite: (hash: Promise<`0x${string}`>) => Promise<void>) {
    if (bootstrap.toLowerCase() === admin.toLowerCase()) return;
    for (const { contract, roles } of contracts) {
        for (const getter of roles) {
            const role = await contract.read[getter]();
            await waitWrite(contract.write.grantRole([role, admin], { account: bootstrap }));
            if (!(await contract.read.hasRole([role, admin]))) throw new Error(`Handoff failed for ${getter}`);
        }
        // Renounce default admin last so a failed intermediate tx remains recoverable.
        for (const getter of [...roles.filter(role => role !== 'DEFAULT_ADMIN_ROLE'), 'DEFAULT_ADMIN_ROLE']) {
            const role = await contract.read[getter]();
            await waitWrite(contract.write.renounceRole([role, bootstrap], { account: bootstrap }));
            if (await contract.read.hasRole([role, bootstrap])) throw new Error(`Bootstrap still holds ${getter}`);
        }
    }
}
