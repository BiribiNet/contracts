# Full BRB/USDC liquidity removal — simulation only

Both simulated steps succeeded. No transaction was signed or broadcast; no private key was loaded.

- Tenderly virtual chain: 99942161 (Arbitrum One source)
- Block: 515108108 (0xd7e309713937fb4299e6bf1197c9993a89a4aba111d1b6fa71a9f52d08bbac80)
- Pair: 0x848A51FaD11746bca839DF587C3Cde450bDfb853
- Owner and recipient: 0x90416a578646be1c3b2e6aa0a2f593445ca3ebce
- Router: 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24
- LP amount: 0.239999999999999 (239999999999999000 raw), all LP held by the owner
- Existing allowance: 0; simulated exact approval before removal
- BRB received: 2399999.99999999
- USDC received: 23999.999999
- Pool remainder: 0.00000001 BRB and 0.000001 USDC
- Permanently burned minimum liquidity remains: 1000 raw LP units
- Gas used: approval 49966; removal 219860; total 269826
- Slippage tolerance for the simulated call: 0.5%; deadline: one hour after snapshot timestamp

The bundle used tenderly_simulateBundle at the pinned block without state overrides. Gas price was zero for simulation; gas usage is not a live fee quote. The full JSON includes the exact request, decoded events, return values, and execution traces.

After simulation, read-back verified that the LP balance, router allowance, wallet nonce, token balances, reserves, and LP supply remained unchanged.
