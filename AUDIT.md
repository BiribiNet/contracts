# Audit Complet — Biribi Smart Contracts

## Contexte

Audit de sécurité et d'architecture du protocole Biribi, roulette française décentralisée sur Arbitrum.
Framework : **Hardhat** (pas Foundry malgré ce que dit le CLAUDE.md). Solidity 0.8.27, OpenZeppelin v5.3.0, Chainlink VRF v2.5 + Automation v2.1.

---

## 1. Architecture Générale

### 1.1 Contracts et Interactions

```
                    ┌──────────────┐
                    │   Frontend   │
                    └──────┬───────┘
                           │ BRB.bet()
                    ┌──────▼───────┐
                    │   BRB Token  │──── ERC-20 + ERC-677 callback
                    │   (BRB.sol)  │     30M supply, burn(), transferBatch()
                    └──────┬───────┘
                           │ onTokenTransfer()
                    ┌──────▼───────┐         ┌─────────────────────┐
                    │  StakedBRB   │◄────────│  LiquidityEscrow    │
                    │  (sBRB Vault)│         │  (holds queued BRB) │
                    │  ERC-4626    │         └─────────────────────┘
                    │  UUPS Proxy  │
                    └──┬───┬───┬───┘
           bet()       │   │   │  processRouletteResult()
        ┌──────────────┘   │   └──────────────────┐
        │                  │                       │
┌───────▼────────┐  onBettingWindowClosed()  ┌─────▼──────────┐
│ RouletteClean  │  onRoundTransition()      │ JackpotContract│
│  VRF + Game    │  onRoundBoundary()        │  UUPS Proxy    │
│  UUPS Proxy    │◄──────────────────────────│                │
└───────┬────────┘                           └────────────────┘
        │
┌───────▼────────┐         ┌──────────────┐
│ Chainlink VRF  │         │ BRBReferal   │
│ Coordinator    │         │ (BRBR token) │
└────────────────┘         └──────────────┘

┌────────────────┐
│BRBUpkeepManager│ ─── Registers all Chainlink Automation upkeeps
│  (non-proxy)   │     Authorizes forwarders for Roulette + StakedBRB
└────────────────┘
```

### 1.2 Contracts Inventory

| Contract | Type | LOC | Rôle |
|---|---|---|---|
| `BRB.sol` | ERC-20 (immutable) | 33 | Token natif, bet(), burn(), transferBatch() |
| `StakedBRB.sol` | ERC-4626 UUPS Proxy | ~1122 | Vault staking, fee distribution, withdrawal queue, deposit queue, automation |
| `RouletteClean.sol` | UUPS Proxy + VRFConsumerBaseV2 | ~1110 | Game logic, bet storage, VRF, payout batching |
| `RouletteLib.sol` | Library | ~340 | Winning bet types, maxPayout calculation |
| `JackpotContract.sol` | UUPS Proxy | 32 | Holds jackpot pool, distributes on trigger |
| `BRBReferal.sol` | ERC-20 (immutable) | 17 | BRBR referral token, mint-only by StakedBRB |
| `BRBUpkeepManager.sol` | AccessControl (immutable) | ~307 | Upkeep registration, forwarder authorization |
| `StakedBRBLiquidityEscrow.sol` | Immutable | 36 | Holds BRB for queued deposits |
| `ERC4626Upgradeable.sol` | Custom OZ fork | ~320 | Modified ERC-4626 with slippage params |

### 1.3 Round Lifecycle (Critical Path)

```
1. GAME_PERIOD (betting open)
   └─ Users: BRB.bet() → StakedBRB.onTokenTransfer() → RouletteClean.bet()
   └─ Deposits: queued in LiquidityEscrow

2. PreVrfLock upkeep (checkData.length == 0)
   └─ RouletteClean.performUpkeep() → StakedBRB.onBettingWindowClosed()
   └─ Sets roundResolutionLocked = true

3. VRF upkeep (checkData.length == 1, after GAME_PERIOD + lock)
   └─ RouletteClean._triggerVRF() → requests VRF
   └─ StakedBRB.onRoundTransition(newRoundId)
   └─ roundResolutionLocked = false, roundTransitionInProgress = true

4. VRF Callback
   └─ fulfillRandomWords() → stores winningNumber + jackpotNumber

5. ComputeTotalWinningBets upkeep (checkData.length == 2)
   └─ Counts winners, sets jackpot result if triggered

6. PayoutBatch upkeeps (checkData.length >= 3)
   └─ Batched payouts (BATCH_SIZE=35 per batch)
   └─ Last batch → StakedBRB.processRouletteResult(isLastBatch=true)

7. Cleaning upkeep (StakedBRB)
   └─ Applies fees (protocol, burn, jackpot)
   └─ Processes withdrawal queue
   └─ Processes deposit queue from escrow
   └─ Resets pendingBets/maxPayout/totalPayouts
   └─ Updates lastRoundBoundaryTimestamp → new round starts
```

