# Étape 1 — Créer la bibliothèque de ressources

[Sommaire](spec.md) · [Étape suivante : images générées](02-images-generees.md)

## Objectif

Permettre de préparer des ressources visuelles nommées et de les retrouver
pour les réutiliser dans les scénarios.

## Comportement attendu

1. Ajouter un espace « Ressources » dans l’outil.
2. Permettre de choisir un type : image générée, expression LaTeX, code
   TypeScript ou diagramme.
3. Attribuer à chaque ressource un nom unique dans sa bibliothèque. Ce nom
   sera utilisé dans la commande `{Ref:Nom}`.
4. Enregistrer le contenu source pour pouvoir rouvrir et modifier la ressource.
5. Afficher la liste des ressources et leur aperçu lorsqu’un rendu est disponible.
6. Conserver les ressources après rechargement de l’interface et redémarrage.

Chaque ressource conserve son nom, son type, son contenu éditable et son
éventuelle référence à une image de fond. Les éditeurs propres à chaque type
sont ajoutés aux étapes suivantes.

La bibliothèque est commune à tous les avatars. Les noms sont donc uniques
dans l’ensemble de cette bibliothèque.

## Critères de validation

- Une ressource enregistrée peut être retrouvée et rouverte.
- Un nom vide ou déjà utilisé dans la même bibliothèque produit une erreur
  compréhensible.
- Le contenu éditable est conservé après rechargement et redémarrage.
- La liste distingue les quatre types de ressources.

## Implémentation de l’étape 1

L’onglet **Ressources** est accessible depuis la navigation principale, même
sans avatar sélectionné. Il permet de créer une ressource, de rechercher par
nom, de filtrer par type, puis de rouvrir et de modifier son contenu.

Le formulaire conserve le contenu source sous forme de texte, y compris ses
espaces et retours à la ligne. Une image de fond peut être associée aux types
LaTeX, TypeScript et diagramme ; cette association est enregistrée par
identifiant et reste valide lorsque l’image est renommée. Les aperçus déjà
enregistrés sont affichés lorsqu’ils sont disponibles. Un changement de source
ou d’association au fond invalide l’ancien aperçu. Depuis l’étape 3, les
formules LaTeX sont vérifiées et leur aperçu est recalculé à la sauvegarde.

La génération des images est ajoutée à l’étape 2 et l’éditeur LaTeX à l’étape 3.
Les éditeurs de code et de diagrammes, leur composition et l’utilisation de
`{Ref:Nom}` dans les scénarios sont implémentés et détaillés aux étapes 4 à 7.

### Règles d’enregistrement

- Les noms sont débarrassés des espaces extérieurs et normalisés en Unicode
  NFC. Leur unicité ne distingue pas les majuscules des minuscules.
- Un nom contient au plus 120 caractères et ne peut contenir ni accolades
  ni caractères de contrôle, afin de pouvoir être utilisé dans une référence.
- Le contenu source peut être vide pour préparer un brouillon. Sa taille
  maximale est de 1 Mo en UTF-8 ; les formules LaTeX sont limitées à 8 000
  caractères lors de leur validation.
- Le type est choisi à la création et conservé lors des modifications.
- Les noms et contenus sont stockés indépendamment des chemins de fichiers.

### Persistance et API

Les ressources sont conservées dans `DGX_AVATAR_DATA_DIR/resources/index.json`,
ou dans `~/dgx-avatar-studio-data/resources/index.json` avec le stockage par
défaut. Le fichier contient une version de format, les identifiants, les noms,
les types, les sources, les éventuelles associations et les dates.

Les sauvegardes sont sérialisées et publiées par renommage d’un fichier
temporaire. Une sauvegarde qui échoue conserve les données précédentes.
Un fichier existant illisible est signalé au démarrage.

| API | Fonction |
| --- | --- |
| `GET /api/resources` | Lister les ressources, leurs types et les aperçus disponibles. |
| `POST /api/resources` | Créer une ressource dans la bibliothèque commune. |
| `GET /api/resources/:id` | Rouvrir une ressource avec son contenu source. |
| `PATCH /api/resources/:id` | Modifier le nom, le contenu ou l’association au fond. |
| `GET /api/resources/:id/preview` | Lire un aperçu PNG enregistré, s’il est disponible. |

### Vérification

```sh
npm run build
node --import tsx --test tests/resourceStore.test.ts tests/resourcesApi.test.ts
```

Les tests couvrent les quatre types, la conservation exacte des sources,
les références de fond, les doublons, les sauvegardes concurrentes, les échecs
d’écriture, les aperçus et le redémarrage du serveur.

Le parcours a également été vérifié dans Chrome : création, filtrage,
modification, affichage d’un aperçu disponible, rechargement, redémarrage
et affichage sur écran étroit.
