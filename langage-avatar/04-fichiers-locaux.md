# Étape 4 — Insérer des fichiers locaux

[Étape précédente : images générées](03-images-generees.md) · [Sommaire](AvatarDefinition.md) · [Étape suivante : montage et validation](05-montage-et-validation.md)

## Objectif

Utiliser `{File: chemin}` pour insérer un fichier existant. Le comportement
dépend du type de média et, pour une vidéo, de la présence de son.

## Fichier image

Une image locale remplace la vidéo de l’avatar pendant la narration associée.
La voix de l’avatar reste audible.

```text
Bonjour, voici une belle image. {File:/blockapicoder/videos/licorne.jpg} C’est une licorne. {} J’aime les licornes.
```

Le montage contient successivement :

1. L’avatar qui dit : « Bonjour, voici une belle image. »
2. L’image du fichier `licorne.jpg`, avec la voix : « C’est une licorne. »
3. L’avatar qui dit : « J’aime les licornes. »

## Vidéo sans son

Une vidéo sans son remplace la vidéo de l’avatar et reçoit sa voix pour le texte
associé à la commande.

```text
Bonjour, voici une vidéo de combat de robots. {File:/blockapicoder/videos/combat.mp4} C’est un combat entre Optimus Prime et Megatron. {} Optimus est le plus fort, il a gagné.
```

Si le fichier ne contient pas de son, le montage contient :

1. L’avatar qui dit : « Bonjour, voici une vidéo de combat de robots. »
2. Le fichier `combat.mp4`, accompagné de la voix de l’avatar : « C’est un
   combat entre Optimus Prime et Megatron. »
3. L’avatar qui dit : « Optimus est le plus fort, il a gagné. »

La vidéo conserve sa vitesse de lecture. Si elle dépasse la durée de la
narration, sa fin est coupée. Si elle est plus courte, sa dernière image est
maintenue jusqu’à la fin de la narration ; la vidéo ne boucle pas.

## Vidéo avec son

Si le fichier possède son propre son, la vidéo est lue jusqu’à sa fin avec son
audio. Le texte associé à la commande est prononcé ensuite par l’avatar,
avec le texte qui suit `{}`.

Pour le même scénario, si `combat.mp4` contient du son, le montage contient :

1. L’avatar qui dit : « Bonjour, voici une vidéo de combat de robots. »
2. Le fichier `combat.mp4` lu intégralement avec son propre son.
3. L’avatar qui dit : « C’est un combat entre Optimus Prime et Megatron.
   Optimus est le plus fort, il a gagné. »

Le report de la narration reprend le comportement décrit dans l’exemple
initial : le texte associé n’est ni supprimé ni superposé au son du fichier.

## Résultat attendu

| Fichier | Visuel pendant l’insertion | Traitement du son |
| --- | --- | --- |
| Image | Image locale | Narration associée par la voix de l’avatar. |
| Vidéo sans son | Vidéo locale | Ajout de la narration associée par la voix de l’avatar. |
| Vidéo avec son | Vidéo locale lue jusqu’à sa fin | Son du fichier, puis narration associée lors du retour à l’avatar. |

## Implémentation de l’étape 4

L’étape 4 est implémentée dans l’aperçu et dans le montage final Wan2.2-S2V +
Extend. Les images et les vidéos locales remplacent le cadre complet de
l’avatar. Leurs proportions sont conservées, avec des bandes noires si
nécessaire, et leur cadence est adaptée à celle de la vidéo de sortie.

La présence d’une piste audio suffit à classer une vidéo comme sonore, même
si cette piste contient du silence. La première piste audio est utilisée.
Le fichier est lu en entier ; si sa piste audio est plus courte que sa vidéo,
le son est complété par du silence. Un décalage initial de l’audio est conservé.
Le son n’est pas normalisé comme une voix TTS ; ses canaux stéréo sont conservés.

Les portions de narration sont mesurées dans le WAV vocal, comme aux étapes
précédentes. Une vidéo sonore ajoute sa durée au montage avant la narration
associée. Le commentaire et le texte standard suivant peuvent ainsi partager
le même passage d’avatar au retour du clip. Les textes, les formules et les
images situés plus loin dans le scénario sont décalés en conséquence.

Wan calcule uniquement les passages où l’avatar est visible. Les images
locales ne déclenchent aucune génération Qwen-Image. Un scénario composé
uniquement de visuels locaux et de leur narration n’exige aucun calcul Wan ;
un clip sonore suivi d’un commentaire exige un passage d’avatar pour ce
commentaire.

## Chemins et formats

Le chemin désigne un fichier sur le serveur de l’application. Un chemin absolu
est utilisé directement ; un chemin relatif est résolu depuis le répertoire
de lancement du serveur. Les espaces et apostrophes font partie du chemin et
ne nécessitent pas de guillemets autour du contenu de la commande.

Les fichiers doivent être accessibles et être des fichiers ordinaires. Les
images fixes décodables par Sharp, notamment JPEG, PNG, WebP et TIFF, sont
acceptées. Les images animées et SVG ne sont pas prises en charge. Les vidéos
sont inspectées par FFprobe et doivent être décodables par le FFmpeg installé.
Un fichier audio seul, un répertoire ou un document d’un autre type est refusé.
La lecture porte sur des fichiers locaux, sans chargement de médias réseau.

Les fichiers sont vérifiés avant la génération vocale, avant le lancement d’un
batch et avant chaque montage. Une entrée absente, illisible ou non prise en
charge provoque une erreur explicite, sans lancer de travail vidéo ni créer
de révision d’historique. Les fichiers sources restent inchangés. Le montage
est préparé dans un répertoire temporaire et ne remplace la sortie qu’une fois
terminé.

Les anciennes voix contenant des commandes `File` doivent posséder les repères
`scriptTimings`. Si ces repères sont absents, il faut régénérer la voix.
Chaque commande `File` doit être suivie d’un texte associé, y compris pour une
vidéo sonore dont le commentaire sera reporté. Une commande sans paroles est
refusée lors de l’analyse selon la règle finalisée à l’étape 5.

## Vérification

```sh
npm run build
npm test
```

Les tests couvrent les images locales, les vidéos muettes trop courtes ou trop
longues, les pistes silencieuses, les fichiers invalides, la conservation du
son stéréo, le report du commentaire, le décalage des incrustations, les pistes
audio décalées et le silence ajouté à leur fin. Les tests d’API vérifient
l’absence de mutation en cas de fichier manquant et le montage Wan en deux
passages distincts autour d’un clip sonore. ComfyUI et le TTS y sont simulés.