---

## 2. Storage Layout

### 2.1 RouletteClean (EIP-7201 @ slot 0xf43a...a900)

| Slot Offset | Variable | Type |
|---|---|---|
| 0 | `currentRound` | uint256 |
| 1 | `lastRoundStartTime` | uint256 |
| 2 | `lastRoundPaid` | uint256 |
| 3 | `totalBetsInRound` | mapping(uint256 => uint256) |
| 4 | `roundBatchBitmap` | mapping(uint256 => uint256) |
| 5 | `totalWinningBets` | mapping(uint256 => uint256) |
| 6 | `totalWinningBetsSet` | mapping(uint256 => bool) |
| 7 | `winningBetsProcessed` | mapping(uint256 => uint256) |
| 8 | `minJackpotCondition` | uint256 |
| 9-24 | Bet storage mappings | mapping(uint256 => ...) x16 types |
| 25 | `jackpotResult` | mapping(uint256 => JackpotResult) |
| 26 | `randomResults` | mapping(uint256 => RandomResult) |
| 27 | `requestIdToRound` | mapping(uint256 => uint256) |
| 28-35 | Optimized max tracking | Various mappings |

**Note**: No struct packing — all mappings, each occupies 1 slot. Storage is clean but heavy (35+ mappings).

### 2.2 StakedBRB (EIP-7201 @ slot 0x7b58...9c00)

| Slot Offset | Variable | Type | Notes |
|---|---|---|---|
| 0 | `jackpotAmount` | uint256 | **UNUSED** — always 0 in code |
| 1 | `jackpotBasisPoints` | uint256 | Could be uint16 |
| 2 | `burnBasisPoints` | uint256 | Could be uint16 |
| 3 | `protocolFeeBasisPoints` | uint256 | Could be uint16 |
| 4 | `feeRecipient` | address | 20 bytes, wastes 12 |
| 5 | `pendingBets` | uint256 | |
| 6 | `totalPayouts` | uint256 | |
| 7 | `maxPayout` | uint256 | |
| 8 | `currentRound` | uint256 | |
| 9 | `lastRoundPaid` | uint256 | |
| 10 | `lastRoundResolved` | uint256 | |
| 11 | `lastRoundBoundaryTimestamp` | uint256 | |
| 12 | `roundResolutionLocked` | bool | 1 byte, wastes 31 |
| 13 | `roundTransitionInProgress` | bool | 1 byte, wastes 31 |
| 14 | `withdrawalBatchSize` | uint256 | |
| 15 | `withdrawalQueue` | address[] | Dynamic array |
| 16 | `pendingWithdrawal` | mapping | |
| 17 | `userQueuePosition` | mapping | |
| 18 | `queueHead` | uint256 | |
| 19 | `queueTail` | uint256 | |
| 20 | `queueSize` | uint256 | |
| 21 | `maxQueueLength` | uint256 | |
| 22 | `depositMintQueue` | QueuedLiquidity[] | |
| 23 | `depositMintQueueHead` | uint256 | |
| 24 | `queuedDepositIntentByPayer` | mapping | |
| 25 | `liquidityEscrow` | address | |
| 26-29 | Deprecated slots | Various | Legacy forwarder/registrar |
| 30 | `liquidityOpsPerCleaningUpkeep` | uint32 | |

**Packing issues**: Slots 12-13 (`bool, bool`) waste 62 bytes. Slots 1-3 (basis points, max 10000) could pack into one slot. `feeRecipient` + `roundResolutionLocked` + `roundTransitionInProgress` + `liquidityOpsPerCleaningUpkeep` could all fit in 1 slot (address + bool + bool + uint32 = 26 bytes).

### 2.3 BRB Token
Standard OZ ERC-20 + ERC20Permit. No custom storage.

### 2.4 JackpotContract
No custom storage (only immutables + AccessControl/UUPS inherited slots).

### 2.5 BRBReferal
Standard OZ ERC-20. Only 1 immutable (`STAKED_BRB_CONTRACT`).

---

## 3. Vulnérabilités Identifiées

### CRITICAL

