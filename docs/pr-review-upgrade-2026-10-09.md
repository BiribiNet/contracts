# Revue des PR et upgrade — 9 octobre 2026

Réseau : Arbitrum Sepolia, chainId 421614. Aucune transaction sur mainnet.

Version déployée : `df898f08c8eb822dd772903f01d25fad6e5d251f`. Les PR #39–42 et #45 ont été intégrées et poussées sur master avant le déploiement.

## Résultat onchain

Cinq transactions confirmées. Frais : 0.000577188710669367 ETH. Neuf bibliothèques réutilisées, une bibliothèque redéployée. Les paramètres du funder sont conservés, les anciens soldes USDC/DAI/BRB sont nuls et les dettes BRB du nouveau funder sont couvertes.

| Élément | Adresse |
|---|---|
| Proxy moteur conservé | `0x7eb8110d9e84d3c32fa6468d13ea2bc81544acf1` |
| Nouvelle implémentation moteur | `0x2bDeaA54d941BCF873C2e89fa74bDB3a1bc10a77` |
| Nouveau funder actif | `0xfB5075174cb85aDfBf0A4E946840CbFD03bF48a2` |
| Nouvelle RouletteUpkeepScanLib | `0xdB94aEF1e9ED5327FdFdfE18719a5e5fFc253F54` |

Les trois nouveaux contrats sont vérifiés sur Arbiscan. Les bytecodes et bibliothèques correspondent aux artefacts de la version déployée. SideBet, les vaults et TipJar sont inchangés. Treasury et Receiver sont conservés pour les raisons de migration décrites dans le rapport initial.

Au bloc 317423499, round courant 2040, 4 événements VRF/règlement/financement observés depuis l’upgrade, et 1 tentative de financement confirmée. Pas de VRF en attente au moment de ce contrôle.

## PR examinées

| PR | Décision | Motif |
|---|---|
| #39 | Déployée | Termine tous les chunks jackpot avant clôture du round ; traite l’absence de mises éligibles. |
| #40 | Déployée | Protège les rapports jackpot seuls contre le replay sans changer le tuple Job. |
| #41 | Déployée | Conserve un échantillon TWAP exploitable et tient compte du prix exécutable. |
| #42 | Déployée | Suit les dettes treasury/burn, permet leur retry et protège les montants réservés du sweep. |
| #45 | Outils intégrés | Probabilités exactes et migration de prix ; aucun changement Solidity. |
| #43 | Non déployée | Change les frais SideBet par ticket, avec un impact significatif sur la marge LP. |
| #46 | Non déployée | Ajoute une file asynchrone et impose une tâche de financement périodique supervisée. |
| #47 | Non déployée | PR draft, fonctionnalités volontaires de limites et auto-exclusion avec dépendances UI/indexer. |
| #9 | Non intégrée | Ancienne PR en conflit visant StakedBRB, hors architecture BankVault déployée. |

## Changement distant pendant le travail

La PR #48 a ensuite fusionné #43/#46 dans master (`7dc9bb6`). Ce nouveau master a été récupéré localement. Il dépasse la version actuellement déployée. Son activation attend une décision sur la politique de frais et la mise en service du worker. Aucun collecteur nécessitant queueFunding n’a été activé contre un ancien funder.

Le worker peut être une tâche cron Cloudflare, pas nécessairement un processus permanent. Le dépôt cre-automation-starter possède déjà un Worker Cloudflare, mais aucun cron de financement n’est installé par la PR #46. Sans cette tâche, les règlements joueurs continuent et les nouveaux frais restent en file, sans conversion/distribution. Voir docs/distribution-v2.md.

## Validation et configuration

- 150 tests ciblés réussis sur la version déployée, compilation et typecheck économie réussis.
- Stockage inchangé : moteur 44 champs, SideBet 11, BankVault 14.
- Répétition complète réussie sur un fork au bloc 317419003 : état capturé préservé, cinq transactions simulées.
- Migration de prix #45 simulée sans transactions : 27 nouvelles configurations proposées, 18 activables en DAI/BRB, 9 USDC bloquées par la liquidité. Les 27 configurations actuelles restent inchangées ; aucun repricing ni catalogue X100 activé.
- Manifestes indexer locaux actualisés, historique des trois funders conservé. Graph codegen/build réussis. Ces changements indexer ne sont pas encore publiés.

## Preuves

- deployments/pr-rollout-2026-10-09-live.json : transactions et adresses.
- deployments/pr-rollout-2026-10-09-fork.json : répétition.
- deployments/pr-review-before-2026-10-09.json et pr-review-after-2026-10-09.json : comparaison bytecode au commit déployé.
- deployments/pr-storage-check-2026-10-09.json : compatibilité du stockage.
- deployments/pr-verification-2026-10-09.json : vérifications Arbiscan.
- deployments/pr-final-checks-2026-10-09.json : reçus, coûts, paramètres et activité.

## Mise à jour ultérieure : activation x100

Le catalogue x100 initialement laissé en simulation a été activé à la demande
de l'utilisateur le 9 octobre 2026 : 132 variantes ajoutées, 88 jouables en
DAI/BRB et 44 USDC fermées faute de liquidité. Ancien catalogue et implémentations
conservés. Voir [le rapport d'activation](x100-activation-2026-10-09.md).
