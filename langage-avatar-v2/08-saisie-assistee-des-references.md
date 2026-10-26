# Étape 8 — Faciliter la saisie des références

[Étape précédente : commande Ref et montage](07-reference-et-montage.md) · [Sommaire](spec.md)

## Objectif

Permettre de choisir une ressource pendant la saisie du scénario, sans avoir
à recopier son nom. Cette étape décrit le comportement à implémenter dans
l’interface de saisie du langage.

## Déclenchement

Lorsque l’utilisateur tape `{Ref:`, ouvrir une modale de sélection des
ressources. Un espace saisi après les deux-points est également accepté.
Conserver le champ concerné et la position de la commande pour y insérer le
choix à la validation.

Le déclenchement respecte les règles du langage : une accolade échappée,
comme dans `\{Ref:`, représente du texte littéral et n’ouvre pas la modale.

## Parcours dans la modale

1. Afficher d’abord les types de ressources : image générée, expression LaTeX,
   code TypeScript et diagramme.
2. Laisser l’utilisateur choisir un type.
3. Afficher ensuite les noms des ressources disponibles de ce type dans la
   bibliothèque accessible au scénario.
4. Permettre de revenir au choix du type avant de sélectionner une ressource.
5. Valider le choix lorsque l’utilisateur sélectionne un nom.

Le choix du type sert à filtrer les noms proposés. La commande finale
conserve la syntaxe `{Ref:Nom}`.

## Insertion de la référence

Après la sélection d’un nom :

1. Compléter la commande à l’endroit où l’utilisateur a commencé à la saisir.
2. Insérer le nom exact de la ressource sélectionnée après `Ref:`.
3. Ajouter l’accolade fermante `}`. Une accolade déjà présente à cet endroit
   n’est pas dupliquée.
4. Fermer la modale.
5. Redonner le focus au champ de scénario, avec le curseur juste après `}`,
   afin de poursuivre la saisie des paroles.

Le texte situé avant et après la commande est conservé.

## Exemple

L’utilisateur commence à saisir :

```text
Voici une formule. {Ref:
```

La modale propose les types. L’utilisateur choisit « Expression LaTeX »,
puis sélectionne `FormuleEnergie` dans la liste des noms disponibles.
La modale se ferme et le champ contient :

```text
Voici une formule. {Ref:FormuleEnergie}
```

L’utilisateur peut alors poursuivre :

```text
Voici une formule. {Ref:FormuleEnergie} Cette formule relie la masse et l’énergie. {} Continuons.
```

## Annulation et absence de ressources

- Un bouton « Annuler » ou la touche Échap ferme la modale sans compléter
  la commande. Le texte déjà saisi est conservé et le focus revient au scénario.
- Si aucune ressource n’est disponible pour le type choisi, afficher un
  message explicite et permettre de revenir aux types ou d’annuler.
- Une référence vide ou un nom inventé ne peut pas être validé depuis la modale.

## Critères de validation

| Situation | Résultat attendu |
| --- | --- |
| Saisie de `{Ref:` ou `{Ref: ` | La modale s’ouvre sur le choix des types. |
| Choix d’un type | Seuls les noms des ressources disponibles de ce type sont proposés. |
| Retour aux types | Un autre type peut être choisi sans insertion dans le scénario. |
| Sélection d’un nom | La commande complète `{Ref:Nom}` est insérée à la position prévue. |
| Accolade fermante déjà présente | La commande contient une seule accolade fermante. |
| Validation du choix | La modale se ferme et le curseur revient après `}` dans le champ concerné. |
| Texte entourant la commande | Les paroles et les autres commandes restent inchangées. |
| Annulation | La saisie initiale est conservée sans insertion de ressource. |
| Type sans ressource | Un message explique l’absence de noms disponibles. |
| Accolade échappée | Le texte littéral ne déclenche pas la sélection. |

## Implémentation réalisée

La saisie assistée est disponible dans **Texte à prononcer** du Studio et
dans les champs de scénario des lignes de batch, y compris les lignes
ajoutées après le chargement de la page. Elle utilise un dialogue natif
avec un titre accessible, un état de chargement et un retour au champ
d’origine après validation ou annulation.

### Choix des ressources

À chaque ouverture, la modale recharge `GET /api/resources` pour retrouver
les noms actuels de la bibliothèque commune. Les quatre types sont proposés
en premier, avec le nombre de ressources possédant un visuel enregistré.
Le choix d’un type affiche uniquement les noms correspondants, triés en
français. Les brouillons sans visuel ne sont pas proposés. Un type vide
affiche une explication ; le retour aux types et l’annulation restent
disponibles. Les vérifications complètes de disponibilité avant génération
restent celles de l’étape 7.

Une erreur de chargement propose **Réessayer**. Fermer la modale annule la
requête ; une réponse retardée d’une ouverture précédente ne remplace pas
la sélection courante. L’ouverture et la sélection ne lancent aucune
génération vocale, d’image ou de vidéo et ne modifient pas la bibliothèque.

### Respect de la saisie

Le déclenchement recherche une commande `{Ref:` vide à la position du
curseur, avec ou sans espaces après les deux-points. Il ignore les
accolades échappées et les contenus d’autres commandes, notamment les
groupes LaTeX. Les saisies par méthode de composition attendent la fin de
composition avant de proposer la sélection.

La sélection remplace uniquement la commande commencée, réutilise une
accolade fermante immédiatement présente et conserve les paroles et les
autres commandes autour. Les antislashs d’un nom sont échappés selon les
règles du langage pour retrouver son nom exact au montage. Les noms sont
affichés comme du texte, y compris s’ils contiennent des caractères HTML.

Le champ et sa position sont mémorisés à l’ouverture. Si son contenu a
changé entre-temps, la sélection est abandonnée avec un message, sans
écraser le nouveau texte. L’insertion émet un événement de saisie pour
actualiser l’aperçu du scénario et les données des batchs. Le suivi d’un
batch en cours ne reconstruit pas le champ pendant la sélection ou la
reprise de saisie.

**Tab** et **Maj+Tab** parcourent les boutons de la modale, **Entrée** ou
**Espace** valide le bouton actif et **Échap** annule. Après sélection, le
focus et le curseur reviennent juste après `}` dans le champ concerné.
Après annulation, le texte et la position de saisie sont conservés.

### Vérification

```sh
npm run build
npm test
```

La compilation et les **148 tests** passent. Six nouveaux tests comparent
le résultat des insertions au parseur réel du langage : position du
curseur, commande au milieu d’un scénario, accolade déjà présente,
échappements, commandes imbriquées, noms Unicode ou contenant des
antislashs, contenu modifié et noms invalides.

Le parcours Chrome vérifie les quatre types, l’exclusion des brouillons,
le retour aux types, les insertions avec texte avant et après, la
prévisualisation des commandes complétées, le clavier, l’annulation,
les types vides, une erreur suivie d’une nouvelle tentative, un renommage,
une réponse retardée et la composition de texte. Les lignes de batch
sont vérifiées pendant le rafraîchissement d’un suivi simulé : la
référence et les paroles suivantes sont conservées dans le formulaire.
L’affichage mobile est contrôlé à 390 pixels sans débordement de la modale.
