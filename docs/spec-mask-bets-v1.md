# Spécification technique — paris par masque (v1)

> Statut : **proposition à valider** (spécification, aucune implémentation dans ce document).
> Base de code analysée : `master` @ `be356ce`. Les références `fichier:ligne` pointent vers cette révision.
> Périmètre : `contracts/` (moteur, bibliothèques liées, vault), avec chiffrage d'impact sur `subgraph/` et `frontend/` (lecture seule).

## 0. Résumé

Les side bets multi-tours (`contracts/SideBet.sol`) sont retirés définitivement. Ils sont remplacés par **un seul nouveau type de pari roulette, `BET_MASK = 16`**, qui couvre un ensemble arbitraire `S ⊂ {0..36}` encodé en bitmask de 37 bits, avec `2 ≤ |S| ≤ 24`. Un pari masque :

- passe par **exactement** le chemin des paris roulette : `BankVault4626.placeBet` → `RouletteEngine.recordBet` → règlement dans le cycle du round courant ;
- ne bloque **que le stake** dans `lockedBetLiquidity` (jamais de réserve de paiement) : `totalAssets()` est inchangé après le pari, l'invariant violé le 04/11/2026 ne peut plus l'être ;
- paie `floor(stake × 36 / |S|)` (stake inclus), soit un avantage maison constant de 1/37 (≥ 1/37 après arrondi) ;
- n'est **pas** éligible au jackpot (réservé aux pleins, inchangé) ;
- transporte un `presetId` purement informatif dans les bits hauts du champ `number` déjà émis par `BetRecorded`/`BetPlaced`.

### Tableau des décisions

| # | Sujet | Décision | Statut |
|---|---|---|---|
| D1 | Type de pari | Un seul type `BET_MASK = 16`, sémantique ignorée on-chain | Pris (propriétaire) |
| D2 | Gain | `floor(amount × 36 / \|S\|)`, division entière unique, stake inclus | Pris ; représentation tranchée ici (§2.2) |
| D3 | Taille | `2 ≤ \|S\| ≤ 24`, bits ≥ 37 du masque ⇒ revert | Pris (propriétaire) |
| D4 | Masques libres | Tout masque valide accepté ; catalogue côté frontend | Pris (propriétaire) |
| D5 | Jackpot | Inchangé, pleins uniquement | Pris (propriétaire) |
| D6 | `presetId` | `uint16`, informatif, jamais lu pour un calcul | Pris (propriétaire) ; emplacement tranché ici (§1.3) |
| D7 | Encodage | `numbers[i] = mask \| (presetId << 37)`, valeur < 2^53 ; ABI `betData` inchangée | **Recommandé** |
| D8 | Stockage des paris | Tableau dédié `roundMaskBets[r][m]` + compteurs de gagnants par numéro (uint16 × 37, 3 slots) | **Recommandé** |
| D9 | Passif | Option (a) : compteur prudent `roundMaskWeightedPayout` (somme des gains) ajouté au passif existant | **Recommandé v1** ; (b) vecteur exact en v2 si besoin |
| D10 | Plafonds | Mise minimale **par jambe** masque ≥ `minBet` ; plafond de jambes masque par (round, marché) ; plafond de passif masque en bps de la liquidité libre | **Recommandé** (valeurs = question ouverte) |
| D11 | Code nouveau | Nouvelle bibliothèque liée `RouletteMaskBetLib` ; extensions de `RoulettePayoutSweepLib` et `RouletteLiabilityMathLib` | **Recommandé** |
| D12 | Vault | Upgrade beacon : suppression de `lockSideBetStake`, `setSideBetController`, des modificateurs side bet ; champ `sideBetController` conservé (déprécié) pour le layout | **Recommandé** |
| D13 | Ordre d'upgrade | Subgraph → frontend tolérant → moteur (masques désactivés) → vault → activation Sepolia → audit → mainnet | **Recommandé** |

---

## 1. Encodage

### 1.1 Existant

- Le joueur appelle `placeBet(amount, betData, referral)` (`contracts/BankVault4626.sol:243-245`). `_placeBetCore` vérifie `amount >= minBet` **sur le total**, incrémente `lockedBetLiquidity` du seul `amount`, appelle le moteur, émet `BetPlaced`, puis tire les jetons (`contracts/BankVault4626.sol:263-270`).
- `betData = abi.encode(uint256[] betTypes, uint256[] numbers, uint256[] amounts)`, décodé dans `_recordMultiBetPayload` (`contracts/RouletteEngine.sol:407-426`) ; la somme des jambes doit égaler `amount` (`contracts/RouletteEngine.sol:375-376`).
- Chaque jambe : `amount != 0`, `1 ≤ betType ≤ 15` (`contracts/RouletteEngine.sol:437-438`), validation du numéro par `RouletteBetCodecLib.validateBetNumber` (`contracts/libraries/RouletteBetCodecLib.sol:25-51`), puis stockage en `BetEntry{player, uint128 amount, uint8 betType, uint16 number}` (`contracts/libraries/RouletteEngineStorageLib.sol:11-16`, construit en `contracts/RouletteEngine.sol:440-441`) et routage vers un bucket numéroté ou plat (`contracts/RouletteEngine.sol:446-461`, `contracts/libraries/RouletteBetCodecLib.sol:53-57`).
- Les 15 identifiants existants sont dupliqués en constantes privées dans `RouletteEngine.sol:36-50`, `RouletteBetCodecLib.sol:9-23`, `RoulettePayoutMulLib.sol:6-20`, `RouletteExposureLib.sol:10-24`.
- `BetRecorded(marketId, localRound, player, totalAmount, bytes betData)` (`contracts/RouletteEngine.sol:166-173`) et `BetPlaced(user, amount, bytes data, roundId)` (`contracts/BankVault4626.sol:141`) réémettent `betData` tel quel.

Conséquence : **le champ `number` est un `uint256` dans le payload mais un `uint16` en stockage** (troncature silencieuse `uint16(numberRaw)` en `contracts/RouletteEngine.sol:441`). Un masque de 37 bits ne peut donc pas être stocké dans `BetEntry` ; il ne doit **jamais** passer par `_recordBetEntry`.

### 1.2 Consommateurs existants face à un type inconnu (16)

| Consommateur | Comportement sur `betType = 16` / grand `number` | Casse ? |
|---|---|---|
| Moteur actuel | `InvalidBetType` (`RouletteEngine.sol:438`) | Rejet propre (c'est ce qu'on modifie) |
| Mirror frontend `app/api/mirror/route.ts:161-191` | Décode l'ABI inchangée, `Number(value)` sur types/numéros (l. 184-186) | Non, **si `number < 2^53`** (sinon perte de précision silencieuse) |
| `frontend/lib/betting-heatmap.ts` (`expandBetToNumbers`, `default: []`) | Ignore la jambe | Non (stat incomplète) |
| `frontend/lib/telegram-log-formatters.ts:119-120` | Affiche `Type 16` | Non |
| `frontend/lib/betting/roulette-ticket.ts:20` | `BigInt(PAYOUTS[16])` ⇒ `BigInt(undefined)` lève `TypeError` | **Oui** — uniquement pour les brouillons du joueur ; à adapter avant d'exposer l'UI |
| `frontend/lib/bet-types.ts:71-87` (`PAYOUTS` entier) | Pas de multiplicateur entier possible pour un masque | À refondre (fonction de gain par pari) |
| Subgraph `src/helpers/betting.ts:16-52` | `default` ⇒ log + **`STRAIGHT`** (l. 49-51) | **Oui (silencieux)** : un masque serait historisé comme un plein |
| Subgraph `src/helpers/betting.ts:77-79` | `number.toI32()` sur un masque > 2^31 | Probablement troncature silencieuse (graph-ts) — **à confirmer par un test Matchstick** ; la valeur n'est utilisée que dans des branches non atteintes pour le type 16 |
| Subgraph `updateRoundMaxPayoutComponents` (`betting.ts:77-131`) | Aucune branche ⇒ passif miroir sous-estimé | Oui (miroir analytique faux) |

