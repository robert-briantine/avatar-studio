# Définition du langage de génération d’avatar

Ce langage permet d’insérer des indications visuelles dans le texte destiné à
l’avatar : texte, formules LaTeX, images générées et fichiers locaux.

La définition est organisée en cinq étapes à lire dans l’ordre :

| Étape | Document | Objectif |
| --- | --- | --- |
| 1 | [Syntaxe et narration](01-syntaxe-et-narration.md) | Distinguer les commandes du texte prononcé et délimiter les séquences. |
| 2 | [Texte et LaTeX](02-texte-et-latex.md) | Ajouter des incrustations pendant que l’avatar parle. |
| 3 | [Images générées](03-images-generees.md) | Générer, conserver et réutiliser une image avec la voix de l’avatar. |
| 4 | [Fichiers locaux](04-fichiers-locaux.md) | Insérer une image ou une vidéo, selon la présence de son. |
| 5 | [Montage et validation](05-montage-et-validation.md) | Assembler les séquences et vérifier leur synchronisation. |

## Commandes disponibles

| Commande | Effet |
| --- | --- |
| `{Texte: contenu}` | Afficher le contenu en bas de la vidéo de l’avatar. |
| `{Latex: contenu}` | Afficher le rendu de la formule LaTeX en bas de la vidéo de l’avatar. |
| `{Image: contenu}` | Afficher une image générée à partir du contenu, à la place de la vidéo de l’avatar. |
| `{File: chemin}` | Afficher une image ou lire une vidéo depuis un fichier local. |
| `{}` | Revenir à la génération standard : vidéo de l’avatar avec sa voix. |

Les commandes ne sont pas prononcées. Le texte qui les accompagne constitue la
narration, avec un traitement particulier pour les vidéos possédant leur propre
son, détaillé à l’étape 4.

## Portée de cette définition

Ces documents décrivent le comportement implémenté. Les cinq étapes sont
implémentées : analyse du scénario, extraction de la narration, mesure des
séquences vocales, incrustation du texte et des formules LaTeX, génération et
réutilisation des images à la place de l’avatar, insertion des fichiers locaux
et lecture de leur son avant la reprise de la narration associée.
L’étape 5 définit les derniers cas de syntaxe et contrôle le montage avant
publication du fichier de sortie.
La commande de formule est orthographiée
`Latex` partout : la variante `Latext` de l’exemple initial était une coquille.
Les règles complémentaires et la matrice de validation figurent à l’étape 5.
