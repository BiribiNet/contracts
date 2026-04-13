# CLAUDE.md — Biribi Contracts

> Smart contracts for the Biribi protocol — a fully decentralized French roulette on Arbitrum.

---

## Project Context

### Stack

| Layer | Technology |
|-------|-----------|
| **Language** | Solidity 0.8.27 |
| **Framework** | Hardhat 2.24.x (TypeScript config) |
| **EVM** | Cancun (for mcopy, newer OZ features) |
| **Optimizer** | Enabled, 1 run (minimal bytecode — StakedBRB is near EIP-170 limit) |
| **Dependencies** | OpenZeppelin 5.6.1 (contracts + upgradeable), Chainlink 1.4.0 |
| **Testing** | Chai + Hardhat Network Helpers + Viem |
| **TypeScript** | 5.8.x (`strict: true`) |
| **ABI Codegen** | Wagmi CLI → outputs to `../frontend/lib/abi/generated.ts` |
| **Gas Reporting** | hardhat-gas-reporter (Arbitrum L2, EUR currency) |
| **Coverage** | solidity-coverage (skips `external/`, `test/`, `interfaces/`) |
| **Linting** | ESLint 9 (typescript-eslint + perfectionist for import sorting) |
| **Formatting** | Prettier 3 + prettier-plugin-solidity (120-char, 4-space indent for `.sol`) |
| **Package Manager** | Yarn 4.5.1 |
| **Node** | v22.0.0 |

### Domain

BiRiBi is a **decentralized French roulette** on Arbitrum. Key concepts:

- **BRB token** — ERC-20 used for bets, staking, and rewards (30M fixed supply)
- **StakedBRB (sBRB)** — ERC-4626 vault, 95% of protocol revenue redistributed to stakers
- **Chainlink VRF v2+** — provably fair on-chain randomness for each round
- **Chainlink Automation** — trustless upkeep for round resolution and payout batches
- **Revenue split per round**: 95% stakers, 2.5% jackpot, 0.5% BRB burn, 2% infrastructure

### Contract Architecture

| Contract | Purpose | Pattern |
|----------|---------|---------|
| **BRB.sol** | ERC-20 token (30M supply), ERC20Permit, ERC-677 `bet()`, `transferBatch()` | Non-upgradeable |
| **RouletteClean.sol** | Game logic: rounds, VRF requests, payout batch processing | UUPS, AccessControl, VRFConsumerBaseV2, AutomationCompatible |
| **StakedBRB.sol** | ERC-4626 vault: staking, betting integration, fees, withdrawal queue | UUPS, ERC4626, AccessControl, AutomationCompatible |
| **JackpotContract.sol** | Jackpot pool management and payouts | AccessControl |
| **BRBReferal.sol** | Referral reward token (BRBR), mintable only by StakedBRB | Non-upgradeable ERC-20 |
| **BRBUpkeepManager.sol** | Chainlink Automation upkeep registration and forwarder management | AccessControl |
| **StakedBRBLiquidityEscrow.sol** | Holds BRB for queued vault deposits until settlement | Minimal, immutable addresses |

### Libraries

| Library | Purpose |
|---------|---------|
| **RouletteLib.sol** | Max payout calculations, safety buffer (110% BPS), bet validation |
| **StakedBRBFeeMath.sol** | Fee split math (protocol, burn, jackpot) — extracted to keep StakedBRB under bytecode limit |

### Interfaces

10 interfaces in `contracts/interfaces/`: `IRoulette`, `IStakedBRB`, `IBRB`, `IJackpotContract`, `IBRBUpkeepManager`, `IERC20Burnable`, `IERC20Mintable`, `IERC677`, `IAutomationRegistrar2_1`, `IAutomationRegistry2_1`

### File Structure

