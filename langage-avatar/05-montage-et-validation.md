# Étape 5 — Assembler et valider le résultat

[Étape précédente : fichiers locaux](04-fichiers-locaux.md) · [Sommaire](AvatarDefinition.md)

## Objectif

Assembler les séquences dans l’ordre du scénario et vérifier que chaque visuel
accompagne la bonne portion de narration.

## Ordre de traitement

1. Lire le scénario et séparer les commandes du texte à prononcer.
2. Identifier les séquences standard, les incrustations et les médias insérés.
3. Préparer les visuels : texte, rendu LaTeX, images générées ou fichiers locaux.
4. Déterminer si chaque fichier vidéo possède son propre son, afin de placer
   correctement la narration associée.
5. Générer la voix et les vidéos de l’avatar nécessaires à chaque séquence.
6. Assembler les séquences et synchroniser les incrustations avec la parole.

Le texte et le LaTeX se superposent à la vidéo de l’avatar. Les images et les
fichiers vidéo la remplacent pendant leur insertion. Le retour `{}` rétablit
la génération standard, après la lecture complète d’une vidéo avec son le cas
échéant.

## Scénarios de validation

| Scénario | Résultat à vérifier |
| --- | --- |
| Texte sans commande | L’avatar prononce tout le texte et son visage est animé. |
| `{Texte: hello} Je suis Robert. {} Suite.` | « hello » apparaît en bas de la vidéo uniquement pendant « Je suis Robert. ». |
| `{Latex: x+1} Je suis Robert. {} Suite.` | Le rendu de la formule apparaît en bas de la vidéo uniquement pendant « Je suis Robert. ». |
| Image générée entre deux passages standard | Deux séquences de l’avatar encadrent l’image, accompagnée de la narration associée. |
| Réutilisation d’un contenu d’image identique | L’image existante est retrouvée à partir du dictionnaire enregistré sur disque. |
| Fichier image entre deux passages standard | L’image locale remplace l’avatar pendant la narration associée. |
| Fichier vidéo sans son | La voix de l’avatar accompagne la vidéo locale. |
| Fichier vidéo avec son | Le fichier est lu intégralement avec son audio ; la narration associée est prononcée ensuite par l’avatar. |
| Retour `{}` après un affichage | La suite est générée en mode standard avec la vidéo et la voix de l’avatar. |

Dans chaque scénario, les commandes et leur contenu visuel ne doivent pas
être ajoutés à la narration. Le texte destiné à la voix doit être conservé,
y compris lorsqu’il est reporté après une vidéo avec son.

## Règles finales de syntaxe

Chaque commande `Texte`, `Latex`, `Image` ou `File` doit être suivie d’un texte à
prononcer avant la commande suivante ou la fin du scénario. Sinon, l’analyseur
renvoie une erreur indiquant la position de la commande. Cette règle s’applique
aussi à une vidéo sonore : elle doit posséder un commentaire, prononcé après
sa lecture. Les scénarios sans paroles ne font pas partie de ce langage.

Les retours `{}` et `{ }` peuvent être répétés et placés en fin de scénario.
Une nouvelle commande peut remplacer le mode précédent sans retour explicite,
si la commande précédente possède bien ses paroles associées.

Dans la narration, ces échappements permettent de dicter des caractères
littéraux sans ouvrir ni fermer une commande :

