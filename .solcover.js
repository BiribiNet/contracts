module.exports = {
    // Linked libraries are not attributed reliably by solidity-coverage; keep them skipped
    // and treat engine/funder/vault/side-bet coverage as the release gate.
    skipFiles: ['external', 'test', 'interfaces', 'libraries', 'vendor'],
    useProxy: true,
    // Stress/swarm suites blow the coverage-instrumented heap; run them via yarn test:swarm.
    mocha: {
        grep: /Hundred-player|Jackpot batching stress|Jackpot completion across parallel|Mainnet BRB swarm|Gas scaling guards|Arbitrum One isolated/,
        invert: true,
    },
};