```
contracts/
├── contracts/
│   ├── BRB.sol
│   ├── RouletteClean.sol
│   ├── StakedBRB.sol
│   ├── JackpotContract.sol
│   ├── BRBReferal.sol
│   ├── BRBUpkeepManager.sol
│   ├── StakedBRBLiquidityEscrow.sol
│   ├── RouletteLib.sol
│   ├── StakedBRBFeeMath.sol
│   ├── external/               # Vendored: VRFConsumerBaseV2, Strings, Imports
│   ├── interfaces/             # 10 interface contracts
│   └── test/                   # Mock contracts (MockLinkToken, MockKeeperRegistry, etc.)
├── test/
│   ├── RouletteClean.test.ts
│   ├── StakedBRB.test.ts
│   ├── RouletteAutomation.test.ts
│   └── fixtures/
│       └── deployWithCreateFixture.ts
├── scripts/
│   ├── deployFactory.ts            # Main factory deployment
│   ├── deployFactoryFrame.ts       # Frame-based factory deployment
│   ├── deployFactoryFrameV1ToV2.ts # V1-to-V2 migration
│   ├── deployProxyOnly.ts          # Proxy-only deployment
│   ├── deployTestnet.ts            # Testnet deployment
│   ├── distributeBRB.ts            # Token distribution
│   ├── verifyOnly.ts               # Contract verification
│   ├── update-subgraph-abis.mjs    # Copies compiled ABIs to ../subgraph/abis/
│   └── utils/
├── ignition/modules/               # Hardhat Ignition deployment modules
├── goldsky/                        # Goldsky pipeline ABI + config
├── hardhat.config.ts               # Compiler settings, gas reporter, etherscan
├── hardhat.network.ts              # Network definitions (15 networks)
├── wagmi.config.ts                 # ABI codegen for frontend
├── eslint.config.ts
├── .prettierrc
├── .solcover.js
├── tsconfig.json                   # paths: ~/modules/* → ignition/modules/*
├── .nvmrc                          # v22.0.0
└── CLAUDE.md
```

### Key Patterns

- **UUPS Proxy** — RouletteClean and StakedBRB use OpenZeppelin's UUPS (Universal Upgradeable Proxy Standard) with `_disableInitializers()` in constructors
- **ERC-4626 Vault** — StakedBRB wraps BRB as a yield-bearing vault with deposit/withdrawal queues
- **EIP-7201 Namespaced Storage** — Upgrade-safe storage layout for RouletteClean and StakedBRB
- **Chainlink VRF v2+** — RouletteClean consumes random words for provably fair outcomes
- **Chainlink Automation** — Both RouletteClean and StakedBRB implement `AutomationCompatibleInterface` for trustless upkeep (2M gas for cleaning, 1.75M for payouts)
- **Batch Processing** — Payout batches of 35 users per tx to stay within gas limits
- **Queue Architecture** — Deposits go through `StakedBRBLiquidityEscrow` with anti-spam limits; large withdrawals queued with batch processing
- **AccessControlUpgradeable** — Role-based permissions on all critical functions
- **Library Extraction** — `RouletteLib` and `StakedBRBFeeMath` extracted to keep main contracts under the 24KB bytecode limit

### Key Commands

```bash
yarn compile              # hardhat compile + wagmi generate (typed ABIs for frontend)
yarn test                 # Run all Hardhat tests
yarn coverage             # Solidity coverage (SOLIDITY_COVERAGE=true)
yarn clean                # Clean artifacts and cache
yarn node                 # Start local Hardhat node
yarn deploy:local         # Deploy via Ignition to localhost
yarn deploy:sepolia       # Deploy to Sepolia testnet
yarn deploy:gnosis        # Deploy to Gnosis mainnet
yarn deploy:tenderly      # Deploy to Tenderly staging
yarn update:subgraph:abis # Copy compiled ABIs to ../subgraph/abis/
```

### Testing

- **Framework**: Chai assertions + Hardhat Network Helpers (`@nomicfoundation/hardhat-network-helpers`) + Viem
- **Test files**: `RouletteClean.test.ts`, `StakedBRB.test.ts`, `RouletteAutomation.test.ts`
- **Shared fixture**: `test/fixtures/deployWithCreateFixture.ts` — deploys the full contract stack for each test suite
- **Mock contracts**: `MockLinkToken`, `MockKeeperRegistry`, `VRFCoordinatorV2_5Mock`, `MockUSDC`, `AggregatorV3Mock`, etc.
- **Coverage**: Excludes `external/`, `test/`, `interfaces/` directories

