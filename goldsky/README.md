# `goldsky/` — superseded reference copy

⚠️ **Nothing in this repository reads this directory, and its contents describe a
protocol version that no longer exists.**

- `roulette-events-pipeline.yaml` targets `RouletteClean` — deleted — and still
  contains `YOUR_CONTRACT_ADDRESS` / `YOUR_ABI_GIST_RAW_URL` placeholders.
- `roulette-events-abi.json` declares `ComputedPayouts` and `JackpotResultEvent`.
  **No contract on `master` emits either event.** A pipeline built from this ABI
  would silently mirror nothing for those two, which is the failure mode worth
  knowing about: a mirror that is configured, running, and delivering no data.

## Where the live pipelines are

Both mirror pipelines are maintained in the sibling subgraph repository:

| File | Pipeline | Destination |
|---|---|---|
| `../subgraph/turbo.yaml` | `biribi-roulette-events` | `/api/mirror` (all protocol events) |
| `../subgraph/turbo-cre.yaml` | `biribi-cre-countdown` | CRE round-watcher webhook |

They are patched from `../subgraph/deployments/*.json` by `yarn sync:pipeline`, and
that repo's `check-constants` asserts the resulting addresses and start blocks in CI.

Treat this directory as history. If you need a mirror change, make it there.
