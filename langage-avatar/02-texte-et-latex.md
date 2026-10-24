# Étape 2 — Afficher du texte et des formules LaTeX

[Étape précédente : syntaxe](01-syntaxe-et-narration.md) · [Sommaire](AvatarDefinition.md) · [Étape suivante : images générées](03-images-generees.md)

## Objectif

Ajouter une incrustation en bas de l’écran tout en conservant la vidéo de
l’avatar et l’animation de son visage pendant la parole.

## Afficher du texte

La commande `{Texte: contenu}` affiche le contenu en bas de la vidéo pendant
la narration associée. Le contenu affiché n’est pas prononcé automatiquement.

```text
{Texte: hello} Je suis Robert. {} Et je viens d’afficher un texte.
```

L’avatar prononce les deux phrases. Le texte « hello » apparaît pendant
« Je suis Robert. », puis disparaît au retour au mode standard.

## Afficher une formule

La commande `{Latex: contenu}` produit le rendu d’une expression LaTeX et
l’affiche en bas de la vidéo pendant la narration associée.

```text
{Latex: x+1} Je suis Robert. {} Et je viens d’afficher une formule.
```

L’avatar prononce les deux phrases. Le rendu mathématique de `x+1` apparaît
uniquement pendant « Je suis Robert. ». La formule elle-même n’est pas ajoutée
à la narration.

## Résultat attendu

Dans les deux cas, l’incrustation commence et se termine avec la séquence de
parole concernée. Après `{}`, la vidéo continue en mode standard, sans
l’incrustation précédente.

## Implémentation de l’étape 2

L’étape 2 est implémentée pour l’aperçu vidéo et pour le montage final
Wan2.2-S2V + Extend. Les deux interfaces de saisie acceptent les mêmes commandes.

Lorsqu’un scénario contient une incrustation de texte ou de LaTeX, chaque portion
de narration est générée séparément avec la même référence vocale. Pour une voix
sans empreinte, la première portion générée sert de référence aux suivantes.
Les WAV sont assemblés dans l’ordre, sans ajout de pause entre les portions.
Un scénario sans commande de texte, LaTeX, image ou fichier conserve sa génération vocale en une seule
demande. L’étape 3 utilise les mêmes repères pour les images.

Le champ `scriptTimings` du fichier vocal conserve, pour chaque séquence, son
`sequenceIndex` et ses bornes `start` et `end` en secondes dans le WAV assemblé.
Ces bornes sont calculées à partir des durées audio mesurées. Elles sont
enregistrées avec le scénario et restent disponibles après un redémarrage.

Au montage, l’incrustation est active à partir de `start` et disparaît à `end`.
L’affichage suit les images disponibles à la cadence de la vidéo. La voix reste
intacte ; le visage et ses animations restent visibles au-dessus de l’incrustation.
Le texte est centré sur un fond translucide en bas de l’écran. Les lignes longues
sont repliées et le contenu est ajusté à la zone disponible.

Les formules sont converties localement en SVG, puis en image transparente avec
[MathJax](https://docs.mathjax.org/en/v4.0/server/direct.html). Le rendu prend en
charge les expressions de base, les fractions, les indices, les racines, les
fonctions et les constructions AMS. Le texte et les formules sont vérifiés
localement avant le lancement d’un travail vocal ou vidéo. Un contenu invalide
produit une erreur explicite. Les commandes de chargement de fichiers ou d’extensions
externes ne sont pas activées.

Les voix produites à l’étape 1 ne possèdent pas encore de repères temporels.
Si leur scénario contient du texte ou du LaTeX, il faut régénérer la voix avant
de générer la vidéo. Une demande sans repères valides est refusée avant de
lancer le travail vidéo.

Cette étape traite les commandes `Texte` et `Latex`. Les images sont prises en
charge par l’étape 3 et les fichiers locaux par l’étape 4. Lorsqu’un clip sonore
est inséré, les incrustations suivantes sont décalées de sa durée de lecture.

## Vérification

```sh
npm run build
npm test
```

Les tests vérifient les durées vocales, la conservation des repères, l’affichage
et la disparition des incrustations aux changements de séquence, le rendu LaTeX,
la conservation du son et le parcours vidéo Wan avec un service ComfyUI simulé.
