# CLAUDE.md — Biribi Contracts

> Smart contracts for the Biribi protocol — decentralized roulette on Arbitrum.

## Project Context

### Stack

| Layer | Technology |
|-------|------------|
| Language | Solidity 0.8.27 |
| Framework | Hardhat (TypeScript config) |
| EVM | Cancun |
| Dependencies | OpenZeppelin, Chainlink |
| Testing | Chai + Hardhat Network Helpers + Viem |
| ABI Codegen | Wagmi CLI (`../frontend/lib/abi/generated.ts`) |
| Coverage | solidity-coverage |

### Domain

Biribi uses a multi-market architecture where each market has:
- an asset token
- a `BankVault4626` liquidity vault
- shared roulette game logic in `RouletteEngine`

Core mechanics:
- typed roulette bets (`betType`, `number`) with legacy multipliers
- Chainlink VRF for randomness
- Chainlink Automation via scheduler/manager
- global rounds that can include multiple markets
- global jackpot pool funded by a bet fee share

## Current Contract Architecture

| Contract | Purpose |
|----------|---------|
| `RouletteEngine.sol` | Core game logic: rounds, locking, VRF, payout batching, jackpot resolution |
| `BankVault4626.sol` | Per-market vault for locked bets, payouts, ERC-4626 liquidity |
| `MarketRegistry.sol` | Market registration/config |
| `UpkeepScheduler.sol` | Finds/executes engine jobs |
| `UpkeepManager.sol` | Upkeep lane registration/ops |
| `MockUSDC.sol` | Test/development ERC-20 market asset |

Libraries:
- `libraries/RouletteBetLib.sol`
- `libraries/BetStorageLib.sol`
- `libraries/PayoutMathLib.sol`
- `libraries/UpkeepCodecLib.sol`

## Key Commands

```bash
yarn compile
yarn test
yarn coverage
yarn clean
yarn update:subgraph:abis
```

## Testing Notes

- Keep tests asset-agnostic (avoid token-brand coupling in names/assertions).
- Validate both per-market and cross-market behavior.
- Always include access-control and revert-path tests.
- Use realistic token amounts for each token decimals model.

## Engineering Standards

### Solidity
- Prefer custom errors over revert strings.
- Emit events for all critical state transitions.
- Follow checks-effects-interactions.
- Use immutable/state packing where appropriate.
- Keep loops gas-bounded.

### Security
- Use role-based access control for privileged actions.
- Avoid `tx.origin`.
- Avoid untrusted `delegatecall`.
- Keep VRF callback source validated.

### Workflow
- Keep commits atomic.
- Run compile + relevant tests before commit.
- Update wagmi/subgraph ABIs after contract-interface changes.
