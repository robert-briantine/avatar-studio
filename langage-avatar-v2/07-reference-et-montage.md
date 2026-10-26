# Étape 7 — Utiliser les références et valider le montage

[Étape précédente : composition](06-composition-sur-un-fond.md) · [Sommaire](spec.md) · [Étape suivante : saisie assistée](08-saisie-assistee-des-references.md)

## Objectif

Ajouter la commande `{Ref:Nom}` et afficher les ressources pendant la
narration, selon les mêmes règles que les images générées.

## Syntaxe et comportement

```text
{Ref:NomDeLaRessource} Texte à prononcer pendant son affichage.
```

1. Retrouver la ressource nommée et vérifier sa disponibilité.
2. Préparer son visuel, avec son éventuelle image de fond.
3. Remplacer la vidéo de l’avatar par ce visuel pendant les paroles associées.
4. Conserver la voix de l’avatar et le déroulement de la narration.
5. Rétablir la vidéo de l’avatar lorsque la commande `{}` apparaît.

Une nouvelle commande visuelle remplace l’affichage actif. Sans nouvelle
commande ni retour `{}`, la ressource reste affichée jusqu’à la fin de sa
narration, comme avec `{Image:Description}`.

Les règles existantes restent applicables : une commande `Ref` doit être
suivie de paroles. La commande, le nom de la ressource et son contenu visuel
ne sont pas envoyés au moteur vocal.

## Exemple complet

```text
Bonjour, voici notre démonstration.
{Ref:FondCours} Commençons par le support visuel.
{Ref:FormuleEnergie} Cette formule relie la masse et l’énergie.
{Ref:ExempleTypeScript} Voici maintenant un exemple de code.
{Ref:SchemaTraitement} Ce diagramme résume les étapes du traitement.
{} Nous pouvons poursuivre avec l’avatar.
```

Les quatre ressources remplacent successivement la vidéo de l’avatar,
chacune pendant ses paroles associées. L’avatar redevient visible après `{}`.

## Intégration au montage

- Utiliser les repères de la narration pour déterminer les débuts et fins
  d’affichage des ressources.
- Préserver la bande sonore pendant les changements de visuel.
- Appliquer le comportement dans l’aperçu et dans la vidéo finale.
- Vérifier les références et leurs rendus avant les calculs de montage.
- Conserver le fonctionnement des commandes `Texte`, `Latex`, `Image`, `File`
  et du retour `{}`.

## Scénarios de validation

| Scénario | Résultat attendu |
| --- | --- |
| Référence à une image générée | L’image enregistrée remplace l’avatar pendant les paroles associées. |
| Référence à une formule | La formule rendue est affichée pendant la narration. |
| Référence à du code TypeScript | Le code reste lisible, avec la coloration de Monaco Editor. |
| Référence à un diagramme | Le diagramme et ses libellés sont correctement affichés. |
| Formule, code ou diagramme avec fond | L’image référencée est derrière le contenu. |
| Plusieurs ressources utilisant la même image | Le fond enregistré est réutilisé dans chaque composition. |
| Deux commandes `Ref` successives avec leurs paroles | Le second visuel remplace le premier au bon repère audio. |
| Retour `{}` après une ressource | La vidéo de l’avatar reprend avec la suite des paroles. |
| Référence sans retour `{}` | La ressource accompagne la narration jusqu’à la fin du scénario. |
| Nom vide, inconnu ou ressource indisponible | Une erreur compréhensible est signalée avant le montage. |
| Commande `Ref` sans paroles | Le scénario est refusé selon les règles du langage existant. |
| Anciennes commandes mêlées à des références | Les affichages, les paroles et les éventuels sons des fichiers restent synchronisés. |

## Résultat attendu

L’utilisateur peut préparer ses ressources dans les éditeurs, vérifier leurs
aperçus, puis les appeler par leur nom dans un scénario. La vidéo affiche le
contenu demandé pendant que l’avatar continue la narration.

## Implémentation réalisée

Les quatre types de ressources sont utilisables avec `{Ref:Nom}` dans
l’aperçu vidéo et la vidéo finale, y compris avec les compositions de
l’étape 6. Le montage réutilise le PNG enregistré, sans régénérer l’image ni
le contenu de la ressource. Les visuels sont ajustés sans déformation ni
recadrage ; les zones transparentes et les marges reposent sur un fond blanc
pour préserver la lisibilité des formules et des diagrammes.

