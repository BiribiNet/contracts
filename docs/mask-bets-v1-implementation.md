# Paris par masque v1 — notes d'implémentation

> Spécification : [`spec-mask-bets-v1.md`](spec-mask-bets-v1.md) (décisions D1–D21). Ce document ne décrit que
> ce qui a été implémenté, les écarts et les mesures. **Aucun déploiement** n'a été effectué : un audit
> externe est requis avant mainnet et l'ordre de déploiement reste celui du §10 de la spec.

## Ce qui est livré

| Zone | Fichier | Contenu |
|---|---|---|
| Bibliothèque neuve | `contracts/libraries/RouletteMaskBetLib.sol` | décodage/validation (bits ≥ 53, `2 ≤ \|S\| ≤ 24`, garde, `expectedPrev`), `minBet` par jambe, plafond de jambes, push `MaskBetEntry`, compteurs uint16 × 37, compteur prudent `roundMaskWeightedPayout`, setter par marché |
| Stockage | `contracts/libraries/RouletteEngineStorageLib.sol` | `MaskBetEntry` + 5 champs **en fin** de `Layout` (après `jackpotPreparation`) |
| Passif | `contracts/libraries/RouletteLiabilityMathLib.sol` | terme masque dans `Inputs`/`raw` (option (a)) ; `assertSolventAfterBet` (solvabilité + plafond bps) |
| Paiement | `contracts/libraries/RoulettePayoutSweepLib.sol` | comptage O(1) au callback VRF (`_accumulateCountShards`), `_sweepMasks` **en dernier** dans l'aperçu |
| Moteur | `contracts/RouletteEngine.sol` | `BET_MASK = 16`, appel unique à la bibliothèque par `recordBet`, `setMaskBetLimits` (`ENGINE_ROUND_ROLE`, événement `MaskBetLimitsUpdated`), `maskBetState`, lecture de `totalAssets()` (plus d'import `ISideBetVault`) |
| Vault | `contracts/BankVault4626.sol` | surface side bet supprimée, 14 champs inchangés (`_deprecatedSideBetController`), `releaseBets`/`payoutBatch`/`transferOut` en `onlyEngine`, `InitializeParams` inchangé, `availableForSideBet()` conservé en vue |
| Scripts | `scripts/utils/deployRouletteEngineLibraries.ts`, `predictDeployAddresses.ts` | 11ᵉ bibliothèque déployée **en dernier** (adresses des 10 existantes inchangées) |

Le moteur est livré **masques désactivés** : `maxMaskLegsPerMarketRound = 0` sur tous les marchés tant que
`setMaskBetLimits` n'a pas été appelé (valeurs de lancement D18 : 1 024 jambes, 1 000 bps).

## Écarts et précisions par rapport à la spec

1. **Erreur du plafond de jambes** : la spec nomme `MaskBetsDisabled` (plafond à 0) mais pas l'erreur du cas
   `N + 1` ; ajout de `MaskLegCapExceeded()`. Le setter rejette `maxLegs > 65 535` (garantie de non-débordement
   des compteurs uint16) et `bps > 10 000` avec `InvalidMaskBetLimits()`, et un marché inconnu avec
   `InvalidMarketId()` (registre).
2. **Lecture du résultat précédent** : faite **une seule fois par transaction**, mais elle touche deux slots de
   la structure existante `GlobalRoundState` (`vrfFulfilled`, `winningNumber`), non modifiable. Mesure :
   1ʳᵉ jambe gardée + 4 744 gaz, jambe gardée suivante + 183 gaz.
3. **`expectedPrev ∈ [37, 63]` avec garde** ⇒ `PreviousOutcomeMismatch` (règle 5 du §1.3) ; sans garde,
   `expectedPrev ≠ 0` ⇒ `InvalidBetNumber`.
4. **Plafond bps** vérifié seulement quand la transaction contient une jambe masque : baisser le plafond en
   cours de round ne bloque jamais un pari classique.
5. **Callback VRF** : surcoût constant ≈ 2,2 k gaz par marché participant (lecture du mot de compteurs +
   répartition fermée sur 10 lanes), identique pour 10 ou 1 024 masques — la spec estimait « quelques
   centaines ». 3 marchés × (100 pleins + 1 024 masques) : 1 054 426 gaz (limite 2 500 000).
6. **Aperçu au plafond** : le dernier bloc d'une lane parcourt les 1 024 masques ⇒ **2 925 620 gaz d'`eth_call`**
   (spec : ≈ 2,2 M). Plafond de gaz des `eth_call` CRE toujours à confirmer (point ouvert de la spec).
7. **Ordre de traitement** : dans une transaction mixte, les jambes classiques sont enregistrées dans la boucle
   du moteur, puis toutes les jambes masque en un seul appel de bibliothèque.
8. Getter unique `maskBetState(roundId, marketId)` (limites du marché + nombre de jambes + passif masque),
   pour préserver la marge EIP-170 du moteur.

## Mesures (Hardhat local, marché 6 décimales, mise = `minBet`)

| Transaction | Gaz |
|---|---|
| 1er pari du round (plein, démarre le compte à rebours) | 427 326 |
| 1er masque du round (\|S\| = 2) | 305 584 |
| masque suivant, \|S\| = 2 | 254 284 |
| masque suivant, \|S\| = 24 | 278 048 |
| cheval suivant (référence) | 271 573 |
| 10 masques en une transaction | 731 088 ⇒ **≈ 53 000 gaz par jambe masque marginale** |
| callback VRF, 3 marchés × (100 pleins + 1 024 masques gagnants) | 1 054 426 (sans masques : 1 047 793) |
| `eth_call` `previewPayoutBundle`, dernier bloc d'une lane au plafond de 1 024 masques | 2 925 620 |

Tailles : `reports/mask-bets-v1/bytecode-sizes.json` (moteur 22 379 → 23 130, vault 15 435 → 14 401,
`RouletteMaskBetLib` 3 008, `RoulettePayoutSweepLib` 7 599 → 8 318, `RouletteLiabilityMathLib` 2 317 → 2 674).
`RouletteUpkeepScanLib` est inchangée en source mais doit être **redéployée** (adresse liée de
`RoulettePayoutSweepLib`).

## Tests

`test/MaskBets.test.ts`, `test/MaskBetsSafety.test.ts`, `test/MaskBetsStorageLayout.test.ts`, extension de
`test/VrfCallbackBudget.test.ts` et de `test/EngineStorageLayout.test.ts` (`docs/storage/RouletteEngineStorage.v2.json`).
Rapports : `reports/mask-bets-v1/` (tailles, budget VRF, layouts de référence de `master`).

Les suites SideBet historiques (et les suites de couverture qui exercent `lockSideBetStake`) tournent contre
`contracts/test/legacy/LegacySideBetBankVault4626.sol`, copie figée **de test** du vault précédent : SideBet est
inchangé (D20) mais ne peut plus placer de ticket sur le nouveau vault, ce qui est précisément l'objectif.

Le test fork mainnet du §9 n'est pas inclus : il exige un RPC archive Arbitrum, absent sans secret dans cet
environnement.

## ABI à régénérer au lot suivant (non fait ici)

- `RouletteEngine` : `setMaskBetLimits`, `maskBetState`, événement `MaskBetLimitsUpdated`, erreurs
  `MaskBetsDisabled`, `MaskLegBelowMinBet`, `MaskLegCapExceeded`, `MaskLiabilityCapExceeded`,
  `PreviousOutcomeMismatch`, `InvalidMaskBetLimits`.
- `BankVault4626` : retrait de `lockSideBetStake`, `setSideBetController`, `sideBetController`, des événements
  `SideBetControllerUpdated`/`SideBetStakeLocked` et des erreurs `OnlySideBet`, `InsufficientSideBetLiquidity`,
  `UnauthorizedSettlementCaller` (le subgraph doit **garder** les événements side bet pour l'historique, §8.1).
- Nouvelles bibliothèques/erreurs : `RouletteMaskBetLib`, `RouletteLiabilityMathLib` (`MaskLiabilityCapExceeded`).
- Frontend : `lib/abi/generated.ts`, `lib/abi/merged-errors.json` ; subgraph : `abis/RouletteEngine.json`,
  `abis/BankVault4626.json`.

Les scripts de vérification mainnet qui lisent `sideBetController()` sur les vaults déployés passent par une ABI
explicite (`readLegacySideBetController`) ; ils devront être revus au lot de déploiement.