#### C-01 : Manipulation des données `performData` par Chainlink Automation (checkUpkeep → performUpkeep trust assumption)

**Fichiers** : `RouletteClean.sol:653-667`, `StakedBRB.sol:428-430`

**Problème** : L'architecture repose sur un pattern où `checkUpkeep()` pré-calcule toutes les données (payouts, fees, users to process) et les passe en `performData` à `performUpkeep()`. Le `performUpkeep()` **fait confiance aveuglément** aux données reçues sans re-vérifier on-chain.

- `RouletteClean._processBatch()` (ligne 751) prend `PayoutBatch` avec des `payouts[]` et `totalPayouts` pré-calculés — aucune re-validation que ces montants correspondent aux bets réels.
- `StakedBRB._processCleaning()` (ligne 441) prend `CleaningUpkeepData` avec `fees` pré-calculées — aucune re-validation.

**Vecteur** : Dans le modèle Chainlink Automation v2.1, le `performData` est signé par le réseau DON et les forwarders sont trustés. **Cependant**, un bug dans `checkUpkeep` qui calcule des payouts incorrects serait exécuté sans filet de sécurité. De plus, si le keeper registrar est compromis ou si un forwarder malveillant est enregistré, les payouts sont arbitraires.

**Impact** : Drainage complète du vault si des payouts gonflés sont passés.

**Facteur atténuant** : Le `onlyForwarders` modifier vérifie via `BRBUpkeepManager` qui lui-même n'enregistre que via le Chainlink Registrar officiel. Le risque réel est plus un bug dans `checkUpkeep` qu'une attaque directe.

**Recommandation** : Ajouter des bornes de sanity-check dans `performUpkeep` :
- `totalPayouts <= pendingBets` (impossible de payer plus que ce qui a été misé)
- `fees.protocolFees + fees.burnAmount + fees.jackpotAmount <= pendingBets - totalPayouts`

---

#### C-02 : Absence de ReentrancyGuard sur StakedBRB

**Fichier** : `StakedBRB.sol` (ensemble du contrat)

**Problème** : Aucun `ReentrancyGuard` n'est utilisé malgré que le contrat :
1. Appelle `IERC20(BRB_TOKEN).transfer()` dans `_processCleaning()` (ligne 460-466)
2. Appelle `IERC20Burnable(BRB_TOKEN).burn()` (ligne 466)
3. Appelle `IBRB(BRB_TOKEN).transferBatch()` dans `processRouletteResult()` (ligne 572)
4. Appelle `escrow.pushToVault()` / `escrow.refund()` dans la liquidity queue processing

Le BRB token est un ERC-20 standard OZ sans hooks (pas ERC-777), donc **le risque actuel est faible**. Mais le CLAUDE.md exige explicitement "ReentrancyGuard on all external functions that transfer value" et le contrat est upgradeable — une future version pourrait introduire un token avec callbacks.

**Facteur atténuant** : BRB est un ERC-20 vanille sans hooks de callback. Le flow `_processCleaning` est appelé uniquement par des Chainlink forwarders autorisés.

**Recommandation** : Ajouter `ReentrancyGuardUpgradeable` sur `processRouletteResult()`, `_processCleaning()`, `deposit()`, `withdraw()`, `redeem()`.

---

### HIGH

#### H-01 : ERC-4626 Inflation Attack — Protection insuffisante

**Fichier** : `ERC4626Upgradeable.sol:271-280`, `StakedBRB.sol:35`

**Problème** : Le vault utilise `_decimalsOffset() = 0` (default, jamais overridden dans StakedBRB). La formule OZ avec virtual shares/assets est :
```
shares = assets * (totalSupply + 1) / (totalAssets + 1)
```

Le `MINIMUM_FIRST_DEPOSIT = 1000` (= 1000 wei de BRB, soit 0.000000000000001 BRB avec 18 decimals) est **ridiculement bas**. Un attaquant peut :
1. Être le premier déposant avec 1000 wei → reçoit ~1000 shares
2. Donner directement (via transfer) un gros montant de BRB au vault
3. Le prochain déposant reçoit 0 shares à cause de l'arrondi

**Facteur atténuant** : Les dépôts sont queueés dans `LiquidityEscrow` et traités batch par le cleaning upkeep, ce qui rend l'attaque plus complexe (le "donation" doit arriver entre le premier dépôt et le batch processing). Mais le premier dépôt (`totalSupply == 0`) est exécuté immédiatement (`super.deposit()`).