### Résolution et disponibilité

Les noms sont recherchés sans distinction de casse, après normalisation
Unicode. Les espaces autour du nom sont ignorés. La commande reste
orthographiée `Ref`. Comme pour les autres commandes, des accolades échappées
permettent de prononcer littéralement une référence sans l’interpréter.

Avant la génération vocale, les lots et chaque montage, le serveur vérifie
toutes les références : existence de la ressource, contenu enregistré,
disponibilité du fond éventuel et décodage du PNG. Un brouillon, une ancienne
description de diagramme non convertie ou un fichier manquant ou corrompu
produit une erreur en français avec le nom concerné. Les calculs vocaux et
vidéo ne démarrent pas et les médias précédents restent conservés.

La voix enregistrée contient les identifiants des ressources associées aux
noms du scénario. Après un renommage ou un redémarrage du serveur, elle
retrouve donc les mêmes ressources. Un nouveau scénario utilise les noms
actuels. Si une ressource liée devient introuvable, la création de la vidéo
échoue ; une autre ressource ayant repris son nom ne la remplace pas.
Les voix anciennes sans associations enregistrées utilisent la recherche
par nom.

Chaque nouveau montage reprend les derniers visuels enregistrés et en
prépare une copie temporaire avant les calculs d’image ou d’avatar. Une
modification pendant le calcul ne change pas les réutilisations de cette
copie dans la vidéo. Les vidéos déjà créées restent dans l’historique.

### Aperçu du scénario

Le bouton **Vérifier et prévisualiser le scénario** affiche le texte qui
sera prononcé, puis la liste des séquences avec les vignettes des références.
Il vérifie aussi les anciennes commandes, les fichiers et les incrustations,
sans lancer de synthèse vocale ni de génération vidéo. Une modification
du texte efface l’aperçu ; une réponse ancienne ne remplace pas le résultat
du scénario courant.

`POST /api/script/preview` reçoit `{ "text": "…" }` et renvoie la source,
la narration et les séquences. Pour chaque séquence `ref`, les métadonnées
de la ressource comprennent son identifiant, son nom actuel, son type et
son URL d’aperçu. Aucun chemin local de stockage n’est exposé. Les erreurs
de validation répondent en HTTP 400.

Cet aperçu présente l’ordre et le contenu des séquences. Les durées réelles
sont mesurées lors de la génération vocale. La modale de sélection à la
saisie de `{Ref:` relève de l’étape 8.

### Synchronisation et assemblage

Les repères vocaux mesurés déterminent les changements de visuel. Le montage
respecte les limites cumulées des images vidéo à 16 images/s, sans décalage
progressif entre les séquences. La bande sonore reprend la narration
originale et, avec `{File:…}`, les sons insérés avant les paroles associées.
Les références suivent les mêmes décalages que les autres visuels.

Seuls les passages où l’avatar est visible sont calculés par Wan. Une vidéo
composée uniquement de références et de narration n’utilise ni génération
d’image ni génération d’avatar. Le retour `{}` et les commandes `Texte`,
`Latex`, `Image` et `File` conservent leur comportement, même lorsqu’une
description d’image et un nom de référence sont identiques.

### Vérification

```sh
npm run build
npm test
```

La suite complète passe avec **142 tests**. Les tests de cette étape couvrent
la syntaxe, les quatre types, les fonds partagés, les brouillons, les visuels
invalides, les renommages avec redémarrage et les erreurs avant mutation de
l’historique. Des vidéos sont réellement assemblées par FFmpeg : les images
décodées, les limites d’affichage et les fréquences de la piste sonore sont
comparées aux entrées. Les essais incluent un mélange des anciennes commandes
et des références, une vidéo sans passage d’avatar, l’annulation et la
conservation d’une sortie existante après un échec.

Les parcours API de synthèse et Wan sont vérifiés avec des services simulés,
en conservant l’assemblage vidéo réel. Le test Wan contrôle que seuls les
extraits vocaux où l’avatar est visible lui sont transmis ; il ne constitue
pas un nouvel essai d’inférence GPU.

Le parcours Chrome vérifie les quatre vignettes, l’exclusion des commandes
du texte parlé, les erreurs de référence, les réponses retardées, les
accolades échappées et l’affichage mobile sans débordement horizontal.