⇒ Le subgraph **et** le frontend doivent être déployés en version « tolérante » (type 16 reconnu) **avant** l'activation des masques (§10).

### 1.3 Encodage proposé (D7)

Aucune modification de l'ABI de `betData`, `BetRecorded` ou `BetPlaced`. Pour une jambe masque :

```
betTypes[i] = 16                     // BET_MASK
numbers[i]  = mask | (presetId << 37)
              bits  0..36 : mask (bit n = 1 ⇔ le numéro n est couvert)
              bits 37..52 : presetId (uint16, informatif)
              bits ≥ 53   : doivent être nuls, sinon revert InvalidBetNumber
amounts[i]  = stake de la jambe
```

Justification :
- 37 + 16 = 53 bits ⇒ toute valeur valide est `< 2^53` : le `Number(value)` du mirror (`route.ts:186`) reste **exact**, sans modifier le mirror pour la phase de transition.
- Le `presetId` est émis « gratuitement » dans `BetRecorded`/`BetPlaced` (déjà indexés par le subgraph et relayés par Ably), sans nouvel événement ni octet de bytecode d'émission.
- Le moteur extrait `mask = numberRaw & (2^37 − 1)` et ignore `presetId` ; un `presetId` non nul est accepté tel quel (valeur libre, non validée).
- **Piège frontend** : les opérateurs binaires JS (`&`, `>>`, `<<`) travaillent sur 32 bits. Le décodage doit utiliser `BigInt` (`n & ((1n << 37n) − 1n)`, `n >> 37n`) — jamais `number & mask`.

Règles de validation on-chain d'une jambe masque (dans `RouletteMaskBetLib`, §5) :