**Recommandation** :
- Augmenter `MINIMUM_FIRST_DEPOSIT` à au moins `1e16` (0.01 BRB) ou mieux `1e18`
- Ou override `_decimalsOffset()` pour retourner 6 (standard OZ recommendation)
- Ou dead shares : le premier déposant mint des shares vers `address(1)` en plus

---

#### H-02 : Fee rates modifiables par l'admin — contradiction avec "No Admin Keys"

**Fichier** : `StakedBRB.sol:715-740`

**Problème** : Le CLAUDE.md et le whitepaper clament "No admin keys — core game logic and revenue splits are hardcoded and immutable post-deployment". **Mais** :
- `setProtocolFeeRate()` — admin peut monter les frais protocole jusqu'à 100%
- `setJackpotFeeRate()` — admin peut modifier le taux jackpot
- `setBurnFeeRate()` — admin peut modifier le taux de burn
- `setFeeRecipient()` — admin peut rediriger les fees
- `setMinJackpotCondition()` — admin peut changer le seuil jackpot
- `setWithdrawalBatchSize()` — admin peut throttle les withdrawals
- `setMaxQueueLength()` — admin peut réduire la queue
- `_authorizeUpgrade()` — admin peut upgrader les implémentations

La seule contrainte est que `protocolFee + burn + jackpot <= 10000 BPS` (= 100%). Un admin malveillant peut mettre `protocolFeeBPS = 10000` et capturer 100% des pertes des joueurs.

**Impact** : Contradicts le claim d'immutabilité. L'admin contrôle effectivement tous les paramètres économiques ET peut upgrader les contracts.

**Recommandation** :
- Hardcoder les fee rates en `constant` (comme promis dans la doc)
- Ou ajouter des bornes strictes (e.g. `protocolFee <= 500` = 5% max)
- Timelock sur les upgrades (au minimum 48h)
- Renoncer à `DEFAULT_ADMIN_ROLE` après configuration initiale

---

#### H-03 : `_skipOrProcessSimpleBets` — totalPayouts remis à 0 quand un array est skip

**Fichier** : `RouletteClean.sol:938-939`

**Problème** : Quand un array de bets est complètement avant la batch window (skip), la fonction retourne `totalPayouts = 0` :
```solidity
if (currentIndex + v.betsLength <= startIndex) {
    return (currentIndex + v.betsLength, payoutCount, 0); // ← totalPayouts reset to 0!
}
```

Cela écrase le `totalPayouts` accumulé des bet types précédents. Dans `_collectWinningPayoutsBatch`, le retour `v.totalPayouts` est assigné depuis chaque appel :
```solidity
(v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets(..., v.totalPayouts);
```

Quand un skip retourne 0, le total accumulé est perdu.

**Impact** : Les payouts reportés à `StakedBRB.processRouletteResult()` via `batchData.totalPayouts` seront incorrects (sous-estimés). Cela signifie que `$.totalPayouts` dans le vault sera trop bas → les fees calculées seront trop hautes → les stakers captent plus qu'ils ne devraient au détriment des joueurs gagnants (ou inversement, le vault croit avoir plus d'assets qu'il n'en a).

**Recommandation** : Le skip doit propager `totalPayouts` tel quel :
```solidity
return (currentIndex + v.betsLength, payoutCount, totalPayouts); // pass-through
```

---

### MEDIUM

#### M-01 : Withdrawal queue — griefing par remplissage

**Fichier** : `StakedBRB.sol:826, 859, 910-926`

**Problème** : N'importe quel holder de sBRB peut enqueuer un withdraw pour un montant minime (1 wei d'assets). La queue est limitée à `maxQueueLength` (default 100, max 1000). Un attaquant peut :
1. Créer 100 addresses avec chacune 1 sBRB share
2. Chacune appelle `withdraw(1, receiver, owner, 0)`
3. La queue est pleine → `QueueFull()` pour les vrais utilisateurs

Le `withdrawalBatchSize` est seulement 5-12 par round. Avec un `GAME_PERIOD` de ~60s, il faudrait 8-20 rounds (8-20 minutes) pour vider une queue de 100 → DoS temporaire sur les retraits légitimes.

**Facteur atténuant** : L'attaquant doit posséder des sBRB shares réelles. Coût non-nul mais faible.

**Recommandation** : Ajouter un montant minimum de withdrawal (e.g. `MINIMUM_FIRST_DEPOSIT`).

---

#### M-02 : Deposit queue — une seule opération par `payer` (DoS sur UX)

**Fichier** : `StakedBRB.sol:802`

