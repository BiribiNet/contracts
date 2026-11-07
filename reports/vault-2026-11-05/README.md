# Vault `0x6e84c0ED4056bA6E94dFF5008aBE811738f8f3cC` — source reconstitué

Implémentation `BankVault4626` installée par l'administrateur `0x9041…3Ebce` derrière le beacon
`0x7b23…632b` le 05/11/2026 à 13:04 UTC (bloc 521 482 387, tx `0xb63c808c…dbe0`, déployée au nonce 304).
Son source n'était dans aucun dépôt. Il a été reconstitué à partir du runtime, en partant de
`contracts/BankVault4626.sol` de `master` (implémentation précédente `0x129c…797D`).

## Résultat

**Correspondance octet pour octet, trailer CBOR compris, à deux identifiants près.** Deux constantes du runtime
sont des hachages de noms qu'on n'a pas pu retrouver : le sélecteur d'erreur `0xe3ee11df` et le topic d'événement
`0xdebd20cf…`. Les noms des autres ajouts ont été retrouvés par recherche au dictionnaire : `WithdrawalQueueNotEmpty`,
`WithdrawalTooSmall`, `FlatWithdrawFeeUpdated`, `setFlatWithdrawFee`.

- Si l'on remplace ces deux constantes dans le runtime compilé, on obtient exactement le runtime on-chain.
- Sans ce remplacement, les deux runtimes ne diffèrent que sur ces 36 octets.
- Le dispatcher on-chain route exactement l'ABI du source reconstitué : 56 fonctions.
- Le layout ERC-7201 est identique à celui du vault précédent, avec les 14 champs. Aucun slot ordinaire n'est utilisé.

## Différences par rapport à `0x129c…797D`

Une seule fonction externe a été ajoutée, `setFlatWithdrawFee`. Elle s'accompagne de **cinq changements de
comportement** dans des fonctions existantes. Aucune fonction n'a été retirée.

| # | Où | Changement |
|---|---|---|
| 1 | `setFlatWithdrawFee(uint256)` (`0x5ec07897`) | Réservée à `BANK_ADMIN_ROLE`. Revert `ZeroAmount()` pour 0 et `WithdrawalQueueNotEmpty()` si la file contient une demande. Émet `FlatWithdrawFeeUpdated(ancien, nouveau)`. |
| 2 | `deposit` / `mint` | Revert `DepositTooSmall()` si `assets == 0` ou `convertToAssets(balanceOf(receiver)) + assets <= fee`. Avant : `assets <= fee`. Un complément inférieur aux frais est donc accepté. |
| 3 | `_enqueueWithdrawal` | Revert `WithdrawalTooSmall()` si la demande vaut au plus les frais. |
| 4 | `_processQueue`, branche « destinataire refusé » | Les frais sont prélevés **en parts** : `min(previewWithdraw(fee), shares)` parts sont transférées du propriétaire à infra, puis l'événement `0xdebd20cf…` est émis avec `(requestId, owner, infra, parts, fee)`. |
| 5 | `_update` (override) | Un propriétaire qui a une demande en file ne peut pas transférer ses parts (revert `0xe3ee11df`). Le mint, le burn, les auto-transferts et les montants nuls ne sont pas concernés. |
| 6 | `drainWithdrawalQueue` | Nouveau premier garde : `lockedBetLiquidity != 0` ⇒ `WithdrawalBlockedDuringResolution()`. **La fonction reste publique** : son sélecteur `0x00e4a032` est encodé en `PUSH3 e4a032`. |
| 7 | `lockSideBetStake` | Verrouille `stake` au lieu de `payoutReserve`. Sans effet tant que SideBet est désactivé ; cette fonction disparaît avec la PR #61. |

## Fichiers

| Fichier | Contenu |
|---|---|
| `BankVault4626.sol` | Source reconstitué ; les changements sont commentés `0x6e84:` |
| `compiler-input.json` | Entrée standard-JSON : sources et réglages de `reports/incident-2026-11-04/compiler-inputs/BankVault4626-clean.json` |
| `abi.json` | ABI du source reconstitué |
| `onchain-runtime-0x6e84c0ed.hex` | `eth_getCode` archivé |
| `match.json` | Hachages (source, entrée, runtimes), substitutions, layout, bloc de lecture |

## Vérification

Compilateur : solc 0.8.27+commit.40a35a09 natif (le même que les scripts d'incident). Réglages : optimizer runs 1,
viaIR désactivé, cancun, `bytecodeHash: none`.

```bash
node scripts/verifyVault20261105.cjs            # compile et compare avec eth_getCode (RPC public ou ARBITRUM_RPC_URL)
node scripts/verifyVault20261105.cjs --offline  # compare avec le runtime archivé
```

Les noms ont été recherchés au dictionnaire, jusqu'à quatre ou cinq mots parmi un vocabulaire de 30 à 130 termes.
Si l'administrateur fournit les deux noms manquants, il suffit de les reporter dans `BankVault4626.sol` (ici et dans
`contracts/`) et dans `UNRESOLVED_NAMES` : la vérification doit alors afficher `EXACT MATCH`.