| Écriture dans le scénario | Caractère dans la narration |
| --- | --- |
| `\{` | `{` |
| `\}` | `}` |
| `\\` | `\` |

Les autres barres obliques inverses sont conservées. Ces règles concernent
uniquement les paroles : les contenus de commandes restent inchangés pour
préserver LaTeX et les chemins de fichiers. Les deux-points dans les paroles
ne nécessitent aucun échappement.

```text
Voici \{Texte: exemple\}. {Texte: Titre} Je dicte \{x\}. {} Fin.
```

La narration devient : « Voici {Texte: exemple}. Je dicte {x}. Fin. ».
Seul « Titre » s’affiche, pendant « Je dicte {x}. ».

Les règles des étapes précédentes restent applicables : une vidéo muette est
coupée ou sa dernière image est prolongée pour couvrir sa narration ; une piste
audio, même silencieuse, classe une vidéo comme sonore ; le cache d’images
réutilise les descriptions identiques et régénère les fichiers manquants.

## Contrôles avant les calculs

Le texte et les formules sont rendus localement pour détecter les contenus
invalides avant d’appeler le TTS, Qwen-Image ou Wan. Les fichiers locaux sont
vérifiés avant la voix, les batches et les vidéos. Une erreur de prévalidation
ne lance pas de travail et ne crée pas de révision vidéo.

Lors d’un montage, le scénario enregistré est comparé aux paroles et aux modes
associés au WAV de la génération sélectionnée. Une génération sans voix ne
reprend pas celle d’une autre génération. Ses repères doivent être continus et
correspondre à la durée réelle du fichier vocal, à une milliseconde près. Un ancien scénario devenu
incompatible ou une voix remplacée par un WAV de durée différente demande une
correction du scénario et une régénération de la voix.

## Validation et publication du montage

L’aperçu et le montage Wan sont d’abord écrits dans des fichiers temporaires,
y compris pour un texte sans commandes. Les incrustations sont appliquées sur
cette sortie provisoire, et l’audio déjà assemblé n’est pas réencodé pendant
leur application.

Avant de remplacer la sortie, FFprobe vérifie la présence d’une piste vidéo
et d’une piste audio, leurs durées positives et la cadence vidéo. La vidéo
doit correspondre à la durée attendue à une image près ; l’écart audio doit
rester inférieur à 25 ms pour tenir compte des paquets AAC.

La sortie est publiée par renommage une fois les contrôles terminés. Une erreur
ou une annulation conserve la vidéo précédente et nettoie les fichiers
temporaires. Les scénarios sans incrustation passent par les mêmes contrôles.

## Matrice de tests automatisés

| Vérification | Tests |
| --- | --- |
| Syntaxe, paroles, commandes vides et accolades littérales | [avatarScript.test.ts](../tests/avatarScript.test.ts) |
| Texte, LaTeX, repères invalides et publication interrompue ou désynchronisée | [scriptOverlays.test.ts](../tests/scriptOverlays.test.ts) |
| Réutilisation des images, redémarrage, concurrence et réparation du cache | [scriptImageCache.test.ts](../tests/scriptImageCache.test.ts) |
| Bornes cumulées des images et absence de dérive aux raccords | [scriptImages.test.ts](../tests/scriptImages.test.ts) |
| Fichiers locaux, voix reportée, stéréo, silence et pistes décalées | [scriptFiles.test.ts](../tests/scriptFiles.test.ts) |
| Scénario complet avec tous les visuels, deux clips sonores et image réutilisée | [avatarMontage.test.ts](../tests/avatarMontage.test.ts) |
| API voix/aperçu, historique intact en cas d’erreur et échappements envoyés au TTS | [avatarScriptApi.test.ts](../tests/avatarScriptApi.test.ts) |
| Vidéo Wan avec et sans incrustations, images ou clip sonore | [videoNativeExtend.test.ts](../tests/videoNativeExtend.test.ts) |

Le test complet vérifie chaque image de la vidéo finale et identifie la bande
son active dans chaque passage. Il contrôle le retour à l’avatar, la disparition
des incrustations, les décalages dus aux clips, la conservation du WAV vocal et
la réutilisation du cache après redémarrage.

Exécuter depuis la racine du projet, avec les dépendances installées et
FFmpeg/FFprobe accessibles :

```sh
npm run build
npm test
```

Le scénario complet peut aussi être vérifié seul :

```sh
node --import tsx --test tests/avatarMontage.test.ts
```

Les tests de bout en bout utilisent des services ComfyUI et TTS simulés. Ils
valident les demandes envoyées, le parcours de génération et le montage ; ils
n’exécutent pas les modèles réels sur le GPU.