### Deployment & Networks

15 networks configured in `hardhat.network.ts`, all gated behind `vars.has('BRB_KEY')`:

| Network | Chain ID | Usage |
|---------|----------|-------|
| hardhat | 31337 | Local testing (unlimited contract size) |
| localhost | 31337 | Local node |
| arbitrum | 42161 | Mainnet |
| arbitrumsepolia | 421614 | Primary testnet |
| gnosis | 100 | Mainnet |
| mainnet | 1 | Ethereum mainnet |
| sepolia | 11155111 | Ethereum testnet |
| tenderly | — | Staging/testing |
| bsc / bsctest | 56 / 97 | BSC |
| matic / mumbai | 137 / 80001 | Polygon |
| holesky / goerli / sokol | — | Additional testnets |

Environment variables: `BRB_KEY` (deployer private key), `*_RPC_URL` (per-network), `ETHERSCAN_API_KEY` (verification), `REPORT_GAS` (gas reporter).

### Code Style

- **Prettier**: 120-char width, single quotes (TS), double quotes (Solidity), 4-space indent for `.sol`, 2-space for TS
- **ESLint**: TypeScript + Prettier + Perfectionist plugin for import sorting
- **Solidity**: Follow OpenZeppelin conventions — NatSpec on public/external, custom errors over require strings, checks-effects-interactions

### Cross-Repo Integration

- `yarn compile` runs `wagmi generate` which outputs typed ABIs to `../frontend/lib/abi/generated.ts`
- `yarn update:subgraph:abis` copies compiled ABIs to `../subgraph/abis/`
- Included contracts in wagmi config: BRB, StakedBRB, RouletteClean, JackpotContract, BRBReferal, VRFCoordinatorV2_5Mock, AutomationRegistry

---

## Engineering Standards

### Solidity Rules

- **Custom errors** over `require("string")` — saves gas and is more expressive
- **Events for all state changes** — the subgraph depends on complete event coverage
- **Checks-effects-interactions** — always update state before external calls
- **NatSpec** on all public/external functions — `@notice`, `@param`, `@return`
- **Immutable constructor args** for gas optimization where possible
- **`_disableInitializers()`** in constructors of upgradeable contracts
- **Library pattern** for heavy logic to stay under EIP-170 bytecode limit

### Security

- **AccessControl** for all privileged operations — never `onlyOwner` alone
- **EIP-7201** namespaced storage for upgrade safety
- **No `tx.origin`** — always `msg.sender`
- **No `delegatecall` to untrusted contracts**
- **Reentrancy protection** via checks-effects-interactions pattern
- **VRF callback validation** — only accept results from the coordinator
- **Gas-bounded loops** — batch processing with configurable batch size (default 35)
- **Anti-spam limits** on deposits and withdrawal queue

### Testing

- Every new function must have at least one test for the happy path and one for a revert case
- Use the shared fixture (`deployWithCreateFixture.ts`) for consistent test setup
- Test with realistic values (not 1 wei) — use BRB amounts in the expected range
- Always test access control (unauthorized caller should revert)
- Test upgrade paths when modifying upgradeable contracts

### Git & Workflow

- **Conventional Commits**: `feat:`, `fix:`, `refactor:`, `chore:`, `test:`
- **Atomic commits**: one logical change per commit
- Run `yarn test` before every commit
- Run `yarn compile` to verify ABI generation after contract changes

### Forbidden Patterns

| Pattern | Use instead |
|---------|------------|
| `require("string message")` | Custom errors (`error InsufficientBalance()`) |
| `tx.origin` | `msg.sender` |
| `assembly` without justification | Solidity built-ins |
| `selfdestruct` | Never — deprecated and dangerous |
| Unchecked arithmetic on user input | `SafeMath` or Solidity 0.8+ built-in checks |
| `block.timestamp` for randomness | Chainlink VRF |
| Storage in loops without caching | Cache storage reads in memory variables |
| Magic numbers | Named constants (`uint256 constant MAX_BATCH_SIZE = 35`) |
| `string` for addresses in events | `address` or `bytes20` |
