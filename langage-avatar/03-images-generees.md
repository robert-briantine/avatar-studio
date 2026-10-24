# Étape 3 — Générer et réutiliser des images

[Étape précédente : texte et LaTeX](02-texte-et-latex.md) · [Sommaire](AvatarDefinition.md) · [Étape suivante : fichiers locaux](04-fichiers-locaux.md)

## Objectif

Remplacer temporairement la vidéo de l’avatar par une image générée, tout en
conservant sa voix pour la narration associée.

## Génération et conservation

La commande `{Image: contenu}` utilise le contenu comme description de l’image
à générer. Ce contenu sert également de clé de réutilisation.

Le traitement suit cet ordre :

1. Chercher si une image est déjà associée à un contenu identique.
2. Si elle existe, réutiliser cette image.
3. Sinon, générer l’image et l’enregistrer sur disque.
4. Enregistrer sur disque l’association entre le contenu et l’image afin de
   pouvoir la retrouver lors d’une utilisation ultérieure.

Le dictionnaire d’associations doit donc persister au-delà de la génération
en cours. La règle de réutilisation porte sur un contenu identique ; aucune
recherche par similarité n’est définie.

## Exemple

```text
Bonjour, voici une belle image. {Image: une licorne} C’est une licorne. {} J’aime les licornes.
```

Le résultat comporte trois séquences :

| Ordre | Visuel | Son |
| --- | --- | --- |
| 1 | Vidéo de l’avatar qui parle | « Bonjour, voici une belle image. » |
| 2 | Image générée ou réutilisée pour « une licorne » | Voix de l’avatar : « C’est une licorne. » |
| 3 | Vidéo de l’avatar qui parle | « J’aime les licornes. » |

## Résultat attendu

Deux séquences vidéo distinctes montrent l’avatar en train de parler. Entre
elles, l’image remplace son visage pendant toute la narration associée.
La commande `{}` rétablit ensuite la vidéo de l’avatar avec sa voix.

## Implémentation de l’étape 3

L’étape 3 fonctionne dans l’aperçu vidéo et dans le montage final Wan2.2-S2V +
Extend. La voix est mesurée par portion dès qu’un scénario contient une commande
de texte, de LaTeX, d’image ou, depuis l’étape 4, de fichier. Les repères
`scriptTimings` du fichier vocal déterminent
la durée de chaque passage. Les anciennes voix contenant uniquement des
commandes `Image`, sans ces repères, doivent être régénérées avant le montage.

Les images manquantes sont générées avec le générateur Qwen-Image de
l’application, depuis la description de la commande, en 1472 × 1104 pixels.
Elles sont préparées avant les passages Wan. Si plusieurs commandes partagent
la même description, une seule image est préparée.

Le montage regroupe les portions consécutives où l’avatar est visible. Chaque
groupe reçoit son extrait audio et produit une vidéo distincte. Les passages
d’image utilisent une image fixe pendant la narration correspondante. Une vidéo
composée uniquement d’images n’exécute aucun calcul Wan.

Toutes les séquences partagent les dimensions et la cadence de sortie. L’image
est ajustée au cadre en conservant ses proportions, avec des bandes noires si
nécessaire. Les changements de visuel suivent les bornes audio, à la précision
d’une image vidéo. Le nombre d’images est calculé à partir des bornes cumulées
pour éviter une dérive à chaque raccord.

Pour les scénarios de cette étape, le montage reçoit ensuite le WAV complet
d’origine en une seule fois : les
coupures utilisées pour générer les passages d’avatar ne coupent pas la bande
son finale. Les incrustations de texte et de LaTeX des autres séquences restent
actives selon leurs propres repères.
L’étape 4 insère également le son des fichiers vidéo et décale les visuels
suivants, tout en conservant l’ensemble des paroles.

## Dictionnaire persistant

Le cache est partagé entre les avatars du même serveur, dans
`DGX_AVATAR_DATA_DIR/script-images`. Sans configuration spécifique, il se trouve
dans `~/dgx-avatar-studio-data/script-images`, en dehors du code de l’application.

- `index.json` contient une version de format (`1`) et une liste `images`.
- Chaque entrée associe `content`, `filename` et `createdAt`.
- Le nom PNG est le SHA-256 du contenu ; la description n’est jamais utilisée
  comme chemin de fichier.
- La clé correspond au contenu analysé : seuls les espaces autour du contenu
  sont retirés par l’analyseur. La casse, les accents et les espaces intérieurs
  restent significatifs.
- Les écritures du dictionnaire sont sérialisées et remplacent le fichier par
  renommage. Les demandes simultanées d’un même contenu partagent sa génération.
- Un fichier PNG absent ou corrompu est régénéré. Une erreur de génération ou
  un résultat illisible ne crée pas d’entrée valide dans le dictionnaire.

Un dictionnaire JSON illisible ou de format invalide produit une erreur
explicite au démarrage. Les images déjà créées restent dans le cache si un
montage ultérieur échoue, afin de pouvoir les réutiliser.

## Vérification

```sh
npm run build
npm test
```

Les tests couvrent la réutilisation après redémarrage, les requêtes simultanées,
les images manquantes ou corrompues, les échecs, l’annulation, les bornes vidéo,
le retour à l’avatar et le montage sans calcul Wan pour un scénario d’images
seules. Le test Wan mixte vérifie que seuls les deux passages d’avatar sont
calculés, avec les bons extraits audio. ComfyUI et le TTS sont simulés dans les
tests de bout en bout.
