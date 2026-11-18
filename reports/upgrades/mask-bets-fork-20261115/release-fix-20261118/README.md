# Correctif de lancement des masques, 18 novembre 2026

Le plafond de lancement partagé est ramené à **352 jambes par marché et par round**. Les demandes
supérieures sont refusées par défaut. La dérogation manuelle existante exige de nouvelles mesures
complètes et la confirmation du budget RPC keeper.

Le moteur et le vault conservent leurs artefacts de release : ce correctif porte sur les scripts,
leur modèle de recommandation et les tests. Aucun upgrade mainnet ni aucune activation n'a été envoyé.

## Le cas manqué par l'ancien test

Le test de budget ne mesurait que la dernière ligne gagnante d'une lane. Il parcourt maintenant
tous les débuts de chunks, plus cette dernière ligne. Un préfixe de paris classiques est aligné
pour que le dernier masque soit payé dans un **chunk complet**, pas un petit reliquat.

| Jambes | Configuration | Pire gaz interne mesuré | Budget interne de 1,45 M |
|---|---|---:|---|
| 352 | 1 lane / 60 paiements | 1 383 449 | Respecté |
| 352 | 10 lanes / 10 paiements | 1 188 501 | Respecté |
| 384 | 1 lane / 60 paiements | 1 474 821 | Dépassé |
| 448 | 1 lane / 60 paiements | 1 645 745 | Dépassé |

L'intrinsèque de l'`eth_call` vient en supplément. Le précédent fork à 384 était fonctionnel dans
son scénario, mais ne couvrait pas ce mélange aligné. Il laissait donc une marge surestimée.

Le [profil de gaz](../../../mask-bets-v1/full-chunk-gas-profile.json) contient les mesures tous les
32 masques, pour les deux configurations. Le bilan d'usage prend le point supérieur, conserve une
enveloppe monotone et ajoute 25 k de marge interne plus 25 k d'intrinsèque. Il ne recommande rien
au-delà de 352, même avec un grand budget RPC. Un profil incomplet ou dont le SHA-256 du verrou de
release ne correspond plus bloque le bilan.

## Validation

- 66 tests Node de release, garde d'activation, bilan, ABI et incident passent.
- 25 tests ciblés d'upgrade et de layout passent.
- 4 régressions de chunks complets passent, dont les contre-exemples 384 et 448.
- 38 tests smoke de stockage, calculs de paiements, cycle E2E, VRF et compatibilité passent.
- [Fork complet à 352](fork-352/report.json) : 111 cas de marché, paiements exacts, état conservé,
  jambe 353 rejetée et drain bloqué pendant les mises. Pire `checkUpkeep` de ce scénario : 1 301 351 gaz.

Le [benchmark du candidat 384](candidate-384-full-curve.log) conserve le constat initial : son échec à 384
est le constat qui a conduit à choisir 352. Les régressions finales valident explicitement ce dépassement.

La régression complète antérieure de 608 tests reste archivée dans le dossier parent ; elle n'est
pas présentée comme une nouvelle exécution complète du correctif.

## Artefacts

- [Synthèse](checks.json), [régressions de gaz](full-chunks.log), [tests Node](node-checks.log),
  [tests upgrade/layout](upgrade-storage.log), [smoke](smoke.log).
- [Plan d'upgrade unsigned](mainnet-plan.json) : masques livrés désactivés.
- [Proposition d'activation à 352](activation-proposal.json), applicable après vérification des nouvelles implémentations.

La limite RPC keeper effective reste à confirmer pour l'exécution. Les mesures décrivent les
scénarios testés ; le modèle n'extrapole plus vers des volumes non validés.
