# Contrôle de l'upgrade des paris par masque

Campagne commencée le 15 novembre 2026, complétée le 18 novembre. Contrats testés :
`d2fb7981f6aeafea22c9683d8871badc3fa04c6e`, après les PR [61](https://github.com/BiribiNet/contracts/pull/61)
et [62](https://github.com/BiribiNet/contracts/pull/62), déjà mergées.

**Le stockage est compatible dans les contrôles exécutés. Le plafond historique de 448 jambes ne
respecte pas la cible de gaz sur tous les chunks. La répétition complète passe avec 384 jambes.**

## Stockage et état

Fork Arbitrum One épinglé au bloc **524517798**, exécuté sur Hardhat, chain ID 31337.

- Moteur : les 45 champs existants gardent leurs positions et types, y compris les structures mappées
  et les strides de tableaux ; cinq champs sont ajoutés en fin de namespace ERC-7201.
- Vault : les 14 champs gardent leurs positions et types. `sideBetController` devient
  `_deprecatedSideBetController`, toujours de type `address` au même emplacement.
- Deux répétitions : état réel inchangé, puis état peuplé de dépôts, retraits en attente et paris
  classiques placés sous les anciennes implémentations.
- Les snapshots avant/après sont identiques. Les traces des deux upgrades n'écrivent que le pointeur
  EIP-1967 du moteur et le slot d'implémentation du beacon, respectivement.
- Les paris et retraits anciens se règlent après l'upgrade. Les masques sont initialement désactivés.
- Les 37 numéros sont réglés sur BRB, USDC et DAI, soit **111 cas de marché**, avec paiements exacts
  pour des masques de 2, 24, 25 et 35 numéros mélangés à un pari classique.

Le runtime du moteur en place correspond à la source de référence `86d2b97`, après contrôle de ses
46 dépendances et normalisation des immuables/métadonnées. La reconstitution du vault a été recompilée :
le runtime archivé correspond après substitution des deux constantes de noms inconnus déjà documentées
(sélecteur d'erreur et topic d'événement).

## Régression découverte sur le budget de gaz

Mesure du scheduler réellement déployé : 1 lane, 60 paiements par appel, trois marchés participants.
Tous les chunks sont atteints via les paiements normaux, sans harness ni modification des curseurs.

| Plafond par marché | Pire `checkUpkeep`, gaz internes | Paiements | Cible interne de 1,5 M |
|---|---:|---|---|
| 448 | 1 520 395 | Corrects | Dépassée |
| 384 | 1 359 415 | Corrects | Respectée |

L'intrinsèque de l'`eth_call` vient en supplément. La limite effective du RPC keeper en production n'a
pas été confirmée par cette campagne. À 448, le pire cas est un chunk complet de 60 gagnants,
pas la toute dernière ligne isolée mesurée par le test de budget historique.

**Point restant dans le code de release :** le garde du script d'activation et le modèle de gaz du
bilan hebdomadaire conservent la recommandation historique de 448. Ils doivent être corrigés ou leurs
hypothèses validées avant de suivre une recommandation supérieure à 384. La proposition unsigned
jointe donne explicitement 384 ; aucune activation n'a été envoyée.

## Validation

- Compilation réussie, artefacts identiques au verrou de release.
- Régression complète : **608 passing, 13 pending, 0 failing**. Les tests optionnels non activés
  restent distincts de la répétition fork exécutée ici.
- Tests Node de preflight, release, ABI, bilan d'usage et incident : **64 passing, 0 failing**.
- Tailles runtime : moteur 23 130 octets, vault 15 038, sous EIP-170 ; le fork refuse les contrats trop grands.
- Fork à 384 : plafond accepté sur les trois marchés, jambe 385 rejetée, drain bloqué pendant les mises,
  callback VRF sous son budget, paiements exacts et ouverture du round suivant.
- Les soldes de joueurs/LP dans les ERC20 externes servent de fixture locale. Aucun stockage du protocole
  n'a été écrasé pour produire un résultat.

Les premiers essais de charge ont également révélé deux contraintes du banc de test : la latence RPC
épuisait la fenêtre de 60 secondes, et les RPC publics interrompaient certaines lectures historiques.
Les blocs de placement sont désormais cadencés à une seconde, sans changer `ROUND_DURATION` ; le relais
de lecture réessaie les requêtes, réutilise le cache et confronte le hash du bloc au RPC source.

## Artefacts et suite

- [Rapport complet à 384](report.json), [contre-exemple à 448](cap-448/report.json), [synthèse des checks](checks.json).
- [Source du moteur en place](engine-baseline-proof.json), [recompilation du vault](vault-reconstruction.log).
- [Plan mainnet en lecture seule](mainnet-plan.json), [proposition d'activation à 384](activation-proposal.json).
- [Régression complète](full-regression.log), [log du fork](fork.log).

**Aucune transaction mainnet envoyée.** Le plan conserve les masques désactivés après l'upgrade.
Le signataire admin n'est pas configuré dans cette session. Les nonces, implémentations et conditions
du preflight doivent être relus lors de l'exécution ; la proposition d'activation n'est applicable
qu'après installation et vérification des nouvelles implémentations.

Reproduction complète (dépendances et artefacts de release installés) :

```sh
corepack yarn hardhat compile
MASK_FORK_BLOCK=524517798 MASK_FORK_LEG_CAP=384 corepack yarn hardhat run --no-compile \
  --config hardhat.fork-only.config.ts scripts/rehearseMaskBetsMainnetFork.ts
```

`ARBITRUM_FORK_URL` peut fournir un RPC à l'opérateur ; l'URL n'est pas archivée.
`MASK_FORK_REPORT_DIR` choisit le dossier de sortie, `MASK_FORK_GATEWAY_PORT` le port local (18551 par défaut).
Pour reproduire le dépassement, utiliser `MASK_FORK_LEG_CAP=448` ; l'assertion de budget doit échouer.
