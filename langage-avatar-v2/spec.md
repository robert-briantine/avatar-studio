# Langage avatar v2 — Ressources réutilisables

## Objectif

Ajouter à l’outil une bibliothèque de ressources visuelles nommées. L’utilisateur
pourra les créer, les modifier et les réutiliser dans ses scénarios avec la
commande `{Ref:Nom}`.

Quatre types de ressources sont prévus :

| Type | Création et édition |
| --- | --- |
| Image générée | Générer une image à partir d’une description et lui attribuer un nom. |
| Expression LaTeX | Modifier une formule dans un éditeur facile à utiliser, avec aperçu. |
| Code TypeScript | Éditer le code dans Monaco Editor et conserver sa coloration de type VS Code dans le rendu. |
| Diagramme | Créer et modifier un diagramme avec [Apollon](https://github.com/ls1intum/Apollon), bibliothèque confirmée par l’utilisateur. |

Les ressources LaTeX, TypeScript et diagramme pourront référencer une image
générée de la bibliothèque. Cette image sera placée en fond, avec le contenu
de la ressource affiché au-dessus.

La bibliothèque est commune à tous les avatars : une ressource enregistrée
peut être retrouvée indépendamment de l’avatar sélectionné.

Dans le scénario, `{Ref:Nom}` suivra le même comportement que
`{Image:Description}` : la ressource remplacera temporairement la vidéo de
l’avatar, tandis que sa voix continuera à prononcer les paroles associées.
La commande `{}` rétablira la vidéo de l’avatar avec sa voix.

## Découpage en étapes

Les étapes sont à réaliser dans l’ordre. Chaque document précise l’objectif,
le comportement attendu et les critères de validation.

| Étape | Document | Objectif |
| --- | --- | --- |
| 1 | [Bibliothèque de ressources](01-bibliotheque-de-ressources.md) | Créer, nommer, enregistrer et retrouver les ressources. |
| 2 | [Images générées](02-images-generees.md) | Créer les images utilisables seules ou comme fond. |
| 3 | [Expressions LaTeX](03-expressions-latex.md) | Proposer un éditeur simple avec aperçu des formules. |
| 4 | [Code TypeScript](04-code-typescript.md) | Intégrer Monaco Editor et préserver sa coloration dans le visuel. |
| 5 | [Diagrammes](05-diagrammes.md) | Intégrer l’éditeur de diagrammes et enregistrer les créations. |
| 6 | [Composition sur un fond](06-composition-sur-un-fond.md) | Superposer une formule, du code ou un diagramme à une image référencée. |
| 7 | [Commande Ref et montage](07-reference-et-montage.md) | Afficher les ressources pendant la narration et valider le résultat. |
| 8 | [Saisie assistée des références](08-saisie-assistee-des-references.md) | À la saisie de `{Ref:`, proposer le type puis le nom de la ressource et compléter la commande. |

La dernière étape facilite la saisie du scénario : une modale s’ouvre lorsque
l’utilisateur tape `{Ref:`. Elle présente d’abord les types de ressources,
puis les noms disponibles pour le type choisi. La sélection d’un nom insère
la référence complète, ajoute l’accolade fermante et ferme la modale.

## Exemple d’utilisation

La bibliothèque contient les ressources suivantes :

| Nom | Type | Image de fond associée |
| --- | --- | --- |
| `FondCours` | Image générée | Sans objet. |
| `FormuleEnergie` | Expression LaTeX | `FondCours`. |
| `ExempleTypeScript` | Code TypeScript | `FondCours`. |
| `SchemaTraitement` | Diagramme | `FondCours`. |

```text
Bonjour, voici le cours.
{Ref:FormuleEnergie} Cette formule relie la masse et l’énergie.
{Ref:ExempleTypeScript} Voici un exemple de code TypeScript.
{Ref:SchemaTraitement} Ce diagramme présente les étapes du traitement.
{} Revenons à la présentation.
```

Chaque ressource occupe le visuel pendant les paroles qui lui sont associées.
Les commandes, les noms des ressources et leur contenu visuel ne sont pas
ajoutés automatiquement à la narration.

## Points à préciser

- Définir l’interface et les règles de suppression des ressources.

La portée commune à tous les avatars est retenue. À partir de l’étape 7,
les voix enregistrées conservent l’identifiant des ressources utilisées :
un renommage ne rompt pas leurs associations. Les nouveaux scénarios utilisent
les noms actuels. Une ressource liée devenue introuvable bloque le montage,
même si une autre ressource a repris son ancien nom.

Les réglages de présentation sont disponibles à l’étape 6 : position,
taille du contenu, marge extérieure et cadrage du fond. Le code propose
les thèmes VS Code Dark+ et Light+.

## Portée du document

Cette spécification décrit une évolution en plusieurs étapes. Les étapes 1
à 8 sont implémentées. Elle complète la
[définition du langage existant](../langage-avatar/AvatarDefinition.md).
Les commandes actuelles et leurs règles restent applicables.
