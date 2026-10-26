# Étape 3 — Créer et éditer des expressions LaTeX

[Étape précédente : images générées](02-images-generees.md) · [Sommaire](spec.md) · [Étape suivante : TypeScript](04-code-typescript.md)

## Objectif

Préparer une formule dans un éditeur facile à utiliser, puis l’enregistrer
comme ressource réutilisable.

## Comportement attendu

1. Choisir le type « Expression LaTeX » et donner un nom à la ressource.
2. Proposer une saisie simple, avec des aides pour les éléments courants :
   fractions, puissances, indices et symboles.
3. Afficher un aperçu actualisé de la formule rendue.
4. Signaler les expressions invalides de façon compréhensible.
5. Enregistrer l’expression source pour pouvoir la modifier ultérieurement.

Le visuel affiche la formule mise en forme. Sa composition avec une image
générée sera ajoutée à l’étape 6.

## Exemple

```text
Nom : FormuleEnergie
Type : Expression LaTeX
Expression : E = mc^{2}
```

Lors de son utilisation dans un scénario, la formule sera affichée pendant
la narration associée, selon les règles de l’étape 7.

## Critères de validation

- Une formule simple et une formule contenant une fraction s’affichent correctement.
- L’expression reste éditable après enregistrement et rechargement.
- Une erreur LaTeX est signalée avant l’utilisation de la ressource dans un montage.

## Implémentation de l’étape 3

Dans l’onglet **Ressources**, choisir **Expression LaTeX** affiche une barre
d’outils et un aperçu de la formule. La source reste visible et modifiable
dans le champ de saisie.

Le sélecteur **Couleur de la formule** permet de choisir la couleur du rendu.
L’aperçu se met à jour dès son changement. La couleur est enregistrée avec
la ressource et s’applique aussi au PNG, aux compositions et à son utilisation
dans une vidéo. Le fond du rendu reste transparent. Les formules existantes
conservent leur couleur par défaut `#17231d`.

### Aides de saisie

Les boutons proposent les fractions, les puissances, les indices, les racines
carrées, alpha, bêta, pi, les sommes, les intégrales et le symbole infini.

Les outils utilisent la position du curseur ou la sélection en cours. Par
exemple, sélectionner `x+1` puis choisir **Fraction** insère `\frac{x+1}{b}`
et sélectionne `b` pour permettre de saisir le dénominateur. Sans sélection,
le bouton insère `\frac{a}{b}` et sélectionne `a`.

### Aperçu et erreurs

L’aperçu est actualisé après une courte pause dans la saisie, de 300 ms.
Le bouton **Actualiser** permet de demander un nouvel aperçu immédiatement.
Une réponse correspondant à une ancienne saisie ne remplace pas l’aperçu de
la formule courante.

Le rendu utilise MathJax, également employé par les incrustations LaTeX des
vidéos. Il est exécuté localement sur le serveur, sans appel aux modèles
Qwen, au TTS ou au GPU. Les fractions, indices, racines, sommes et expressions
sur plusieurs lignes avec `aligned` sont rendus en notation mathématique.

Une formule invalide retire l’aperçu courant et affiche un message. Les erreurs
courantes indiquent en français l’accolade manquante, la commande inconnue,
l’argument attendu ou le délimiteur à fermer. Les formules sont limitées à
8 000 caractères.

### Enregistrement

Le bouton **Enregistrer la ressource** conserve la source exacte, y compris
les espaces et les retours à la ligne. Le serveur vérifie la formule puis
enregistre un PNG transparent de 1472 × 1104 pixels, avec la formule centrée.
L’aperçu de saisie est ajusté à la taille de la formule pour rester lisible
dans l’éditeur.

Une formule invalide est refusée à la sauvegarde ; la version précédemment
enregistrée et son PNG restent disponibles. Une source vide peut être
enregistrée comme brouillon, sans aperçu. Après un rechargement ou un
redémarrage, la formule peut être rouverte et modifiée.

La référence à une image de fond est conservée, comme à l’étape 1. La
composition avec ce fond est disponible à l’[étape 6](06-composition-sur-un-fond.md).

### API

| API | Fonction |
| --- | --- |
| `POST /api/resources/latex/preview` | Rendre la source fournie et renvoyer un aperçu PNG, sans créer ni modifier de ressource. |
| `POST /api/resources` avec le type `latex` | Vérifier et enregistrer la source avec son PNG. |
| `PATCH /api/resources/:id` | Vérifier la formule modifiée avant de publier la nouvelle version. |
| `GET /api/resources/:id` | Retrouver la source éditable et l’adresse de son aperçu enregistré. |

Les aperçus, créations et modifications acceptent le champ `latexColor`
au format hexadécimal `#RRGGBB`. Une modification de ce seul champ régénère
le rendu sans changer l’expression source.

Les aperçus et leurs associations sont publiés par écritures atomiques,
selon le stockage de la bibliothèque commune. Une erreur de rendu ou
d’écriture conserve la dernière version enregistrée.

### Vérification

```sh
npm run build
node --import tsx --test tests/resourceLatex.test.ts tests/resourceLatexApi.test.ts tests/scriptOverlays.test.ts
```

Les tests utilisent le vrai moteur MathJax. Ils couvrent les formules simples
et les fractions, les outils de saisie, les messages d’erreur, la transparence,
la sauvegarde, la réouverture après redémarrage et la conservation des fichiers
en cas d’échec. Les incrustations vidéo existantes sont également vérifiées.

Le parcours a été validé dans Chrome, y compris les insertions dans une
sélection, le refus d’une sauvegarde invalide, l’ignorance d’une réponse
retardée, le redémarrage et l’affichage sur écran étroit.