**Problème** : `queuedDepositIntentByPayer[msg.sender]` interdit un second dépôt tant que le premier n'est pas traité. Un utilisateur qui veut augmenter sa position doit attendre le prochain cleaning upkeep. Ce n'est pas un bug mais une limitation UX significative non documentée.

**Recommandation** : Documenter clairement ou permettre l'accumulation (additionner les assets dans le même slot de queue).

---

#### M-03 : `BRB.bet()` — pas de vérification `to != address(0)`

**Fichier** : `BRB.sol:15-18`

**Problème** : La fonction `bet()` appelle `_transfer(msg.sender, address(to), amount)` suivi de `to.onTokenTransfer()`. Si `to` est `address(0)`, le `_transfer` reverts grâce à OZ ERC-20. Cependant, `transferBatch()` (ligne 20-28) ne vérifie pas `payoutInfo.player != address(0)` — si un payout inclut `address(0)`, les tokens sont brûlés via `_transfer` vers `address(0)`.

**Facteur atténuant** : Les payouts sont construits dans `checkUpkeep` à partir des bets stockés, et les bets requièrent un `sender` non-zero (msg.sender). Mais un bug dans `checkUpkeep` pourrait générer un payout vers `address(0)`.

**Recommandation** : Vérifier `payoutInfo.player != address(0)` dans `transferBatch`.

---

#### M-04 : Pas de gap `__gap` pour les contrats upgradeable custom

**Fichier** : `StakedBRB.sol`, `RouletteClean.sol`

**Problème** : Les contrats utilisent EIP-7201 (namespaced storage), ce qui élimine le besoin de `__gap` pour le storage struct principal. **Cependant**, si un futur upgrade ajoute de l'héritage d'un nouveau contrat base qui utilise le storage layout classique (non-namespaced), il y aurait un risque de collision.

**Facteur atténuant** : L'utilisation d'EIP-7201 est la bonne pratique moderne. Le risque est théorique.

**Recommandation** : Acceptable tel quel tant que tous les futurs upgrades utilisent EIP-7201.

---

#### M-05 : Jackpot payout — arrondi vers le bas perd des BRB dans le contrat

**Fichier** : `RouletteClean.sol:811`

**Problème** : Le calcul jackpot utilise `currentBet.amount * jackpotAmount / totalJackpotBetAmount`. Avec floor division, la somme des payouts est potentiellement inférieure au `jackpotAmount`. La différence (dust) reste bloquée dans le `JackpotContract` pour toujours.

**Impact** : Faible — quelques wei de BRB perdus par jackpot trigger.

