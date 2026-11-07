# Paris par masque v1 — notes d'implémentation

> Spécification : [`spec-mask-bets-v1.md`](spec-mask-bets-v1.md) (décisions D1–D21). Ce document ne décrit que
> ce qui a été implémenté, les écarts et les mesures. **Aucun déploiement** n'a été effectué. Déroulé : upgrade
> **direct sur Arbitrum One, sans Sepolia ni fork** (décision du propriétaire, 06/11/2026), masques livrés
> désactivés puis activés par marché — §10 de la spec et [Déploiement](#déploiement-arbitrum-one) ci-dessous.

## Ce qui est livré

| Zone | Fichier | Contenu |
|---|---|---|
| Bibliothèque neuve | `contracts/libraries/RouletteMaskBetLib.sol` | décodage/validation (bits ≥ 53, `2 ≤ \|S\| ≤ 24`, garde, `expectedPrev`), `minBet` par jambe, plafond de jambes, push `MaskBetEntry`, compteurs uint16 × 37, compteur prudent `roundMaskWeightedPayout`, setter par marché |
| Stockage | `contracts/libraries/RouletteEngineStorageLib.sol` | `MaskBetEntry` + 5 champs **en fin** de `Layout` (après `jackpotPreparation`) |
| Passif | `contracts/libraries/RouletteLiabilityMathLib.sol` | terme masque dans `Inputs`/`raw` (option (a)) ; `assertSolventAfterBet` (solvabilité + plafond bps) |
| Paiement | `contracts/libraries/RoulettePayoutSweepLib.sol` | comptage O(1) au callback VRF (`_accumulateCountShards`), `_sweepMasks` **en dernier** dans l'aperçu |
| Moteur | `contracts/RouletteEngine.sol` | `BET_MASK = 16`, appel unique à la bibliothèque par `recordBet`, `setMaskBetLimits` (`ENGINE_ROUND_ROLE`, événement `MaskBetLimitsUpdated`), `maskBetState`, lecture de `totalAssets()` (plus d'import `ISideBetVault`) |
| Vault | `contracts/BankVault4626.sol` | surface side bet supprimée, 14 champs inchangés (`_deprecatedSideBetController`), `releaseBets`/`payoutBatch`/`transferOut` en `onlyEngine`, `InitializeParams` inchangé, `availableForSideBet()` conservé en vue ; reprend `setFlatWithdrawFee` et les autres changements de l'implémentation en place `0x6e84…f3cC` ([reconstitution](../reports/vault-2026-11-05/README.md)) |
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
   (spec : ≈ 2,2 M). Le coût est un `SLOAD` froid par jambe (≈ 2,7 k gaz) : aucune optimisation simple de
   `_sweepMasks` ne le supprime (retirer le contrôle de bornes en assembleur ne gagnerait que ≈ 5–7 %, sur un
   chemin de paiement non audité) ; changer le stockage des masques pour les tasser n'est pas une modification
   simple. **Plafond de lancement retenu : 448 jambes** par (round, marché), voir ci-dessous. Plafond de gaz des
   `eth_call` CRE toujours à confirmer avant de relever la valeur.
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
| `eth_call` `UpkeepScheduler.checkUpkeep(lane)`, dernier bloc, **448 masques**, 1 lane / 60 paiements (config. Arbitrum One) | 1 366 504 |
| idem, 448 masques, 10 lanes / 10 paiements (défaut du moteur) | 1 380 331 |
| idem, 480 masques (1 lane / 10 lanes) | 1 452 360 / 1 486 443 |

Pente mesurée : ≈ 2,7 k gaz par jambe masque supplémentaire (1 lane). Les valeurs `checkUpkeep` sont le gaz interne
mesuré par `StaticCallGasProbe` ; l'`eth_call` ajoute ≈ 21–25 k d'intrinsèque. **448** est donc la plus grande valeur
« ronde » qui garde l'`eth_call` complet (≈ 1,40 M) sous ~1,5 M avec ≈ 7 % de marge ; elle est vérifiée par
`test/VrfCallbackBudget.test.ts` (plafond 1,45 M interne, jambe 449 rejetée) et appliquée par le script d'activation.

Tailles : `reports/mask-bets-v1/bytecode-sizes.json` (moteur 22 379 → 23 130, vault 15 435 (master ; 16 072 pour `0x6e84` en place) → 15 038,
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

Pas de test fork mainnet (décision du 06/11/2026) : il est remplacé par `test/MaskBetsMainnetUpgradeScript.test.ts`,
qui exécute les deux scripts de déploiement sur le réseau Hardhat local (31337, jamais un fork) contre une réplique
de la forme mainnet (moteur en place, dix bibliothèques existantes, vault précédent derrière un beacon, SideBet
désactivé) : dry run sans transaction, exécution complète moteur puis beacon, post-vérifications, activation,
pari classique + masque réglés par le scheduler, désactivation d'urgence, refus en `Settling`, avec side bets
actifs, avec une implémentation de beacon inattendue, un mauvais signataire ou un jeu de bibliothèques imprévu.
`scripts/mask-bets-v1-mainnet.test.cjs` (job de preflight) couvre les gardes réseau/clé/CLI hors ligne.

`test/VrfCallbackBudget.test.ts` n'écrit plus aucun fichier suivi par git ; `VRF_BUDGET_REPORT_DIR=reports/local`
(ignoré) enregistre les mesures. `reports/mask-bets-v1/vrf-callback-budget.json` et
`deployments/vrf-callback-budget-2026-10-15.json` restent des archives.

## ABI à régénérer au lot suivant (non fait ici)

- `RouletteEngine` : `setMaskBetLimits`, `maskBetState`, événement `MaskBetLimitsUpdated`, erreurs
  `MaskBetsDisabled`, `MaskLegBelowMinBet`, `MaskLegCapExceeded`, `MaskLiabilityCapExceeded`,
  `PreviousOutcomeMismatch`, `InvalidMaskBetLimits`.
- `BankVault4626` : retrait de `lockSideBetStake`, `setSideBetController`, `sideBetController`, des événements
  `SideBetControllerUpdated`/`SideBetStakeLocked` et des erreurs `OnlySideBet`, `InsufficientSideBetLiquidity`,
  `UnauthorizedSettlementCaller` (le subgraph doit **garder** les événements side bet pour l'historique, §8.1).
- Nouvelles bibliothèques/erreurs : `RouletteMaskBetLib`, `RouletteLiabilityMathLib` (`MaskLiabilityCapExceeded`).
- Frontend : `lib/abi/generated.ts` (wagmi), `lib/abi/merged-errors.json` (`yarn update:frontend:abis`, erreurs
  seules, couvre désormais le moteur, le vault et les bibliothèques masque) ; mainnet : `deployments/arbitrum-one-abi.json`
  → `frontend/scripts/generate-mainnet-abi.mjs` ; **jamais** `lib/abi/side-bet.ts` (instantané Sepolia figé) ;
  subgraph : `abis/RouletteEngine.json`, `abis/BankVault4626.json`.

Les scripts de vérification et d'audit qui lisaient `sideBetController()` sur les vaults lisent désormais le champ
déprécié directement à son slot ERC-7201 (`readLegacySideBetController`, racine + 2) : ils fonctionnent avant et
après l'upgrade du beacon. `availableForSideBet()` reste servi par le nouveau vault.

## Déploiement Arbitrum One

Décision du propriétaire (06/11/2026) : **pas de Sepolia, pas de fork**, upgrade direct ; masques livrés désactivés.

```bash
# 1. Dry run (défaut, lecture seule ; RPC public sans clé, ou ARBITRUM_RPC_URL)
node scripts/mask-bets-v1-mainnet.cjs
node scripts/mask-bets-v1-mainnet.cjs --out /tmp/mask-bets-v1-plan.json   # calldata complète (multisig)

# 2. Upgrade réel (moteur puis beacon), clé de l'administrateur fournie par l'opérateur
MASK_BETS_V1_MAINNET_CONFIRM=arbitrum-one:42161 MASK_BETS_V1_ADMIN_KEY=<clé> \
  node scripts/mask-bets-v1-mainnet.cjs --execute

# 3. Activation par marché, valeurs explicites (dry run, calldata multisig, exécution)
node scripts/mask-bets-v1-activate.cjs --market 1:448:1000 --market 2:448:1000 --market 3:448:1000 \
  --expected-engine-implementation <adresse du journal>
node scripts/mask-bets-v1-activate.cjs --market 1:448:1000 --print-calldata
MASK_BETS_V1_MAINNET_CONFIRM=arbitrum-one:42161 MASK_BETS_V1_ADMIN_KEY=<clé> \
  node scripts/mask-bets-v1-activate.cjs --market 1:448:1000 --execute
# Désactivation d'urgence d'un marché : --market <id>:0:0 --execute
```

Le contenu exact du preflight et des vérifications post-upgrade est décrit au §10 de la spec et en tête des
scripts. `reports/mask-bets-v1/mainnet-release-lock.json` fige les hachages des artefacts revus : le preflight
refuse toute compilation différente (`--write-lock` le régénère, à recommiter après revue). Chaque exécution
réelle écrit un journal horodaté `reports/mask-bets-v1/mainnet-execution-*.json` / `mainnet-activation-*.json`
(hachages de transactions, jamais de clé ni d'URL RPC).

### Dry run du 07/11/2026 : **passe**

`reports/mask-bets-v1/mainnet-dry-run-2026-11-07.json` (RPC public, bloc 522 055 874, aucune transaction) :
`PREFLIGHT PASSED`. Le manifeste désigne désormais `0x6e84…f3cC`, et son runtime archivé est contrôlé par
`loadMainnetDeployment` via `reports/vault-2026-11-05/match.json`. Le round 165 est `Open` ; les 14 tickets SideBet
sont clos ; réserves et verrous sont à 0 ; rôles et layouts sont conformes. Côté bibliothèques, 7 sont réutilisées
et 4 déployées. Le plan compte 8 transactions, aux nonces 313 à 320 de l'admin.

Le preflight relève le `flatWithdrawFee` de chaque vault : 100 BRB, 1 USDC, 1 DAI. Après l'upgrade, il vérifie
que ces valeurs sont identiques avant et après le bloc d'upgrade du beacon. Il vérifie aussi que le nouveau runtime
dispatche toujours `setFlatWithdrawFee` et `drainWithdrawalQueue`, comme le build compilé.

### Dry run du 06/11/2026 : **bloqué** (historique)

`reports/mask-bets-v1/mainnet-dry-run-2026-11-06.json` (RPC public, aucune transaction). Le preflight s'arrête :
l'implémentation du beacon des vaults sur Arbitrum One est `0x6e84c0ED4056bA6E94dFF5008aBE811738f8f3cC`, pas
`0x129cAf68…797D` du manifeste. Elle a été déployée par l'administrateur (nonce 304) et installée le
05/11/2026 13:04 UTC (transaction `0xb63c808c…dbe0`, bloc 521 482 387) ; ni son source ni son layout ne sont dans le
dépôt. Elle sert encore la surface side bet. L'administrateur a ensuite envoyé 7 autres transactions (nonces
306–312, non identifiées ici). Avant toute exécution : récupérer le source de `0x6e84…f3cC`, valider son layout,
reporter dans `BankVault4626` ce qu'il change, puis mettre à jour `deployments/arbitrum-one.json` et le verrou de
release. Le script ne propose aucun contournement.

> **Correction (07/11/2026) — faux positif.** Ce rapport affirmait que `0x6e84…f3cC` « ne dispatche plus
> `drainWithdrawalQueue` ». C'est faux : la fonction est toujours présente et publique (`eth_call
> drainWithdrawalQueue(1)` réussit sur le vault BRB). Son sélecteur `0x00e4a032` commence par un octet nul ; solc
> le compare donc avec `PUSH3 e4a032`, alors que le contrôle cherchait `63` + sélecteur (un `PUSH4` littéral) dans
> l'hexadécimal. `dispatchesSelector` lit désormais le dispatcher désassemblé (`dispatcherSelectors`, données de
> `PUSH` sautées, `DUP1 PUSHn s EQ PUSH2 t JUMPI` avec n ≤ 4). C'est testé sur le runtime archivé de `0x6e84`, dont
> le dispatcher doit égaler exactement l'ABI du source reconstitué. L'implémentation en place ne retire **aucune**
> fonction : elle ajoute `setFlatWithdrawFee` et modifie cinq comportements (`reports/vault-2026-11-05/README.md`).

À titre informatif seulement, le même preflight avec l'implémentation en place substituée passe tous les autres
contrôles (bloc 521 742 299 : round 165 `Open`, 14 tickets SideBet tous clos, réserves et verrous à 0, rôles et
propriétaire conformes, layouts compatibles) et confirme le jeu de bibliothèques : réutilisation de 7
(`RouletteLib`, `RouletteBetLib`, `JackpotBatchLib`, `RoulettePayoutMulLib`, `RouletteExposureLib`,
`RouletteJackpotCollectLib`, `RouletteBetCodecLib`), redéploiement de `RoulettePayoutSweepLib`,
`RouletteLiabilityMathLib`, `RouletteUpkeepScanLib` (relink) et `RouletteMaskBetLib`, soit 8 transactions
(6 déploiements, puis moteur, puis beacon).
