# Revue et mises à jour — Arbitrum Sepolia, 9 octobre 2026

Le dépôt des contrats a été mis à jour par `git pull --ff-only` jusqu'au commit
`a610335`. Le réseau traité est **Arbitrum Sepolia (421614)**, identifié par le
manifeste actif du projet. Aucun déploiement sur Arbitrum One n'a été effectué.

## Changements confirmés

| Composant | Adresse | Opération |
| --- | --- | --- |
| RouletteEngine | `0x08b5C4E146b2dF4907c0ac27843d700281d1F8CD` | Nouvelle implémentation et upgrade UUPS du proxy existant |
| BankVault4626 | `0xea45De4C6adD20979db76D13dCc56a3724e64CbA` | Nouvelle implémentation et upgrade du beacon commun aux trois banques |
| SideBet | `0xC2efc646F99588fe7C767Adb6f76b0544FC41E62` | Upgrade du code ; conservation des paris, configs, réserves et timeout |
| SideBetChallengeEvaluator | `0x276922aAa2573A3A934287Dec666C3494b8841eE` | Créé par le constructeur SideBet, avec les paramètres viaIR de ce build |
| BRBJackpotFunder | `0x6aF569259B87ef2AE4998436047fdFAfaEeDc7d9` | Nouveau contrat raccordé au moteur ; paramètres de l'ancien préservés |
| TipJar | `0xD8B67354374c41E6ED7494D404b0e8D27167031D` | Nouveau routeur BRB indépendant, token et destinataire vérifiés |

Les proxies moteur (`0x7eb8110d9e84d3c32fa6468d13ea2bc81544acf1`) et SideBet
(`0xA0DCb8FCEd50EeD13899Af86DE70FcE42897E8B1`), les banques et le scheduler
conservent leurs adresses. Le scheduler et son câblage correspondent au manifeste.
L'ancien funder ne détenait aucun des actifs des marchés au contrôle de migration.

Les **19 transactions** du journal ont toutes un reçu réussi. Leurs frais cumulés
sont **0,00153871738415322 ETH**. Un nonce périmé du RPC a interrompu l'envoi
après les upgrades moteur et banques ; la reprise a réutilisé les déploiements
confirmés et utilisé une gestion séquentielle des nonces.

## Vérification

- Compilation Solidity réussie ; 25 tests TipJar/x100 et 151 tests de régression réussis.
- Sources des anciennes implémentations récupérées depuis l'explorateur et recompilées.
- Contrôle récursif des champs, offsets et types de stockage existants : moteur 40 → 44
  champs, SideBet 11 → 11, banques 11 → 14 ; espaces de stockage conservés.
- Simulation de 19 transactions sur un fork de l'état réel au bloc `317412036`.
- Après upgrade, comparaison du bytecode des implémentations, bibliothèques liées,
  évaluateur et TipJar avec leurs builds exacts ; adresses liées et immutables traités
  séparément. Les deux contrats volontairement conservés ci-dessous restent différents.
- Préservation des soldes, parts, liquidités verrouillées, réserves, nombres de paris et
  configurations, timeout et adresses contrôlés pendant l'upgrade.
- Des événements réels postérieurs à l'upgrade prouvent la poursuite des demandes VRF,
  résultats, règlements et tentatives de financement du nouveau funder. Le rapport final
  contient les hashes, notamment les cycles des rounds 2031 et 2032.
- La souscription VRF contient environ 59,21 LINK au contrôle et référence toujours le moteur.
  Ce solde ne constitue pas une garantie de financement futur.

Les **16 contrats et bibliothèques déployés**, y compris l’évaluateur créé par SideBet,
sont vérifiés sur Arbiscan. Les résultats complets sont dans
`deployments/verification-complete-2026-10-09.json`.

## Éléments restant à traiter

**JackpotTreasury** : l'ancienne trésorerie contient encore le jackpot. Elle est
non upgradeable et ne propose pas de transfert administratif du pool. La remplacer
sans mécanisme de migration validé abandonnerait ce solde. Son adresse a été conservée.
La nouvelle implémentation moteur conserve ses protections sur les montants du jackpot.

**AutomationReceiver** : le contrat actuel est non upgradeable ; le nouveau code durcit
notamment les métadonnées. Un remplacement nécessite de rediriger les workflows CRE
réellement déployés et de coordonner les autorisations. Aucune configuration privée de
workflow live n'a été modifiée. Le forwarder actuel est non nul et le scheduler autorisé.

**TipJar** : le contrat est déployé, mais son utilisation par le frontend n'a pas été
activée. Le manifeste local `../subgraph/subgraph.tips.yaml` est généré et compile.
Il faut déployer/réconcilier l'indexeur, puis activer l'adresse frontend suivant `TIPS.md`.
Le nouveau funder est enregistré dans le manifeste et l'ancien conservé comme source
historique ; ces modifications locales d'indexation ne publient pas l'indexeur live.

**Catalogue x100** : le dry run prévoit 132 nouvelles configurations, dont 88 activables
en DAI/BRB. Les 44 USDC resteraient fermées : environ 10,95 USDC de liquidité disponible
au contrôle, insuffisants pour la mise minimale de 1 USDC et les limites du script.
Aucune configuration n'a été créée ni activée. L'activation suppose également un frontend
compatible déployé ; aucun apport de liquidité n'a été effectué.

Le RPC privé configuré répond `Unauthorized`. Les opérations ont utilisé les RPC publics
Arbitrum Sepolia. Ce paramètre privé reste à corriger pour les futures opérations.

## Pièces conservées

- `deployments/rollout-2026-10-09-live.json` : adresses, bibliothèques, arguments et reçus.
- `deployments/tip-jar-arbitrumsepolia.json` : métadonnées confirmées de TipJar.
- `deployments/live-audit-2026-10-09.json` et `post-audit-2026-10-09.json` : comparaison avant/après.
- `deployments/storage-check-2026-10-09.json` et `rehearsal-2026-10-09.json` : contrôles préalables.
- `deployments/final-checks-2026-10-09.json` : reçus, frais, VRF, activité après upgrade et limites.
- `deployments/verification*.json` : résultats de publication des sources sur Arbiscan.

Les changements et rapports sont locaux ; aucun commit ni push n'a été effectué.

## Mise à jour ultérieure : activation x100

Le catalogue x100 initialement laissé en simulation a été activé à la demande
de l'utilisateur le 9 octobre 2026 : 132 variantes ajoutées, 88 jouables en
DAI/BRB et 44 USDC fermées faute de liquidité. Ancien catalogue et implémentations
conservés. Voir [le rapport d'activation](x100-activation-2026-10-09.md).