**Recommandation** : Le dernier gagnant du batch pourrait recevoir le remainder, ou accepter le dust comme design choice (c'est le pattern standard).

---

### LOW

#### L-01 : Typo dans le nom du contrat — `BRBReferal` au lieu de `BRBReferral`

**Fichier** : `BRBReferal.sol`

**Impact** : Cosmétique mais affecte la lisibilité et la cohérence. Le CLAUDE.md dit "BRBReferral" partout.

---

#### L-02 : `StakedBRBStorage.jackpotAmount` (slot 0) — variable morte

**Fichier** : `StakedBRB.sol:65`

**Problème** : `jackpotAmount` dans le storage struct n'est jamais écrit ni lu dans le code. C'est du dead storage qui consomme un slot.

**Recommandation** : Supprimer dans un prochain upgrade (attention : ne pas shift les slots, utiliser un placeholder ou un commentaire deprecated).

---

#### L-03 : Deprecated storage slots non nettoyés

**Fichier** : `StakedBRB.sol:104-107`

**Problème** : 4 slots deprecated (`forwarders`, `keeperRegistrar`, `keeperRegistry`, `linkToken`) occupent du storage. Pas de risque fonctionnel mais pollue le layout.

---

#### L-04 : Events non indexés sur des champs importants

**Fichier** : `StakedBRB.sol:158-179`

**Problème** : `BetPlaced` n'indexe pas `user`. `WithdrawalRequested` n'indexe pas `user`. Cela rend le filtrage off-chain moins efficient pour les subgraphs.

**Recommandation** : `event BetPlaced(address indexed user, ...)`, `event WithdrawalRequested(address indexed user, ...)`.

---

#### L-05 : `cancelWithdrawal` émet `WithdrawalProcessed` — sémantiquement incorrect

**Fichier** : `StakedBRB.sol:1105-1106`

**Problème** : Quand un user annule son withdrawal, l'event `WithdrawalProcessed` est émis. Il devrait y avoir un event `WithdrawalCancelled` distinct pour différencier dans les subgraphs.

---

#### L-06 : `getWinningSplits` alloue un array de 10 mais max réel est 4

**Fichier** : `RouletteLib.sol:92`

**Problème** : `uint256[] memory splits = new uint256[](10)` — un nombre ne peut avoir que max 4 splits adjacents. L'allocation de 10 gaspille de la mémoire.

---

### GAS OPTIMIZATIONS

#### G-01 : Storage packing dans `StakedBRBStorage`

**Potentiel** : ~10,000-20,000 gas par round de cleaning.

Pack possible :
```solidity
// Slot actuel : 6 slots → 2 slots
struct PackedConfig {
    address feeRecipient;     // 20 bytes
    uint16 jackpotBasisPoints; // 2 bytes
    uint16 burnBasisPoints;    // 2 bytes
    uint16 protocolFeeBasisPoints; // 2 bytes
    bool roundResolutionLocked;    // 1 byte
    bool roundTransitionInProgress; // 1 byte
    uint32 liquidityOpsPerCleaningUpkeep; // 4 bytes
    // Total: 32 bytes = 1 slot
}
```

---

#### G-02 : `Bet` struct non packed

**Fichier** : `RouletteClean.sol:76-80`

```solidity
struct Bet {
    address player;  // 20 bytes
    uint256 amount;  // 32 bytes → slot 2
    uint256 number;  // 32 bytes → slot 3
}
// = 3 slots par bet
```

Pourrait être :
```solidity
struct Bet {
    address player;  // 20 bytes
    uint96 amount;   // 12 bytes  → packs avec player dans slot 1
    uint8 number;    // 1 byte    → slot 2 (mais waste 31 bytes)
}
// = 2 slots par bet
```

`uint96` supporte jusqu'à ~7.9 × 10^28 wei ≈ 79 billion BRB — largement suffisant.
`number` va de 0-36, tient dans un `uint8`.

**Impact** : Réduit le coût de chaque `push()` de bet de ~20,000 gas (1 SSTORE en moins par bet).

---

#### G-03 : `_validateAndStoreBet` — chaîne d'if/else pour 15 types

**Fichier** : `RouletteClean.sol:405-530`

Les 15 `if/else if` branches pourraient être remplacées par un jump table ou un mapping de function selectors. Cependant, le compilateur Solidity optimise déjà les chaînes if/else en binary search avec optimization enabled, donc le gain réel serait marginal.

**Recommandation** : Garder tel quel — lisibilité > micro-optimisation.

---

#### G-04 : `isRedNumber` — bitmap au lieu de 18 comparaisons

**Fichier** : `RouletteLib.sol:249-256`

```solidity
// Actuel : 18 comparaisons
return (num == 1 || num == 3 || ... || num == 36);

// Optimisé : 1 SLOAD (constant) + bitwise AND
uint256 constant RED_BITMAP = (1 << 1) | (1 << 3) | (1 << 5) | ...;
return num <= 36 && (RED_BITMAP & (1 << num)) != 0;
```

**Impact** : ~200-400 gas économisés par appel.

---

#### G-05 : `_collectWinningPayoutsBatch` — assembly resize au mauvais endroit

**Fichier** : `RouletteClean.sol:910-912`

```solidity
assembly {
    mstore(tempPayouts, mload(v)) // ← reads from struct memory, fragile!
}
```

Ce code lit le premier mot de la struct `CollectWinningsValues` en mémoire, qui est `payoutCount`. Cela fonctionne car `payoutCount` est le premier champ, mais c'est fragile — tout réordonnancement de la struct casse silencieusement l'assembly.

**Recommandation** : Utiliser `mstore(tempPayouts, v.payoutCount)` en Solidity pur, ou au minimum documenter la dépendance à l'ordre des champs.

---

## 4. Analyse du Modèle Économique

### 4.1 Fee Split — Réalité vs Documentation

| Source | Stakers | Jackpot | Burn | Infra/Protocol |
|---|---|---|---|---|
| **CLAUDE.md / Whitepaper** | 95.0% | 2.5% | 0.5% | 2.0% |
| **Code (initialize params)** | Variable | Variable | Variable | Variable |
| **Tests (fixture)** | 95.0%* | 1.5% | 0.5% | 3.0% |

\*Les stakers reçoivent `100% - (protocol + burn + jackpot)` = le résidu.

**Problème fondamental** : Les fee rates ne sont PAS hardcodées. Elles sont passées en paramètre à `initialize()` et modifiables par l'admin via `setProtocolFeeRate()`, `setJackpotFeeRate()`, `setBurnFeeRate()`. Le seul invariant est que leur somme ≤ 10000 BPS.

Les tests utilisent `protocol=300 (3%), burn=50 (0.5%), jackpot=150 (1.5%)` → stakers reçoivent 96%, ce qui ne match ni la doc (95%) ni les constantes du CLAUDE.md.

### 4.2 Revenue Flow Analysis

```
Pour chaque round :

  Joueurs misent X BRB (pendingBets += X)
  VRF → résultat
  Payouts = P BRB (vers les gagnants)
  Net Loss = X - P (reste dans le vault)

  Sur Net Loss :
    protocol = NetLoss × protocolFeeBPS / 10000  → feeRecipient
    burn     = NetLoss × burnBPS / 10000         → burned
    jackpot  = NetLoss × jackpotBPS / 10000      → JackpotContract
    stakers  = NetLoss - protocol - burn - jackpot → reste dans vault (sBRB appreciation)

  Si P > X (joueurs gagnent net) :
    NetLoss = 0, fees = 0
    Le vault paie la différence de ses assets
    sBRB shares perdent de la valeur (socialisation des pertes)
```

### 4.3 EV (Expected Value) pour les Stakers

**Modèle mathématique** : Roulette européenne, house edge = 1/37 ≈ 2.703%

Pour chaque 1 BRB misé :
- EV du casino (avant fees) = 0.02703 BRB
- Stakers reçoivent : `0.02703 × (1 - protocolFee% - burn% - jackpot%)`

Avec les paramètres du CLAUDE.md (protocol=2%, burn=0.5%, jackpot=2.5%) :
- Stakers : `0.02703 × 0.95 = 0.02568 BRB` par BRB misé
- APR : dépend du ratio `volume misé / TVL vault`

**Exemple** :
- TVL vault = 1M BRB
- Volume quotidien = 100K BRB misés
- Revenue quotidien stakers = 100K × 0.02568 = 2,568 BRB
- APR = (2,568 × 365) / 1,000,000 = **93.7%** (très attractif)

**Risques pour les stakers** :
1. **Variance à court terme** : Un run de chance des joueurs peut drainer temporairement le vault. Le `maxPayout` + safety buffer (110%) limite l'exposition, mais un payout max théorique (tous les bets gagnent straight 36x) viderait le vault.
2. **Jackpot trigger** : Un jackpot qui grossit représente un passif contingent non comptabilisé dans `totalAssets()` (le BRB est dans `JackpotContract`, pas dans le vault).
3. **Impermanent loss relative** : Si le BRB perd de la valeur en USD, le rendement réel en USD peut être négatif malgré un rendement positif en BRB.

### 4.4 Tokenomics — Déflationnary Analysis

- **Supply initiale** : 30M BRB (fixed, no minting)
- **Burn par round** : `NetLoss × burnBPS / 10000`
- **BRBR inflation** : BRBR est minté 1:1 avec le volume misé via referral. Pas de cap. Le BRBR est convertible en BRB (mentionné dans la doc mais **aucun mécanisme de conversion n'existe dans le code**).

**Problème BRBR** : `BRBReferal.mint(referral, amount)` est appelé avec `amount` = le montant total misé (ligne 338 de StakedBRB). Pour 100K BRB misés/jour, c'est 100K BRBR/jour = 36.5M BRBR/an. Sans mécanisme de conversion borné, le BRBR est essentiellement un token inflationnaire sans valeur intrinsèque codée.

### 4.5 maxPayout — Solvency Protection

Le vault vérifie `IERC20(BRB_TOKEN).balanceOf(address(this)) >= nextMaxPayout` à chaque bet (StakedBRB.sol:336). Le `maxPayout` est calculé comme le worst-case (tous les bets sur le même numéro gagnent) × 110% safety buffer.

**Formule** (RouletteLib) :
```
maxPayout = (maxStraight×36 + maxStreet×12 + max(red,black)×2 + max(odd,even)×2
             + max(low,high)×2 + max(dozen1,dozen2,dozen3)×3
             + max(col1,col2,col3)×3 + otherBetsPayout) × 110%
```

C'est une surestimation conservatrice car elle assume que tous les types gagnent simultanément (impossible — e.g., un nombre ne peut être à la fois rouge ET noir). Mais la surestimation est acceptable pour la solvabilité.

---

## 5. Recommandations Priorisées pour le Refactoring

### P0 — CRITICAL (à corriger avant tout déploiement mainnet)

| # | Action | Effort | Impact |
|---|---|---|---|
| 1 | **Fix H-03** : `_skipOrProcessSimpleBets` return `totalPayouts` au lieu de `0` en cas de skip | 1 ligne | Bug de payout incorrect |
| 2 | **Fix H-01** : Protection inflation ERC-4626 — augmenter `MINIMUM_FIRST_DEPOSIT` à 1e18 et/ou override `_decimalsOffset()` à 6 | 5 lignes | Sécurité vault |
| 3 | **Ajouter sanity checks dans `performUpkeep`** (C-01) : borner `totalPayouts <= pendingBets` | 10 lignes | Defense in depth |

### P1 — HIGH (à corriger avant launch)

| # | Action | Effort | Impact |
|---|---|---|---|
| 4 | **Résoudre la contradiction admin keys** (H-02) : soit hardcoder les fees, soit ajouter des bornes max strictes + timelock sur upgrades | Moyen | Crédibilité protocole |
| 5 | **Ajouter `ReentrancyGuardUpgradeable`** (C-02) sur les fonctions critiques de StakedBRB | 15 lignes | Defense in depth |
| 6 | **Minimum withdrawal amount** (M-01) pour éviter le queue griefing | 3 lignes | DoS prevention |

### P2 — MEDIUM (à planifier pour v2)

| # | Action | Effort | Impact |
|---|---|---|---|
| 7 | **Aligner les fee rates** de la doc, des tests, et du code | Config | Cohérence |
| 8 | **Implémenter la conversion BRBR → BRB** ou documenter son absence | Moyen | Tokenomics |
| 9 | **Indexer les events** (L-04) : `BetPlaced`, `WithdrawalRequested` | 5 lignes | Subgraph perf |
| 10 | **Event `WithdrawalCancelled`** distinct (L-05) | 5 lignes | Observabilité |
| 11 | **Renommer `BRBReferal` → `BRBReferral`** (L-01) | Renommage | Consistance |

### P3 — GAS / QUALITY (nice to have)

| # | Action | Effort | Impact |
|---|---|---|---|
| 12 | **Storage packing** `StakedBRBStorage` (G-01) — attention aux slots existants si déjà déployé | Moyen | ~20K gas/round |
| 13 | **Bet struct packing** `uint96 amount + uint8 number` (G-02) | Moyen | ~20K gas/bet |
| 14 | **Bitmap pour `isRedNumber`** (G-04) | 5 lignes | ~300 gas |
| 15 | **Fix assembly fragile** dans `_collectWinningPayoutsBatch` (G-05) | 3 lignes | Maintenabilité |
| 16 | **Ajouter des tests** : fuzz tests, invariant tests (pas d'invariant tests actuellement), fork tests Arbitrum | Élevé | Couverture |

### P4 — TESTING GAPS

Le repo a ~140 tests mais manque crucialement de :
- **Fuzz tests** sur les montants de bets, nombres aléatoires, multi-joueurs
- **Invariant tests** : `totalAssets >= pendingPayouts`, `feeSplit sum == 10000`, `BRB supply only decreases`
- **Fork tests** contre Arbitrum mainnet (VRF Coordinator réel)
- **Tests de re-entrancy** (même si BRB est vanille)
- **Tests edge case** : round avec 0 bets, maxPayout overflow scenarios, queue vide/pleine simultanément
- **Slither/Mythril** : aucun rapport d'analyse statique dans le repo

---

## Résumé Exécutif

| Sévérité | Count | Findings |
|---|---|---|
| Critical | 2 | C-01 (performData trust), C-02 (no reentrancy guard) |
| High | 3 | H-01 (inflation attack), H-02 (admin keys), H-03 (totalPayouts bug) |
| Medium | 5 | M-01 à M-05 |
| Low | 6 | L-01 à L-06 |
| Gas | 5 | G-01 à G-05 |

**Verdict** : L'architecture est bien pensée (EIP-7201, Chainlink Automation batching, ERC-4626). Le code est lisible et les patterns de sécurité principaux (CEI, access control, immutables) sont respectés. **Cependant**, le bug H-03 (totalPayouts reset) est un vrai bug fonctionnel à corriger immédiatement, la protection anti-inflation du vault est insuffisante (H-01), et la contradiction entre "no admin keys" et les fonctions admin réelles (H-02) mine la crédibilité du protocole. Le testing est correct mais manque de profondeur (pas de fuzz/invariant).
