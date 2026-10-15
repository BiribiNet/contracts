import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http, parseAbi, getAddress, keccak256, formatUnits } from 'viem';

export const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

export function slotAddress(value) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? '') || BigInt(value) === 0n || BigInt(value) >> 160n) {
    throw new Error('Missing or invalid proxy address slot');
  }
  return getAddress(`0x${value.slice(-40)}`);
}

export function assessVrf({ balance, consumers, engine, pending }) {
  const issues = [];
  if (!consumers.some(address => address.toLowerCase() === engine.toLowerCase())) issues.push('ENGINE_NOT_REGISTERED');
  if (BigInt(balance) === 0n) issues.push('SUBSCRIPTION_LINK_EMPTY');
  if (pending) issues.push('VRF_REQUEST_PENDING');
  return { issues, fundingSufficient: null, note: 'A positive balance does not establish sufficient funding. Wallet LINK is not subscription LINK.' };
}

export async function inspectProtocol(client, config) {
  if (await client.getChainId() !== 421614) throw new Error('Expected Arbitrum Sepolia (421614)');
  const block = await client.getBlock();
  const blockNumber = block.number;
  const read = (address, signature, functionName, args = []) => client.readContract({ address, abi: parseAbi([signature]), functionName, args, blockNumber });
  const code = async address => {
    const value = await client.getBytecode({ address, blockNumber });
    if (!value || value === '0x') throw new Error(`No deployed code at ${address}`);
    return { address, codeHash: keccak256(value), bytes: (value.length - 2) / 2 };
  };
  const engine = getAddress(config.addresses.roulette);
  const registry = getAddress(config.addresses.registry);
  const implementation = slotAddress(await client.getStorageAt({ address: engine, slot: IMPLEMENTATION_SLOT, blockNumber }));
  const [subscriptionId, pending, round, callbackGasLimit, scheduler, beacon, count] = await Promise.all([
    read(engine, 'function VRF_SUBSCRIPTION_ID() view returns (uint256)', 'VRF_SUBSCRIPTION_ID'),
    read(engine, 'function hasPendingVrf() view returns (bool)', 'hasPendingVrf'),
    read(engine, 'function currentGlobalRound() view returns (uint64)', 'currentGlobalRound'),
    read(engine, 'function VRF_CALLBACK_GAS_LIMIT() view returns (uint32)', 'VRF_CALLBACK_GAS_LIMIT'),
    read(engine, 'function UPKEEP_SCHEDULER() view returns (address)', 'UPKEEP_SCHEDULER'),
    read(registry, 'function vaultBeacon() view returns (address)', 'vaultBeacon'),
    read(registry, 'function marketCount() view returns (uint32)', 'marketCount'),
  ]);
  if (Number(count) > 1000) throw new Error('Unexpected market count; inspect registry manually');
  const [vaultImplementation, beaconOwner] = await Promise.all([
    read(beacon, 'function implementation() view returns (address)', 'implementation'),
    read(beacon, 'function owner() view returns (address)', 'owner'),
  ]);
  const banks = [];
  for (let id = 1; id <= Number(count); id++) {
    const market = await read(registry, 'function getMarket(uint32) view returns ((address asset,address bank))', 'getMarket', [id]);
    const actualBeacon = slotAddress(await client.getStorageAt({ address: market.bank, slot: BEACON_SLOT, blockNumber }));
    if (actualBeacon.toLowerCase() !== beacon.toLowerCase()) throw new Error(`Market ${id} uses a different beacon`);
    const [assets, shares, locked, tokenBalance] = await Promise.all([
      read(market.bank, 'function totalAssets() view returns (uint256)', 'totalAssets'),
      read(market.bank, 'function totalSupply() view returns (uint256)', 'totalSupply'),
      read(market.bank, 'function lockedBetLiquidity() view returns (uint256)', 'lockedBetLiquidity'),
      read(market.asset, 'function balanceOf(address) view returns (uint256)', 'balanceOf', [market.bank]),
    ]);
    banks.push({ marketId: id, ...market, beacon: actualBeacon, assets, shares, locked, tokenBalance });
  }
  // Coordinator is supplied by the deployment catalog; this is not a bytecode/immutable proof.
  const coordinator = getAddress(config.vrf.coordinator);
  const [balance, nativeBalance, requestCount, owner, consumers] = await read(coordinator,
    'function getSubscription(uint256) view returns (uint96,uint96,uint64,address,address[])', 'getSubscription', [subscriptionId]);
  const [engineCode, vaultCode] = await Promise.all([code(implementation), code(vaultImplementation)]);
  const endingBlock = await client.getBlock({ blockNumber });
  if (endingBlock.hash !== block.hash) throw new Error('Pinned block changed during inspection; retry');
  return {
    chainId: 421614, blockNumber, blockHash: block.hash, timestamp: block.timestamp,
    engine: { proxy: engine, implementation: engineCode, round, pending, callbackGasLimit, scheduler },
    vaults: { beacon, owner: beaconOwner, implementation: vaultCode, banks },
    vrf: { coordinator, coordinatorSource: 'deployment-catalog-not-immutable-verified', subscriptionId, balance, link: formatUnits(balance, 18), nativeBalance, requestCount, owner, consumers, ...assessVrf({ balance, consumers, engine, pending }) },
    upgradeApproved: false,
    remainingChecks: ['Match deployed bytecode to reproducible source and storage layout', 'Validate append-only storage compatibility', 'Simulate upgrade and settlement on a pinned fork', 'Validate staging index before public alias change'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [catalog, output] = process.argv.slice(2);
    if (!catalog || !output) throw new Error('Usage: node scripts/protocol-preflight.mjs deployment.json report.json');
    const client = createPublicClient({ transport: http(process.env.PREFLIGHT_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc', { timeout: 30000, retryCount: 1 }) });
    const report = await inspectProtocol(client, JSON.parse(readFileSync(catalog, 'utf8')));
    writeFileSync(output, JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    console.log(`Read-only report saved. Block ${report.blockNumber}; VRF flags: ${report.vrf.issues.join(', ') || 'none'}. Upgrade is not approved by this check.`);
  } catch (error) {
    // Avoid exposing RPC URL credentials through client error messages.
    console.error('Preflight failed; no transaction was sent. Check chain, deployment catalog and RPC availability.');
    process.exitCode = 1;
  }
}
