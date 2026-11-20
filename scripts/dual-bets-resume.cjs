#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Interface, getAddress, getCreateAddress, keccak256 } = require('ethers');
const C = require('./mask-bets-v1-common.cjs');
const U = require('./mask-bets-v1-mainnet.cjs');

const ENGINE = 'RouletteEngine';

/** Select the verified deployments in dependency order, then number only missing transactions. */
async function remainingDeployments({ definitions, candidates, reused, from, nonce, occupied, matches }) {
    const addresses = { ...reused };
    const transactions = [];
    const verified = [];
    for (const def of definitions) {
        const existing = candidates[def.name];
        const spec = def.build(addresses);
        if (existing && await matches(def, existing, spec)) {
            addresses[def.name] = existing;
            verified.push({ name: def.name, address: existing });
            continue;
        }
        const nextNonce = nonce + transactions.length;
        const predicted = getCreateAddress({ from, nonce: nextNonce });
        assert(!(await occupied(predicted)), `Predicted address for ${def.name} already has code`);
        addresses[def.name] = predicted;
        transactions.push({ name: def.name, nonce: nextNonce, to: null, data: spec.data, expectedCreateAddress: predicted });
    }
    return { addresses, transactions, verified };
}

function deploymentDefinitions(libraries, artifacts, deployment) {
    return [...libraries.redeploy, ENGINE].map(name => {
        const library = name !== ENGINE;
        const artifact = library ? artifacts.libraries[name] : artifacts.engine;
        return {
            name, library,
            build(addresses) {
                const args = library ? '' : new Interface(artifact.abi).encodeDeploy(deployment.engineConstructorArgs).slice(2);
                return { data: C.linkCreation(artifact, addresses) + args, expectedRuntime: C.linkRuntime(artifact, addresses) };
            },
        };
    });
}

function candidateAddresses(previous, definitions) {
    const names = new Set(definitions.map(def => def.name));
    const found = {};
    for (const verified of previous.verifiedDeployments ?? []) {
        assert(names.has(verified.name) && !found[verified.name], 'Unexpected previously verified deployment');
        found[verified.name] = getAddress(verified.address);
    }
    for (const item of previous.upgrade) {
        if (!item.expectedCreateAddress) continue;
        const name = item.name ?? item.label?.replace(/^Deploy /, '').replace(/ implementation$/, '');
        assert(names.has(name) && !found[name], 'Unexpected previous deployment step');
        const address = getCreateAddress({ from: previous.signer, nonce: item.nonce });
        assert.equal(getAddress(item.expectedCreateAddress), address, 'Previous CREATE address differs from its nonce');
        found[name] = address;
    }
    return found;
}

async function resumePlan(provider, deployment, artifacts, previous) {
    await C.assertNetwork(provider, 'mainnet');
    assert.equal(previous.chainId, C.MAINNET_CHAIN_ID);
    C.addressEqual(previous.signer, deployment.admin, 'Unexpected signer in previous plan');
    C.addressEqual(previous.proxy, deployment.engine, 'Unexpected proxy in previous plan');
    C.addressEqual(previous.oldEngine, deployment.engineImplementation, 'Unexpected baseline engine');
    assert.deepEqual(previous.artifactHashes, C.releaseLock(artifacts), 'Compiled artifact hashes differ from the previous plan');
    const [implementation, nonce, pendingNonce] = await Promise.all([
        C.implementationOf(provider, deployment.engine),
        provider.getTransactionCount(deployment.admin, 'latest'),
        provider.getTransactionCount(deployment.admin, 'pending'),
    ]);
    assert.equal(pendingNonce, nonce, 'Administrator has pending transactions');
    const alreadyInstalled = C.lower(implementation) === C.lower(previous.newEngine);
    if (!alreadyInstalled) C.addressEqual(implementation, deployment.engineImplementation, 'Unexpected live engine implementation');
    const check = alreadyInstalled ? null : await U.preflight({
        provider, d: deployment, artifacts, from: deployment.admin, lockPath: false,
    });
    if (check) assert.equal(check.nonce, nonce, 'Administrator nonce changed during validation');
    const libraries = check?.libraries ?? await U.resolveLibraries(provider, deployment, artifacts);
    const definitions = deploymentDefinitions(libraries, artifacts, deployment);
    const candidates = candidateAddresses(previous, definitions);
    const rebuilt = await remainingDeployments({
        definitions, candidates, reused: libraries.reused, from: deployment.admin, nonce,
        occupied: async address => await provider.getCode(address) !== '0x',
        matches: async (def, address, spec) => {
            const code = await provider.getCode(address);
            if (code === '0x') return false;
            const ranges = def.library ? [] : C.immutableRanges(artifacts.engine);
            const normalized = raw => C.normalizeRuntime(raw, { library: def.library, immutables: ranges });
            if (normalized(code) !== normalized(spec.expectedRuntime)) return false;
            await U.verifyDeployment(provider, { ...def, ...spec, predicted: address }, artifacts, deployment);
            return true;
        },
    });
    const newEngine = rebuilt.addresses[ENGINE];
    if (alreadyInstalled) {
        assert.equal(rebuilt.transactions.length, 0, 'Installed engine dependencies could not be verified');
        C.addressEqual(implementation, newEngine, 'Installed engine differs from verified artifact');
    } else {
        rebuilt.transactions.push({
            name: 'upgradeToAndCall', nonce: nonce + rebuilt.transactions.length, to: deployment.engine,
            data: new Interface(C.ENGINE_ABI).encodeFunctionData('upgradeToAndCall', [newEngine, '0x']),
        });
    }
    const [finalNonce, finalImplementation] = await Promise.all([
        provider.getTransactionCount(deployment.admin, 'pending'),
        C.implementationOf(provider, deployment.engine),
    ]);
    assert.equal(finalNonce, nonce, 'Administrator nonce changed during validation');
    C.addressEqual(finalImplementation, implementation, 'Proxy implementation changed during validation');
    if (!alreadyInstalled) await C.assertUpgradeWindow(C.contracts(provider, deployment), check.markets.map(market => market.marketId));
    return {
        format: 'biribi-unsigned-engine-only',
        status: alreadyInstalled ? 'engine-verified' : 'unsigned-resumed',
        chainId: C.MAINNET_CHAIN_ID, block: await provider.getBlockNumber(),
        signer: deployment.admin, proxy: deployment.engine,
        oldEngine: deployment.engineImplementation, newEngine, adminNonce: nonce,
        artifactHashes: C.releaseLock(artifacts),
        verifiedDeployments: rebuilt.verified,
        upgrade: rebuilt.transactions.map(item => ({
            ...item, chainId: C.MAINNET_CHAIN_ID, from: deployment.admin, value: '0', dataHash: keccak256(item.data),
        })),
    };
}

async function main(args) {
    assert(args.length === 4 && args[0] === '--from' && args[2] === '--out',
        'Usage: node scripts/dual-bets-resume.cjs --from unsigned.json --out next-unsigned.json');
    const previous = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const p = new C.ReadOnlyProvider(C.rpcUrl(), C.MAINNET_CHAIN_ID, { staticNetwork: true });
    try {
        const plan = await resumePlan(p, C.loadMainnetDeployment(), C.loadArtifacts(), previous);
        fs.writeFileSync(args[3], C.stringify(plan) + '\n', { flag: 'wx' });
        console.log(`${plan.status}: ${plan.verifiedDeployments.length} verified, ${plan.upgrade.length} unsigned transactions`);
    } finally {
        p.destroy();
    }
}

module.exports = { remainingDeployments, resumePlan };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
    console.error(C.redact(error));
    process.exitCode = 1;
});
