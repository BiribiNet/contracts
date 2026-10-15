import { artifacts } from 'hardhat';
import { MIN_DEPLOYER_ETH, MIN_KEEPER_ETH } from '../constants/arbitrumOne';
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
        'SideBetChallengeEvaluator', 'BRBReferal', 'TipJar', 'ERC1967Proxy', 'UpgradeableBeacon', 'BeaconProxy',
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
    usdc: Address; dai: Address; /** When omitted, deploy will create a new VRF subscription. */
    subscriptionId?: bigint; brb?: Address; expectedFactory?: Address; keeper?: Address;
    callbackGasLimit?: number; confirmations?: number; vrfKeyHashes?: readonly `0x${string}`[];
}) {
    if (await client.getChainId() !== 42161) throw new Error('Expected Arbitrum One (42161)');
    const blockNumber = await client.getBlockNumber();
    if (options.keeper?.toLowerCase() === options.admin.toLowerCase()) {
        throw new Error('Keeper must use a dedicated account without protocol administrator privileges');
    }
    const deployerEth = await client.getBalance({ address: options.deployer, blockNumber });
    if (deployerEth < MIN_DEPLOYER_ETH) throw new Error('Deployer needs at least 0.02 ETH before broadcast (minimum reserve, not a total-cost guarantee)');
    if (options.keeper) {
        const keeperEth = await client.getBalance({ address: options.keeper, blockNumber });
        if (keeperEth < MIN_KEEPER_ETH) throw new Error('Fund the dedicated keeper with at least 0.005 ETH before broadcast');
        const keeperCode = await client.getBytecode({ address: options.keeper, blockNumber });
        if (keeperCode && keeperCode !== '0x') throw new Error('Worker keeper must be an EOA controlled by its signing private key');
    }
    const deployerUsdc = await client.readContract({ address: options.usdc,
        abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf', args: [options.deployer], blockNumber });
    if (deployerUsdc === 0n) throw new Error('Fund the deployer with native USDC for genesis liquidity before broadcast');
    const latestNonce = await client.getTransactionCount({ address: options.deployer, blockTag: 'latest' });
    const pendingNonce = await client.getTransactionCount({ address: options.deployer, blockTag: 'pending' });
    if (latestNonce !== pendingNonce) throw new Error('Deployer has pending transactions; CREATE predictions require an idle, dedicated deployment signer');
    for (const [name, address] of Object.entries({ router: options.router, coordinator: options.coordinator,
        link: options.link, usdc: options.usdc, dai: options.dai, ...(options.brb ? { brb: options.brb } : {}) })) {
        const code = await client.getBytecode({ address, blockNumber });
        if (!code || code === '0x') throw new Error(`${name} has no code on Arbitrum One`);
    }
    for (const [asset, decimals] of [[options.usdc, 6], [options.dai, 18], ...(options.brb ? [[options.brb, 18] as const] : [])] as const) {
        const actual = await client.readContract({ address: asset, abi: parseAbi(['function decimals() view returns (uint8)']), functionName: 'decimals', blockNumber });
        if (actual !== decimals) throw new Error('Unexpected market token decimals');
    }
    const factory = await client.readContract({ address: options.router, abi: parseAbi(['function factory() view returns (address)']), functionName: 'factory', blockNumber });
    if (options.expectedFactory && factory.toLowerCase() !== options.expectedFactory.toLowerCase()) {
        throw new Error('Router does not point to the published Uniswap V2 factory');
    }
    if (options.callbackGasLimit !== undefined || options.confirmations !== undefined) {
        const config = await client.readContract({ address: options.coordinator,
            abi: parseAbi(['function s_config() view returns (uint16,uint32,bool,uint32,uint32,uint32,uint32,uint8,uint8)']),
            functionName: 's_config', blockNumber });
        if (options.callbackGasLimit !== undefined && options.callbackGasLimit > config[1]) throw new Error('VRF callback gas exceeds coordinator limit');
        if (options.confirmations !== undefined && (options.confirmations < config[0] || options.confirmations > 200)) throw new Error('VRF confirmations outside coordinator bounds');
    }
    if (options.vrfKeyHashes) {
        for (const key of options.vrfKeyHashes) {
            const provingKey = await client.readContract({ address: options.coordinator,
                abi: parseAbi(['function s_provingKeys(bytes32) view returns (bool exists,uint64 maxGas)']),
                functionName: 's_provingKeys', args: [key], blockNumber });
            if (!provingKey[0]) throw new Error('Configured VRF gas lane is not registered');
        }
    }
    const factoryCode = await client.getBytecode({ address: factory, blockNumber });
    if (!factoryCode || factoryCode === '0x') throw new Error('Router factory has no code');
    const deployerLinkJuels = await client.readContract({
        address: options.link,
        abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf',
        args: [options.deployer],
        blockNumber,
    });
    let subscriptionOwner: Address | null = null;
    let subscriptionLinkJuels = '0';
    if (options.subscriptionId !== undefined) {
        const subscription = await client.readContract({ address: options.coordinator,
            abi: parseAbi(['function getSubscription(uint256) view returns (uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)']),
            functionName: 'getSubscription', args: [options.subscriptionId], blockNumber });
        subscriptionOwner = subscription[3];
        subscriptionLinkJuels = subscription[0].toString();
        if (subscription[0] === 0n && deployerLinkJuels === 0n) {
            throw new Error(
                'VRF subscription LINK balance is zero and deployer holds no LINK — fund the subscription or the deploy wallet before broadcast',
            );
        }
        if (subscriptionOwner.toLowerCase() !== options.deployer.toLowerCase()) {
            throw new Error('VRF subscription must be owned by the deployment signer to register the new engine. No deployment transaction sent.');
        }
    } else if (deployerLinkJuels === 0n) {
        throw new Error('Deployer holds no LINK — fund the deploy wallet; deploy creates a VRF subscription and drains all LINK into it');
    }
    const sizes = await checkProductionArtifacts();
    return { blockNumber: blockNumber.toString(), chainId: 42161, admin: options.admin, subscriptionOwner,
        subscriptionLinkJuels, deployerLinkJuels: deployerLinkJuels.toString(),
        deployerEth: deployerEth.toString(), deployerUsdc: deployerUsdc.toString(),
        factory, createVrfSubscription: options.subscriptionId === undefined, sizes, fundingSufficiencyVerified: false };
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

/** Read-back after handoff: admin holds every listed role; bootstrap holds none of them. */
export async function assertProtocolRoleHandoff(
    contracts: Array<{ contract: any; roles: string[]; label: string }>,
    bootstrap: Address,
    admin: Address,
) {
    for (const { contract, roles, label } of contracts) {
        for (const getter of roles) {
            const role = await contract.read[getter]();
            if (!(await contract.read.hasRole([role, admin]))) {
                throw new Error(`${label}: admin missing ${getter}`);
            }
            if (bootstrap.toLowerCase() !== admin.toLowerCase() && (await contract.read.hasRole([role, bootstrap]))) {
                throw new Error(`${label}: bootstrap still holds ${getter}`);
            }
        }
    }
}
