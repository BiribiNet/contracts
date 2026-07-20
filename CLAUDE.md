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

#### BRB token & Jackpot v2 (new)

- **BRB** is a protocol token in the Biribi ecosystem.
- **Jackpot payouts are denominated in BRB** (not the market asset).
- **Jackpot funding**:
  - When a round ends with **protocol profit** (marketWin), swap a configurable portion of that profit into **BRB** against a **Uniswap V2 BRB/<asset> pool**.
  - Default target is **3% of marketWin** swapped to BRB.
    - **2.5%** of marketWin worth of BRB goes to the jackpot treasury/contract.
    - **0.5%** of marketWin worth of BRB is **burned**.
  - These **BPS values MUST be changeable in the future** via privileged, role-gated setters (with events).
- **Per-market BRB conversion**:
  - Treating “1 BRB = 1 USDC = 1 USDT” is not universally safe onchain; each market must have a configurable **BRB conversion ratio / price source** (design can live in `BankVault4626` or `RouletteEngine`, but must be explicit, configurable, and testable).
- **Per-market minimum bet (anti-DoS)**:
  - Each market MUST have a configurable **minimum bet amount** to avoid griefing/DOS via dust bets that increase storage and automation work.
  - Prefer enforcing this **in `BankVault4626` before calling `recordBet`** (cheap rejection) and optionally mirror as a backstop in `RouletteEngine`.
- **Jackpot eligibility + winning rule**:
  - Jackpot can be won **only by STRAIGHT bets** on the winning number (per-market `minBet` on the bank enforces stake size).
  - **Jackpot is proportional**: eligible players receive a **share of the jackpot proportional to how much they bet on the jackpot number** (not winner-takes-all).
    - Example: if total eligible stake on the winning number is \(S\), and player stake is \(s_i\), then payout share is \(J \cdot s_i / S\).
- **Liquidity + vesting/lock requirement**:
  - A vesting/lock contract must hold the **Uniswap V2 LP tokens** for the BRB liquidity pool.
  - **Lock period: 3 years** (no early withdrawal except explicitly designed emergency policy).

Core mechanics:
- typed roulette bets (`betType`, `number`) with legacy multipliers
- Chainlink VRF for randomness
- Chainlink CRE workflows via `UpkeepScheduler` + `AutomationReceiver`
- global rounds that can include multiple markets
- global jackpot pool funded by a bet fee share

## Current Contract Architecture

| Contract | Purpose |
|----------|---------|
| `RouletteEngine.sol` | Core game logic: rounds, locking, VRF, payout batching, jackpot resolution |
| `BankVault4626.sol` | Per-market vault for locked bets, payouts, ERC-4626 liquidity |
| `MarketRegistry.sol` | Market registration/config |
| `UpkeepScheduler.sol` | Finds/executes engine jobs (`checkUpkeep` / `performUpkeep`) |
| `AutomationReceiver.sol` | CRE bridge: forwards signed reports to `performUpkeep` |
| `CreExecutionAuthority.sol` | Approves CRE receiver as upkeep executor |
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
- **Permit safety**: include a safe “permit + place bet” flow using a **try-pattern** so a front-run / already-used permit does not brick the bet path (fall back to normal allowance path). Prefer Permit2 or EIP-2612 where available; treat non-standard tokens carefully.
- **Jackpot accounting safety**: ensure jackpot-share math is monotonic, cannot overflow, and cannot be griefed by dust bets; define rounding policy and test it.

### Workflow
- Keep commits atomic.
- Run compile + relevant tests before commit.
- Update wagmi/subgraph ABIs after contract-interface changes.