1. `numberRaw >> 53 == 0`, sinon `InvalidBetNumber` ;
2. `size = popcount(mask)`, `2 ≤ size ≤ 24`, sinon `InvalidBetNumber` (un masque vide, d'un seul numéro ou de ≥ 25 numéros est rejeté) ;
3. `amount ≥ minBet` du vault (**par jambe**, voir §4) ;
4. plafond de jambes et plafond de passif (§4).

### 1.4 Stockage (D8)

Nouveau struct (n'altère pas `BetEntry`, dont le stride est figé par les tableaux existants) :

```solidity
struct MaskBetEntry {      // 2 slots
    address player;        // slot 0 : 20 octets
    uint40  mask;          //          5 octets
    uint8   size;          //          1 octet (|S|, évite un popcount au règlement)
    uint128 amount;        // slot 1
}
```

Champs ajoutés **en fin** de `RouletteEngineStorageLib.Layout`, après `jackpotPreparation` (`contracts/libraries/RouletteEngineStorageLib.sol:144-145`, commentaire « Append-only ») :

```solidity
mapping(uint64 => mapping(uint32 => MaskBetEntry[])) roundMaskBets;
/// 37 compteurs uint16 (gagnants potentiels par numéro), 16 par slot ⇒ 3 slots
mapping(uint64 => mapping(uint32 => uint256[3])) roundMaskWinCounts;
/// Option (a) : somme des gains masque du (round, marché)
mapping(uint64 => mapping(uint32 => uint256)) roundMaskWeightedPayout;
uint32 maxMaskLegsPerMarketRound;   // 0 ⇒ masques désactivés (interrupteur)
uint16 maxMaskLiabilityBps;         // plafond de passif masque (§4)
```

`roundMaskWinCounts` est la clé de la compatibilité avec le callback VRF (§2.3) : le nombre de gagnants masque pour le numéro tiré se lit en O(1).

---

## 2. Paiement

### 2.1 Existant

- **Sélection des gagnants par bucket** : au callback VRF, `fulfill` calcule le numéro gagnant (`contracts/libraries/RoulettePayoutSweepLib.sol:13-36`) puis `snapshotRoundMarketWinningCounts` / `snapshotMarketWinningShardCounts` (`RoulettePayoutSweepLib.sol:51-223`) comptent, **sans parcourir les paris**, les gagnants de chaque bucket indexé par la clé gagnante (`RouletteBetLib.getWinningBetTypes`, `contracts/libraries/RouletteBetLib.sol:22-41`) et les répartissent par lane en forme close (`_accumulateBucketShards`, `RoulettePayoutSweepLib.sol:227-255`).
- **Aperçu hors chaîne** : `previewWinningPayoutsSlice` (`RoulettePayoutSweepLib.sol:257-299`) parcourt les buckets gagnants dans un ordre fixe (plein, chevaux, transversale, carrés, sixains, colonne, douzaine, chances simples ; l. 279-286), attribue un index global `gi` à chaque pari gagnant et sélectionne ceux de la lane (`_consumeBucket`, `RoulettePayoutSweepLib.sol:452-489`). Le montant vient de `RoulettePayoutMulLib.payoutForAmount` (`contracts/libraries/RoulettePayoutMulLib.sol:22-32`).
- **Exécution on-chain** : les lignes de paiement arrivent par le rapport CRE et **ne sont pas recalculées** (`contracts/RouletteEngine.sol:742-747`) ; elles sont seulement bornées globalement par `assertPayoutWithinLiability` (`contracts/libraries/RouletteLiabilityMathLib.sol:11-28`, appelé en `RouletteEngine.sol:674`) puis payées par `payoutBatch` (`contracts/libraries/JackpotBatchLib.sol:43-49`).

### 2.2 Formule de gain (D2)

```
payout = (uint256(amount) * 36) / size        // une seule division entière, arrondi vers le bas
```

- **Représentation** : numérateur constant `36`, dénominateur `size = |S|` stocké dans l'entrée. Pas de bps : un multiplicateur précalculé `floor(360000/|S|)` puis `amount × m / 10000` arrondirait **deux fois** (perte supplémentaire pour le joueur, résultat différent de la formule annoncée).
- **Sens d'arrondi** : `floor` ⇒ `payout ≤ amount × 36/|S|` pour tout `amount`. Retour espéré = `|S|/37 × floor(36·a/|S|)/a ≤ 36/37`. Jamais favorable au joueur.
- **Exactitude** : pour `|S| ∈ {2, 3, 4, 6, 9, 12, 18}` (diviseurs de 36) le gain est exact. Sinon la perte d'arrondi est `< 1 unité minimale` par pari (ex. 1 USDC sur 11 numéros : 3 272 727 au lieu de 3 272 727,27 ; reste 3 unités de base sur 36 000 000).
- **Débordement** : `amount ≤ 2^128 − 1` (type stocké) ⇒ `amount × 36 < 2^134`, aucun risque en `uint256`. Les compteurs agrégés restent en arithmétique vérifiée (pas d'`unchecked`).
- Cohérence avec l'existant : `|S| = 2` ⇒ 18x (= cheval), `|S| = 3` ⇒ 12x (= transversale/trio), `|S| = 12` ⇒ 3x (= douzaine), `|S| = 18` ⇒ 2x (= chance simple).

Table des multiplicateurs (vérifiée par script, cf. annexe A) : 2→18 ; 3→12 ; 4→9 ; 5→7,2 ; 6→6 ; 7→5,1429 ; 8→4,5 ; 9→4 ; 10→3,6 ; 11→3,2727 ; 12→3 ; 13→2,7692 ; 14→2,5714 ; 15→2,4 ; 16→2,25 ; 17→2,1176 ; 18→2 ; 19→1,8947 ; 20→1,8 ; 21→1,7143 ; 22→1,6364 ; 23→1,5652 ; 24→1,5.

### 2.3 Intégration au cycle de paiement

**Au pari** (`RouletteMaskBetLib.record`) : push dans `roundMaskBets[r][m]`, puis pour chaque bit `n` du masque, `+1` au compteur uint16 `n` de `roundMaskWinCounts[r][m]` (3 slots au plus).

**Au callback VRF** (`snapshotMarketWinningShardCounts`) : après les chances simples, ajouter un bloc

```
count = (roundMaskWinCounts[r][m][wn / 16] >> (16 * (wn % 16))) & 0xFFFF
gPos  = _accumulateCountShards(count, gPos, shards, laneCount)   // même forme close que _accumulateBucketShards
```

Coût ajouté : 1 SLOAD + quelques opérations par marché participant ⇒ **O(1)**, indépendant du nombre de masques. Le budget mesuré du callback (1 037 644 gaz pour 3 marchés, quel que soit le nombre de jambes gagnantes, `deployments/vrf-callback-budget-2026-10-15.json`, limite 2 500 000) n'est pas menacé.

**À l'aperçu** (`previewWinningPayoutsSlice`) : ajouter `_sweepMasks` **en dernier** (après `_sweepFlats`, l. 286), afin de ne pas décaler les index globaux des buckets existants. Variante de `_consumeBucket` : lire le slot 0 de chaque entrée (player + mask + size), **tester le bit** `(mask >> wn) & 1` ; une entrée perdante est sautée **sans incrémenter `gi`** ; une gagnante suit exactement la logique de lane/curseur de `_consumeBucket` et produit `Payout(player, amount × 36 / size)`.

Invariant à tester : `Σ_lanes winningBetCountByShard` incluant les masques = nombre d'entrées de `roundMaskBets` dont le bit gagnant est à 1 (les compteurs et le parcours doivent concorder, sinon une lane ne se termine jamais ou un gagnant est sauté).

**Coût d'un test de bit** : `SHR` + `AND` ≈ 6 gaz ; le coût réel est la lecture du slot (2 100 gaz à froid) **dans un `eth_call` hors chaîne** (aperçu CRE), pas dans une transaction. Chaque aperçu de lane parcourt tout `roundMaskBets[r][m]` : avec le plafond recommandé de 1 024 jambes, ≈ 2,2 M de gaz de lecture par appel d'aperçu, en plus de l'existant. **À vérifier** : le plafond de gaz des `eth_call` utilisés par le workflow CRE (non documenté dans le dépôt).

**Exécution / batching** : un masque gagnant est une ligne de paiement comme une autre ; `maxPayoutsPerCall`, les lanes, `PayoutProgress`, `StalePayoutChunk` (`RouletteEngine.sol:662-685`) sont inchangés. Aucun recalcul on-chain par pari (cohérent avec `RouletteEngine.sol:742-747`). Les frais (`MarketFeeLib.collect`, `contracts/libraries/MarketFeeLib.sol:21-38`) s'appliquent sans changement : le stake est dans `mr.totals.totalAmount`, le gain dans `bankPaidRunning`.

**Jackpot** : la collecte d'éligibles ne lit que le bucket `NumberedBetBucket.Straight` (`contracts/libraries/RouletteJackpotCollectLib.sol:177-195` et `:196-215`). Les masques vivant dans un tableau séparé, ils sont **exclus par construction**, sans code supplémentaire. Un test doit le verrouiller.

---

## 3. Solvabilité et passif

### 3.1 Existant

- Passif d'un (round, marché) = `bufferedMarketMaxLiability` (`contracts/libraries/RouletteLiabilityMathLib.sol:48-59`) : **somme de maxima par catégorie** (`maxStraight×36 + maxStreet×12 + max(rouge,noir)×2 + … + otherBetsWeightedPayout`), majorée de 10 % (`SAFETY_BUFFER_BPS = 11000`, `contracts/RouletteLib.sol:7, 28-32`). C'est déjà une borne supérieure prudente (plusieurs catégories supposées gagnantes simultanément).
- Les accumulateurs sont tenus par `RouletteExposureLib.accumulate` (`contracts/libraries/RouletteExposureLib.sol:26-99`) ; chevaux, carrés, sixains et trios sont simplement **additionnés** dans `roundOtherBetsWeightedPayout` (l. 51-62, 95-97).
- Contrôle au pari (`contracts/RouletteEngine.sol:380-389`) : `totalAssets() + stakes du round + amount ≥ passif bufferisé`, sinon `InsufficientBankForMaxPayout`. Lecture via `ISideBetVault.availableForSideBet()`, qui vaut `totalAssets()` (`contracts/BankVault4626.sol:104-106`).
- `marketRouletteLiquidityNeed` = passif − stakes (`contracts/RouletteEngine.sol:248-256`) bloque `drainWithdrawalQueue` tant que le round ouvert doit quelque chose (`contracts/BankVault4626.sol:353-360`).

### 3.2 Options

**(a) Compteur prudent.** Nouveau compteur `roundMaskWeightedPayout[r][m] += amount × 36 / size`, ajouté comme un terme de plus dans `Inputs`/`raw` (`RouletteLiabilityMathLib.sol:30-46, 50-56`). Hypothèse : *tous les masques gagnent en même temps*.

**(b) Vecteur exact par numéro.** 37 accumulateurs `L[n] = Σ_{masques ∋ n} payout` ; terme ajouté au passif = `max_n L[n]`, tenu incrémentalement (les `L[n]` ne font que croître, donc le max se met à jour en ne comparant que les numéros touchés). Packing recommandé si retenu : `uint16 count | uint112 liability` par numéro, 2 par slot ⇒ 19 slots (fusionne les compteurs de gagnants du §2.3).

Dans les deux cas, la borne reste correcte : pour tout numéro `n`, `paiement(n) = classique(n) + masques(n) ≤ borneClassique + termeMasque`, car `classique(n) ≤ borneClassique` (propriété existante) et `masques(n) ≤ max_n L[n] ≤ Σ masques`.

### 3.3 Chiffrage gaz

Mesures locales (Hardhat, `be356ce`, marché 6 décimales, mise = `minBet`, script jetable non commité calqué sur `test/MultiBetCost.test.ts`) :

| Transaction | Gaz |
|---|---|
| 1er pari du round (1 plein, démarre le compte à rebours) | 428 732 |
| 1 cheval (1er cheval du round) | 273 528 |
| 1 cheval (suivant) | 256 428 |
| 1 plein, nouveau numéro | 272 496 |
| 10 chevaux en une transaction | 909 441 ⇒ **≈ 72 600 gaz par jambe marginale** |
| 1 rouge | 269 994 |

Estimations par **jambe masque marginale** (SSTORE à froid 0→non‑nul = 22 100 ; mise à jour d'un slot déjà non nul ≈ 5 000) :

| | (a) prudent | (b) vecteur exact |
|---|---|---|
| Entrée (2 slots) + longueur + compteur de passif | ≈ 72 600 (comme un cheval) | ≈ 72 600 − 5 000 |
| Compteurs de gagnants (3 slots max) | +5 000 à +66 300 | inclus ci-dessous |
| Vecteur de passif (⌈\|S\|/2⌉ à 19 slots) + slot max | — | +35 000 à +420 000 (1er masque du round) ; +35 000 à +100 000 ensuite |
| Popcount, bornes, lecture `minBet` (1 appel externe par tx) | ≈ +5 000 | ≈ +5 000 |
| **Total estimé** | **≈ 80 000 – 145 000** | **≈ 110 000 – 495 000** |

Calcul du passif au pari : inchangé en (a) (1 SLOAD de plus), +1 SLOAD en (b) (slot du max). Sur Arbitrum le gaz L2 est bon marché, mais (b) multiplie par 2 à 4 le coût d'une jambe masque et allonge `recordBet` de façon dépendante de `|S|`.

### 3.4 Chiffrage du capital immobilisé

Scénarios (mises de 100 unités, gains arrondis ; calculés par le script de l'annexe A) :

| Scénario | (a) Σ gains | (b) max par numéro | Ratio |
|---|---|---|---|
| 10 joueurs sur le même masque « premier » | 3 270 | 3 270 | 1,0 |
| « supérieur » + « inférieur » au précédent p = 18 | 400 | 200 | 2,0 |
| 4 masques couleur × parité (partition de 1–36) | 1 620 | 450 | 3,6 |
| 18 paires disjointes (pire cas théorique) | 32 400 | 1 800 | 18,0 |

Le sur-provisionnement de (a) est au plus égal au nombre de masques **disjoints** (≤ 18 car `|S| ≥ 2`) et nul quand les joueurs se concentrent sur les mêmes presets (cas attendu avec un catalogue). Il ne coûte rien tant que la contrainte de solvabilité ne mord pas : le passif n'est **pas** bloqué dans le vault (seuls les stakes le sont), il ne fait que rejeter des paris plus tôt.

### 3.5 Recommandation v1 : option (a)

1. Prudence post-incident : (a) est un compteur monotone de plus, de même nature que `roundOtherBetsWeightedPayout` déjà audité ; (b) introduit un vecteur packé, un max incrémental et des bornes `uint112`, soit une surface d'audit nettement plus grande.
2. Gaz : 2 à 4 fois moins cher par jambe, coût indépendant de `|S|` hors compteurs.
3. Bytecode : (a) ajoute un terme dans `RouletteLiabilityMathLib` ; (b) ajoute une boucle de mise à jour dans la bibliothèque masque.
4. Le miroir subgraph (`calculateMaxPayoutFromRoundComponents`, `subgraph/src/helpers/betting.ts:133-160`) s'étend trivialement.
5. Migration (a) → (b) possible plus tard par simple ajout de champs en fin de layout, round par round.

Critère de passage à (b) : télémétrie Sepolia/mainnet montrant des rejets `InsufficientBankForMaxPayout` ou du plafond masque (§4) attribuables au sur-provisionnement.

Compteur **séparé** de `roundOtherBetsWeightedPayout` (plutôt que réutilisé) : permet le plafond relatif à la NAV (§4), le diagnostic et un miroir subgraph distinct.

### 3.6 Invariant NAV (celui violé le 04/11/2026)

Écrivains de `lockedBetLiquidity` dans le vault actuel :

| Écrivain | Effet | Après upgrade |
|---|---|---|
| `_placeBetCore` (`BankVault4626.sol:266`) | `+amount`, et `amount` entre dans la balance dans la même transaction (l. 269) | Conservé (seul chemin des masques) |
| `lockSideBetStake` (`BankVault4626.sol:219-233`) | `+payoutReserve` alors que seul `stake` entre ⇒ **baisse de `totalAssets()`** | **Supprimé** |
| `releaseBets` (`BankVault4626.sol:272-277`) | `−amount` au règlement | Conservé, `onlyEngine` |

`totalAssets() = balance − lockedBetLiquidity` (`BankVault4626.sol:518-522`). Après l'upgrade, **la seule incrémentation de `lockedBetLiquidity` est compensée à l'identique par l'entrée de jetons dans la même transaction** : un pari masque, quel que soit son gain potentiel, laisse `totalAssets()` et donc le prix de la part strictement inchangés. Le passif masque n'existe que dans les compteurs du moteur ; il ne touche jamais la NAV. Il est donc impossible de reproduire l'attaque « réserves ⇒ NAV écrasée ⇒ dépôt qui mint ~100 % des parts ».

Points à vérifier explicitement (tests §9) :

- **Fenêtre intra-transaction** : entre `lockedBetLiquidity += amount` (l. 266) et `safeTransferFrom` (l. 269), `totalAssets()` est inférieur de `amount`. Seuls des appels de confiance s'y exécutent (moteur, `BRB_REFERRAL.mint`), et `_placeBetCore` est `nonReentrant`. Hypothèse documentée : actifs de marché sans hook de transfert (pas d'ERC-777). Toute nouvelle place de marché doit respecter cette hypothèse.
- **Dépôt pendant un round ouvert** : autorisé (`deposit`/`mint` ne bloquent qu'en `Settling`, `BankVault4626.sol:503-516`). Le dépôt se fait à la NAV hors paris en cours — comportement existant, identique pour les masques, sans prix écrasé.
- **`drainWithdrawalQueue`** : bloqué si `marketRouletteLiquidityNeed != 0` (`BankVault4626.sol:356`). Le terme masque étant inclus dans le passif, un round ouvert avec des masques bloque la trappe comme un round avec des pleins. La file normale n'est traitée qu'après paiement (`RouletteEngine.sol:701-706`).
- **Contrôle au seul moment du pari** : la liquidité libre ne peut que croître pendant `Open` (dépôts ; la file est bloquée ; `payoutBatch`/`transferOut` sont réservés au moteur après suppression du contrôleur side bet). Le contrôle unique de `RouletteEngine.sol:386-389` reste donc suffisant — ce qui n'était **pas** vrai avec `SideBet`, qui pouvait bloquer de la liquidité après coup.
- **Blast radius CRE** : la borne `assertPayoutWithinLiability` augmente de `1,1 × roundMaskWeightedPayout`. Le plafond relatif à la NAV (§4) borne aussi cette extension.

---

## 4. Plafonds anti-DoS et exposition

Existant : `minBet` vérifié **sur le total de la transaction** (`BankVault4626.sol:265`) ; jambes nulles rejetées (`RouletteEngine.sol:437`) ; **aucune** limite de nombre de paris par round (`BetStorageLib.addBet` compte des placements, `contracts/libraries/BetStorageLib.sol:10-13`) ; aucun plafond par pari hors solvabilité.

Recommandations :

| Plafond | Proposition | Justification |
|---|---|---|
| Mise minimale par jambe masque | `amount ≥ IBankVault(cfg.bank).minBet()` pour **chaque** jambe masque (lecture une fois par `recordBet`, seulement si une jambe masque est présente ; erreur dédiée `MaskLegBelowMinBet`) | Sans cela, un pari de `minBet` peut porter des centaines de jambes masque de 1 wei qui gonflent le parcours d'aperçu et consomment le plafond de jambes. L'éligibilité jackpot applique déjà `minBet` par jambe pour la même raison (`RouletteJackpotCollectLib.sol:205-216`). |
| Jambes masque par (round, marché) | `maxMaskLegsPerMarketRound`, défaut proposé **1 024**, réglable (rôle `ENGINE_ROUND_ROLE`, événement) ; `0` = masques désactivés | Borne le parcours hors chaîne de chaque aperçu de lane (§2.3) et garantit que les compteurs uint16 ne débordent pas (≤ 65 535). Coût de saturation pour un attaquant : 1 024 × `minBet` de mise, perte espérée 2,7 % ; il ne bloque que les masques d'un round, pas la roulette classique. |
| Passif masque relatif à la liquidité | `roundMaskWeightedPayout ≤ maxMaskLiabilityBps × (totalAssets() + stakes du round + amount) / 10 000`, vérifié après la boucle des jambes avec la même variable que `RouletteEngine.sol:386` ; erreur `MaskLiabilityCapExceeded` | Défense en profondeur pour une fonctionnalité neuve : réserve de la capacité aux paris classiques, borne l'extension de `assertPayoutWithinLiability`, permet un lancement progressif (bps bas sur Sepolia puis mainnet). |
| Plafond par pari | Non retenu | Implicite : un pari isolé est borné par le plafond agrégé et par la solvabilité. |
| Plafond par joueur | Non retenu en v1 | Contournable par sybil ; question produit si besoin. |

Valeurs par défaut = **question ouverte produit** (§Q5). Le plafond de jambes à `0` sert d'interrupteur d'urgence sans upgrade.

---

## 5. Taille du bytecode (EIP-170)

Mesuré sur `be356ce` (`yarn compile`, `hardhat.config.ts:24-25` : optimiseur `runs: 1`, `viaIR: false` ; `SideBet` seul en `viaIR`, `hardhat.config.ts:75`), tailles `deployedBytecode` des artefacts :

| Contrat / bibliothèque | Runtime (octets) | Marge sous 24 576 | Liens |
|---|---|---|---|
| `RouletteEngine` | 22 379 | **2 197** | 7 libs liées |
| `BankVault4626` | 15 435 | 9 141 | — |
| `SideBet` | 21 302 | 3 274 | — |
| `UpkeepScheduler` | 8 601 | 15 975 | — |
| `RoulettePayoutSweepLib` | 7 599 | 16 977 | `RouletteBetLib`, `RoulettePayoutMulLib` |
| `RouletteJackpotCollectLib` | 6 822 | 17 754 | — |
| `RouletteUpkeepScanLib` | 6 154 | 18 422 | `JackpotBatchLib`, `RouletteJackpotCollectLib`, `RoulettePayoutSweepLib` |
| `JackpotBatchLib` | 3 338 | 21 238 | — |
| `RouletteBetLib` | 2 948 | 21 628 | — |
| `RouletteLiabilityMathLib` | 2 317 | 22 259 | `RouletteLib` |
| `RouletteExposureLib` | 1 857 | 22 719 | — |
| `RouletteBetCodecLib` | 933 | 23 643 | `RouletteBetLib` |
| `RoulettePayoutMulLib` | 433 | 24 143 | — |
| `RouletteLib` | 315 | 24 261 | — |
| `MarketFeeLib` | 92 | 24 484 | — |

Le moteur n'a que ~2,2 Ko de marge : **le code neuf doit vivre dans des bibliothèques liées** (même patron que `RouletteExposureLib` : fonctions `external` recevant le pointeur de stockage).

| Emplacement | Contenu | Estimation |
|---|---|---|
| **Nouvelle** `RouletteMaskBetLib` | validation (bits ≥ 53, popcount, bornes 2/24, `minBet` par jambe), push `MaskBetEntry`, compteurs de gagnants, compteur de passif, plafond de jambes | ~1,5–2,5 Ko, bibliothèque neuve |
| `RouletteLiabilityMathLib` | terme masque dans `Inputs`/`raw` ; nouvelle `assertSolventAfterBet($, r, m, freeLiquidity)` regroupant le contrôle de `RouletteEngine.sol:386-389` et le plafond masque | +~150–300 o |
| `RoulettePayoutSweepLib` | bloc de comptage au snapshot, `_sweepMasks`/`_consumeMaskBucket` | +~600–900 o |
| `RouletteEngine` | branche `if (betTypeRaw == BET_MASK)` avant `RouletteEngine.sol:438`, appel à `assertSolventAfterBet`, setter `setMaskBetLimits` + événement, getters ; remplacement de `ISideBetVault.availableForSideBet()` par `IERC4626.totalAssets()` | +~400–800 o, compensé en partie par le déplacement du contrôle de solvabilité ⇒ marge résiduelle attendue ≥ 1,2 Ko |
| `RouletteUpkeepScanLib` | aucun changement de source, **redéploiement** (adresse de `RoulettePayoutSweepLib` liée) | 0 |
| `BankVault4626` | suppression de la surface side bet | −~0,5–1 Ko |

La taille réelle doit être mesurée au premier commit d'implémentation (comme `reports/incident-2026-11-04/bytecode-sizes.json`), sans contournement de limite (`allowUnlimitedContractSize` interdit pour les artefacts de déploiement).

---

## 6. Upgrade et stockage

### 6.1 Moteur (UUPS, `RouletteEngine.sol:245`, `DEFAULT_ADMIN_ROLE`)

- Champs ajoutés **uniquement en fin** de `Layout` (§1.4). Aucun champ ni struct mappé existant modifié ; `BetEntry` intact. Vérification par `test/EngineStorageLayout.test.ts` et `docs/storage/RouletteEngineStorage.v1.json` (à prolonger en v2), plus `scripts/auditStorageLayouts.py` / `scripts/checkPrStorage.py`.
- Nouvelles bibliothèques à déployer : `RouletteMaskBetLib`, `RoulettePayoutSweepLib` v2, `RouletteLiabilityMathLib` v2, `RouletteUpkeepScanLib` (relink) ; nouvelle implémentation du moteur liée à ces adresses.
- Fenêtre d'upgrade : phase `Open` ou `Completed`, **jamais `Settling`** (le snapshot de lanes et le parcours d'aperçu doivent provenir de la même implémentation ; même raison que `RouletteEngine.sol:282-288`). `_sweepMasks` étant placé en dernier et aucun masque n'existant avant activation, l'ordre des index d'un round en cours n'est de toute façon pas modifié.
- Livré avec `maxMaskLegsPerMarketRound = 0` (masques désactivés) ; activation par setter, sans nouvel upgrade.
- Le moteur cesse d'importer `ISideBetVault` (`RouletteEngine.sol:13`) et lit `totalAssets()` — valeur identique sur l'ancien vault (`BankVault4626.sol:104-106`), ce qui permet d'upgrader le moteur **avant** le vault.

### 6.2 Vault (beacon `0x7b23ccddb62b982245c50bdaaf1d13b3d12d632b`, mainnet)

Layout ERC-7201 `biribi.storage.BankVault4626` : 14 champs (`BankVault4626.sol:61-76`), **conservés à l'identique** :

- `sideBetController` (4e champ, `address`) est **renommé** `_deprecatedSideBetController`, même type, même position, jamais lu. Pas de remise à zéro (éviterait une transaction par proxy, sans gain de sécurité puisque plus aucun code ne le lit).
- Supprimés : `ISideBetVault` de l'héritage, `sideBetController()`, `availableForSideBet()`, `setSideBetController`, `lockSideBetStake`, modificateurs `onlySideBet` / `onlyEngineOrSideBet` (`BankVault4626.sol:172-184, 211-233`), erreurs `OnlySideBet` / `InsufficientSideBetLiquidity`, événements `SideBetControllerUpdated` / `SideBetStakeLocked`, interface résiduelle `November2026TicketRecovery` (`BankVault4626.sol:19-21` ; la nouvelle implémentation a de toute façon de nouvelles métadonnées).
- `releaseBets`, `payoutBatch`, `transferOut` passent en **`onlyEngine`** (`BankVault4626.sol:272-298`) : plus aucune adresse tierce ne peut déplacer des fonds du vault.
- `InitializeParams` **garde** son champ `sideBetController` (ignoré) : `MarketRegistry` est non upgradeable et encode ce struct avec `SIDE_BET` immuable (`contracts/MarketRegistry.sol:99-113`, `:20, :90`). Changer le struct changerait le sélecteur d'`initialize` et casserait `createMarket`.
- Vérification du layout : même procédure que l'incident (`reports/incident-2026-11-04/storage-validation.json`), limites runtime 24 576 / initcode 49 152 sans contournement.

Préconditions bloquantes (preflight scripté) avant `UpgradeableBeacon.upgradeTo` :

1. `SideBet.sideBetsDisabled() == true` ;
2. aucun ticket SideBet ouvert, et pour chaque vault `lockedBetLiquidity == stakes du round roulette courant non libérés` (aucune réserve side bet résiduelle ; l'incident documente des réserves à zéro) ;
3. aucun round en `Settling`.

### 6.3 SideBet et scheduler

- `SideBet` reste déployé, désactivé, sans droit sur le vault après l'upgrade. Pas d'upgrade supplémentaire nécessaire.
- `UpkeepScheduler` appelle encore `SIDE_BET.previewSettleBundleV2` (`contracts/UpkeepScheduler.sol:142-146`) ; désactivé, SideBet n'offre aucun travail. Un redéploiement du scheduler sans voies side bet est possible via `setUpkeepScheduler` (`RouletteEngine.sol:326-332`) mais hors périmètre v1 (§Q7).

---

## 7. Fiabilité du « tirage précédent »

Cycle on-chain :

1. Premier pari ⇒ `RoundCountdownStarted(roundId, marketId, lockAt)` (`RouletteEngine.sol:368-373`).
2. `lockAt` atteint ⇒ job `TriggerVrf` ⇒ phase `Settling` + `VrfRequested` (`RouletteEngine.sol:566-602`) ; les paris sont refusés dès `lockAt` (`RouletteEngine.sol:547-549`).
3. Callback ⇒ `VRFResult(roundId, winningNumber, jackpotNumber)` et `winningNumber` stocké (`RoulettePayoutSweepLib.sol:13-36`).
4. Les jobs de paiement n'existent que si `vrfFulfilled` (`contracts/libraries/RouletteUpkeepScanLib.sol:87-90`) ; quand tous les marchés sont réglés ⇒ `RoundResolved` puis **seulement alors** `_openNextRound` (`RouletteEngine.sol:711-716, 558-564`).

Donc, **dès qu'un pari est accepté dans le round `r`, le round `r−1` est résolu et son numéro est lisible** via `roundOutcome(r−1)` (`RouletteEngine.sol:512-515`). Seule exception : `r = 1` (pas de précédent). Il n'y a jamais deux rounds non payés.

Le masque étant explicite, il n'y a aucune ambiguïté on-chain : l'avantage maison est 1/37 quel que soit le masque, aucun preset ne donne d'information exploitable.

Règles UI (frontend) :

- Presets « liés au précédent » **grisés** tant que le numéro de `r−1` n'est pas connu côté client (événement Ably `VRFResult`, repli RPC `roundOutcome(currentRound − 1)` au bootstrap) et pour `r = 1`.
- **Grisés aussi** quand le `|S|` calculé sort de `[2, 24]` (« supérieur » actif pour `p ∈ [12, 34]`, « inférieur » pour `p ∈ [2, 24]`, couleur/douzaine désactivées si `p = 0`) — voir annexe.
- **Risque UX** : une transaction construite pour `r` peut être minée dans `r+1` si `r` se ferme entre-temps ; le masque, calculé sur `r−1`, est alors joué « hors contexte ». Atténuations v1 : désactiver ces presets à l'approche de `lockAt` (marge à définir) et dès `VrfRequested` ; afficher dans l'historique « masque calculé sur le tirage du round X » (le `roundId` réel est dans `BetPlaced`, `BankVault4626.sol:268`). Une garde on-chain est une question ouverte (§Q6).

---

## 8. Impact subgraph et frontend (liste de fichiers, pas d'implémentation)

### 8.1 Subgraph (`/home/user/subgraph`)

| Fichier | Changement |
|---|---|
| `schema.graphql:9-25` | `enum BetType` : ajouter `MASK` (et idéalement `UNKNOWN`) |
| `src/helpers/constant.ts:27, :51` | `BET_MASK = 16`, `BET_TYPE_MASK = "MASK"` |
| `src/helpers/betting.ts:16-52` | branche MASK ; **ne plus mapper un type inconnu sur `STRAIGHT`** (l. 49-51) |
| `src/helpers/betting.ts:77-131` | branche masque dans `updateRoundMaxPayoutComponents` : décoder `mask`/`presetId` en `BigInt` (`bitAnd`/`rightShift`), `size = popcount`, `maskBetsPayout += amount × 36 / size` ; ne calculer `number.toI32()` que dans les branches qui en ont besoin |
| `src/helpers/betting.ts:133-160` | inclure `maskBetsPayout` dans `calculateMaxPayoutFromRoundComponents` (parité avec le moteur) |
| `schema.graphql` (`RouletteRound`) | champ `maskBetsPayout: BigInt!` ; optionnel : entité de statistiques par `presetId` (volume, gains, nb de paris) |
| `src/helpers/multiMarketRoulette.ts:183-190` | point d'appel de `updateRoundMaxPayoutComponents`, inchangé hors nouvelle branche |
| `abis/BankVault4626.json`, `subgraph.yaml:664` | **conserver** les événements side bet de l'ABI du template pour l'historique ; la nouvelle implémentation ne les émet plus |
| `subgraph.yaml:423-474` (data source `SideBet`) | conservée pour l'historique (aucun nouvel événement) |
| `tests/betPlaced.test.ts`, `tests/multileg-bet.test.ts`, `tests/roulette.test.ts` | cas masque (type, décodage, passif miroir, `presetId`, masque > 2^31 sans trap) |

BRBpoints / volumes : les mises masque entrent dans `totalAmount` ⇒ comptées comme les autres paris (cohérent ; à confirmer produit, §Q8).

Réindexation : **pas nécessaire pour la justesse** (aucun type 16 n'a jamais été émis avant activation). Le changement de schéma impose un nouveau déploiement, qui doit être **synchronisé avant l'activation des masques**. Si des masques étaient joués avant, ils seraient historisés comme des pleins ⇒ réindexation complète obligatoire.

### 8.2 Frontend (`/home/user/frontend`)

| Domaine | Fichiers |
|---|---|
| Types et gains | `lib/bet-types.ts` (`BET_TYPES`, `BET_TYPE_NAMES`, `PAYOUTS` → fonction de gain par pari, `doesBetTypeWin`, `INSIDE/OUTSIDE_BET_TYPE_IDS`), nouveau `lib/mask-bets/` (encodage/décodage `BigInt`, catalogue de presets, calcul des masques liés au précédent / chauds-froids) |
| Encodage du pari | `hooks/contracts/use-place-bet.helpers.ts` (`ContractBet`, commentaire « 1-15 », `encodeBetData`), `hooks/contracts/use-place-bet.ts` (erreurs `MaskLegBelowMinBet`, `MaskLiabilityCapExceeded`, `MaskBetsDisabled`), `lib/contract-errors.ts`, `lib/abi/merged-errors.json` |
| Tapis | `components/play-field/PlayField.tsx`, `components/play-field/ui/special-bets.tsx`, `bet-description.tsx`, `bet-validation-context.tsx`, `draft-ticket.tsx`, `ticket-return-range.tsx`, `table-experience.tsx` |
| Gains / surbrillance | `lib/betting/roulette-ticket.ts:20` (lève aujourd'hui sur un type inconnu), `hooks/use-potential-payout.ts`, `hooks/use-winning-highlight.ts`, `lib/roulette/winning-breakdown.ts`, `lib/roulette/bet-recap.ts`, `lib/roulette/table-activity.ts`, `lib/roulette/table-experience.ts` |
| État | `store/bet-store.ts`, `store/rounds-store.ts` (numéro précédent pour les presets), `components/features/last-tirage/*` |
| Temps réel | `app/api/mirror/route.ts:161-191` (exact tant que `< 2^53` ; ajouter le décodage `mask`/`presetId`), `types/events.ts`, `hooks/contracts/use-game-events.ts` |
| Historique / stats | `components/features/history/*`, `lib/betting-heatmap.ts` (déplier un masque en numéros), `lib/telegram-log-formatters.ts`, `lib/generated/graphql.ts` (`yarn codegen`), `hooks/use-subgraph.ts` (chauds/froids) |
| Bot maison | `lib/bot/ticket-view.ts`, `lib/bot/strategies.ts`, `lib/bot/wallet.ts` (au minimum tolérer le type 16) |
| Retrait side bets | `components/features/side-bet/*`, `hooks/contracts/use-*side-bet*.ts`, `store/side-bet-*.ts`, `lib/side-bet/*`, entrées `/api/cron/health` side bet ; garder la lecture d'historique |
| ABI | `lib/abi/generated.ts` (régénéré par `yarn compile` côté contracts) |
| i18n | `messages/{en,fr,es,de,it,pt,ru,tr,zh}.json` : libellés et descriptions des presets, règles (« gain = 36/\|S\| », avantage 1/37), mentions « non éligible au jackpot », « aucun pouvoir prédictif » pour chauds/froids, raisons de désactivation des presets, nouvelles erreurs |
| Tests | `test/unit/*` (encodage, gains, presets, mirror) ; `test/cypress` suite `play` |

---

## 9. Plan de tests (contracts)

Unitaires — validation et gain :
- `size ∈ {2, 24}` acceptés ; `size ∈ {0, 1, 25, 37}` ⇒ `InvalidBetNumber` ; bit 37 seul, bit 52 avec masque valide (presetId max accepté), bit 53 ⇒ revert.
- Gain = `floor(amount × 36 / size)` pour tout `size ∈ [2, 24]`, avec `amount ∈ {minBet, minBet+1, 10^dec, valeurs premières}`, en **6 et 18 décimales**.
- `presetId` sans effet : deux paris identiques avec `presetId` différents ⇒ mêmes compteurs, même gain ; `presetId` présent dans `BetRecorded`/`BetPlaced`.
- Jambe masque `< minBet` dans une transaction dont le total `≥ minBet` ⇒ `MaskLegBelowMinBet`.
- Plafond de jambes : `N` accepté, `N+1` rejeté ; `0` ⇒ `MaskBetsDisabled` ; setter : contrôle d'accès + événement.
- Jackpot : round où le numéro gagnant = numéro jackpot avec uniquement des masques couvrant ce numéro ⇒ aucun gagnant jackpot ; mélange plein + masque ⇒ seul le plein est éligible.
- Paris classiques : non-régression complète (suites existantes), y compris `ZeroBetLegRejection`, `PayoutLiabilityBound`, `MultiBetCost`.

Règlement :
- Concordance compteurs / parcours : pour chaque numéro tiré (0–36, boucle), `Σ winningBetCountByShard` = nombre d'entrées gagnantes ; lanes 1 et 10 ; curseurs partiels ; `maxPayoutsPerCall` petit.
- Masques chevauchants (même numéro dans plusieurs masques, mêmes et différents joueurs) mélangés à des pleins/chances simples ; paiement total = somme attendue au wei près.
- Budget callback VRF : prolonger `test/VrfCallbackBudget.test.ts` avec 1 024 masques par marché ⇒ gaz du callback inchangé à quelques centaines près.
- Coût d'aperçu : gaz d'`eth_call` de `previewPayoutBundle` au plafond de jambes.

Solvabilité et invariant NAV :
- **Rejeu adapté de l'incident** (6 et 18 décimales) : vault à faible NAV ; 5 paris masque à `|S| = 2` (gain 18x) au maximum accepté par la solvabilité ; puis dépôt de `1 unité + 1 wei`. Attendus : `totalAssets()` strictement inchangé après chaque pari ; parts mintées = `previewDeposit` calculé **avant** les paris ; aucun dépôt ne mint à prix écrasé.
- Paris masque au-delà de la solvabilité ⇒ `InsufficientBankForMaxPayout` ; au-delà du plafond bps ⇒ `MaskLiabilityCapExceeded`.
- `drainWithdrawalQueue` revert tant qu'un masque ouvert crée un besoin, puis passe après règlement ; séquence atomique `pari masque → demande de retrait → drain` revert (calquée sur `test/BankVaultDrainIncident.test.ts`).
- Vault upgradé : `lockSideBetStake`/`setSideBetController` absents de l'ABI ; ancien contrôleur ⇒ `releaseBets`/`payoutBatch`/`transferOut` revert `OnlyEngine`.

Fuzz / propriétés :
- Pour tout `(mask, amount)` valide : `payout ≤ amount × 36 / |S|` et `payout × 37 ≤ amount × 36 × 37 / |S|` (avantage ≥ 1/37).
- Pour toute séquence de paris (classiques + masques) et tout numéro tiré : paiement réel ≤ passif bufferisé au moment du dernier pari.
- Pour toute séquence `placeBet` : `totalAssets()` après = `totalAssets()` avant.

Upgrade et stockage :
- Layout moteur : préfixe ERC-7201 identique, nouveaux champs en fin (`EngineStorageLayout.test.ts`).
- Layout vault : 14 champs, même slot/offset/type (mêmes outils que l'incident).
- Fork mainnet : upgrade moteur puis beacon en phase `Open`, pari classique + masques (après activation), règlement complet par scheduler, file de retrait, dépôt suivant.
- Tailles : runtime ≤ 24 576, initcode ≤ 49 152, sans contournement.

---

## 10. Déploiement

Ordre recommandé :

1. **Subgraph** tolérant (MASK reconnu, plus de repli `STRAIGHT`) déployé et synchronisé.
2. **Frontend** tolérant (types/historique/mirror) ; UI masques masquée derrière un flag.
3. **Sepolia — moteur E1** : nouvelles libs + implémentation (masques désactivés, `totalAssets()`), upgrade en phase `Open`.
4. **Sepolia — vault V1** via le beacon Sepolia, après preflight §6.2.
5. **Sepolia — activation** : `setMaskBetLimits` avec valeurs prudentes ; tests manuels et campagne de charge (masques au plafond, 10 lanes) ; vérifier `yarn reconcile:vaults` côté subgraph.
6. **Audit externe** sur le diff moteur + libs + vault (focus : §3.6, concordance compteurs/parcours, bornes, layout).
7. **Mainnet** : mêmes étapes 3 → 5, via le chemin d'administration en vigueur (rôle `DEFAULT_ADMIN_ROLE` du moteur, propriétaire du beacon `0x7b23…632b`, timelock si configuré), plafonds bas au lancement puis relevés.

Rollback :

| Situation | Action |
|---|---|
| Problème fonctionnel masques | `setMaskBetLimits(0, …)` : désactivation immédiate, sans upgrade ; les masques du round en cours se règlent normalement |
| Bug du moteur v2, aucun masque dans un round non résolu | Réupgrade vers l'implémentation précédente (layout append-only : l'ancienne ignore les nouveaux champs) |
| Bug du moteur v2 **avec** des masques dans le round en cours | **Pas de rollback** avant résolution du round (l'ancienne implémentation ne paierait pas les masques mais garderait les stakes) ; désactiver, laisser régler, puis rollback |
| Bug du vault V1 | Réupgrade du beacon vers l'implémentation précédente (réintroduit la surface side bet, inerte tant que `sideBetsDisabled`) ; préférer un correctif V2 |

---

## Questions ouvertes

Produit (non tranchées ici) :

- **Q1 — Le 0 dans les presets.** Incohérence dans le catalogue fourni : « carré parfait » inclut 0, mais « Fibonacci », « multiple de 4/7 » et « finale 0 » l'excluent ; « inférieur au précédent » l'inclut-il ? Une règle unique est à choisir (les deux variantes sont chiffrées en annexe).
- **Q2 — Doublon.** « Contient un 7 » et « finale 7 » sont le **même ensemble** `{7, 17, 27}`. Garder les deux presets (avec des `presetId` distincts) ou fusionner ?
- **Q3 — Voisins.** Le preset à 5 numéros inclut le numéro précédent lui-même (`p` et 2 voisins de chaque côté). Variante sans `p` : 4 numéros (9x). Lequel ?
- **Q4 — Chauds/froids.** Fenêtre d'historique `N` et taille `k` (k ∈ [2, 24]) ; égalités de fréquence ; formulation honnête de l'absence de pouvoir prédictif dans les 9 langues.
- **Q5 — Valeurs des plafonds.** `maxMaskLegsPerMarketRound` (proposé 1 024) et `maxMaskLiabilityBps` (à fixer, bas au lancement), éventuellement différenciés Sepolia/mainnet ; plafond global (moteur) ou par marché.
- **Q6 — Garde de round.** Faut-il une garde on-chain (« ce pari n'est valide que dans le round X », p. ex. nouveau point d'entrée vault) pour les presets liés au précédent, ou la règle UI du §7 suffit-elle ?
- **Q7 — Sort de SideBet et du scheduler.** Laisser `SideBet` désactivé indéfiniment, ou redéployer le scheduler sans voies side bet ? Que garder de l'historique side bet dans le frontend ?
- **Q8 — Comptabilité annexe.** Les mises masque doivent-elles compter pour le parrainage BRBR (aujourd'hui automatique via `_applyReferral`, `RouletteEngine.sol:392-405`) et pour les BRBpoints, comme les autres paris ?

Techniques à vérifier pendant l'implémentation (pas des choix produit) :

- Plafond de gaz des `eth_call` utilisés par le workflow CRE pour `previewPayoutBundle` (dimensionne le plafond de jambes).
- Comportement exact de `BigInt.toI32()` (graph-ts 0.38) sur une valeur > 2^31, et disponibilité de `bitAnd`/`rightShift` : à verrouiller par un test Matchstick.

---

## Annexe A — Catalogue de presets v1

Vérifié par script (ensembles, cardinaux, gains, masques hexadécimaux, ordre du cylindre européen `0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26`). Gain = `36/|S|` (stake inclus, arrondi vers le bas en unités de base) ; retour espéré = 36/37 = 97,297 % pour **tous** les presets.

### A.1 Presets statiques

| Preset | Ensemble S | \|S\| | Gain (x) | Masque | Remarque |
|---|---|---|---|---|---|
| Nombre premier | 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31 | 11 | 3,2727 | `0xa08a28ac` | Conforme |
| Contient un 3 | 3, 13, 23, 30, 31, 32, 33, 34, 35, 36 | 10 | 3,6 | `0x1fc0802008` | Conforme |
| Contient un 7 | 7, 17, 27 | 3 | 12 | `0x8020080` | Conforme ; identique à « finale 7 » (Q2) |
| Carré parfait | 0, 1, 4, 9, 16, 25, 36 | 7 | 5,1429 | `0x1002010213` | Conforme (inclut 0 = 0²) |
| Fibonacci (sans 0) | 1, 2, 3, 5, 8, 13, 21, 34 | 8 | 4,5 | `0x40020212e` | Conforme ; variante avec 0 (F₀ = 0) : 9 numéros, 4x, `0x40020212f` (Q1) |
| Doublés | 11, 22, 33 | 3 | 12 | `0x200400800` | Conforme |
| Somme des chiffres = 9 | 9, 18, 27, 36 | 4 | 9 | `0x1008040200` | Conforme |
| Multiple de 4 (sans 0) | 4, 8, 12, 16, 20, 24, 28, 32, 36 | 9 | 4 | `0x1111111110` | Conforme si 0 exclu ; avec 0 : 10, 3,6x (Q1) |
| Multiple de 7 (sans 0) | 7, 14, 21, 28, 35 | 5 | 7,2 | `0x810204080` | Conforme si 0 exclu ; avec 0 : 6, 6x (Q1) |
| Rouge & pair | 12, 14, 16, 18, 30, 32, 34, 36 | 8 | 4,5 | `0x1540055000` | Conforme |
| Noir & impair | 11, 13, 15, 17, 29, 31, 33, 35 | 8 | 4,5 | `0xaa002a800` | Conforme |
| Rouge & impair | 1, 3, 5, 7, 9, 19, 21, 23, 25, 27 | 10 | 3,6 | `0xaa802aa` | Conforme |
| Noir & pair | 2, 4, 6, 8, 10, 20, 22, 24, 26, 28 | 10 | 3,6 | `0x15500554` | Conforme |

### A.2 Finales (cardinaux précisés — le brief ne les donnait pas)

| Finale | Ensemble S | \|S\| | Gain (x) | Masque |
|---|---|---|---|---|
| 0 (sans le 0) | 10, 20, 30 | 3 | 12 | `0x40100400` |
| 0 (avec le 0, Q1) | 0, 10, 20, 30 | 4 | 9 | `0x40100401` |
| 1 | 1, 11, 21, 31 | 4 | 9 | `0x80200802` |
| 2 | 2, 12, 22, 32 | 4 | 9 | `0x100401004` |
| 3 | 3, 13, 23, 33 | 4 | 9 | `0x200802008` |
| 4 | 4, 14, 24, 34 | 4 | 9 | `0x401004010` |
| 5 | 5, 15, 25, 35 | 4 | 9 | `0x802008020` |
| 6 | 6, 16, 26, 36 | 4 | 9 | `0x1004010040` |
| 7 | 7, 17, 27 | 3 | 12 | `0x8020080` |
| 8 | 8, 18, 28 | 3 | 12 | `0x10040100` |
| 9 | 9, 19, 29 | 3 | 12 | `0x20080200` |

### A.3 Presets liés au tirage précédent `p`

| Preset | Ensemble S | \|S\| | Actif si | Gain |
|---|---|---|---|---|
| Supérieur au précédent | `{p+1 … 36}` | `36 − p` | `p ∈ [12, 34]` (23 valeurs) | `36/(36−p)` |
| Inférieur au précédent (0 inclus) | `{0 … p−1}` | `p` | `p ∈ [2, 24]` (23 valeurs) | `36/p` |
| Inférieur au précédent (0 exclu, Q1) | `{1 … p−1}` | `p − 1` | `p ∈ [3, 25]` | `36/(p−1)` |
| Voisins du précédent (cylindre) | `p` + 2 voisins de chaque côté | 5 | toujours (y compris `p = 0` : {0, 3, 15, 26, 32}) | 7,2x |
| Même couleur que le précédent | 18 rouges ou 18 noirs | 18 | `p ≠ 0` | 2x |
| Même douzaine que le précédent | douzaine de `p` | 12 | `p ≠ 0` | 3x |
| Égal au précédent | — | 1 | — | joué comme un **plein** (type 1), pas un masque |

« Supérieur » et « inférieur » ne sont simultanément actifs que pour `p ∈ [12, 24]`. Exemples de voisins : `p = 26` → {0, 3, 26, 32, 35} ; `p = 17` → {2, 6, 17, 25, 34}.

### A.4 Presets historiques

| Preset | Ensemble S | \|S\| | Remarque |
|---|---|---|---|
| Chauds | `k` numéros les plus sortis sur les `N` derniers tirages (subgraph) | `k ∈ [2, 24]` | Paramètres Q4 |
| Froids | `k` numéros les moins sortis sur la même fenêtre | `k ∈ [2, 24]` | Paramètres Q4 |

Mention obligatoire dans l'UI : les tirages sont indépendants (Chainlink VRF) ; la fréquence passée n'a **aucun pouvoir prédictif**. Ces presets ont exactement le même retour espéré (36/37) que tous les autres.
