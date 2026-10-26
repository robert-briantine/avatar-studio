# Étape 6 — Composer une ressource sur une image de fond

[Étape précédente : diagrammes](05-diagrammes.md) · [Sommaire](spec.md) · [Étape suivante : commande Ref et montage](07-reference-et-montage.md)

## Objectif

Permettre à une ressource LaTeX, TypeScript ou diagramme de référencer une
image générée et de placer son contenu au-dessus de cette image.

## Comportement attendu

1. Ouvrir une ressource de formule, de code ou de diagramme.
2. Sélectionner une image générée déjà enregistrée dans la bibliothèque.
3. Associer la référence de cette image à la ressource.
4. Afficher un aperçu de la composition complète.
5. Enregistrer l’association pour les utilisations suivantes.

Cette association est facultative : une formule, du code ou un diagramme
peut également être préparé sans image de fond.

## Ordre d’affichage

| Couche | Contenu |
| --- | --- |
| Fond | Image générée retrouvée par sa référence dans la bibliothèque. |
| Premier plan | Formule rendue, code TypeScript coloré ou diagramme. |

Le contenu au premier plan doit rester lisible et permettre de voir l’image
de fond autour de lui. La coloration du code est conservée dans la composition.
Les réglages retenus sont : contenu centré, taille de 80 %, marge extérieure
de 64 pixels et image entière. Ces valeurs peuvent être modifiées dans le
formulaire et sont conservées avec la ressource.

Une même image enregistrée peut servir à plusieurs ressources.

## Exemple

```text
Ressource : FormuleEnergie
Contenu : E = mc^{2}
Image de fond référencée : FondCours
```

L’appel `{Ref:FormuleEnergie}` affichera la composition complète : l’image
`FondCours` en fond et la formule au premier plan.

## Critères de validation

- Les trois types de ressources peuvent sélectionner une image générée par son nom.
- L’image apparaît derrière le contenu, dans l’aperçu et le rendu préparé.
- Plusieurs ressources peuvent réutiliser la même image enregistrée.
- L’association au fond est conservée après rechargement et redémarrage.
- Une image référencée absente ou indisponible produit une erreur avant le montage.

## Implémentation de l’étape 6

### Saisie et présentation

Les trois éditeurs proposent **Image de fond associée**, avec les noms des
images de la bibliothèque. Les images qui n’ont pas encore été générées sont
indiquées comme indisponibles. **Aucune image de fond** conserve le comportement
du visuel seul.

Lorsqu’un fond est sélectionné, les réglages suivants apparaissent :

| Réglage | Valeur initiale | Choix disponibles |
| --- | --- | --- |
| Position | Au centre | Centre, quatre coins et centre de chaque bord. |
| Taille du contenu | 80 % | De 30 à 90 % de l’espace disponible après les marges. |
| Marge extérieure | 64 px | De 16 à 160 pixels. |
| Cadrage du fond | Image entière | Image entière ou remplissage du cadre avec rognage des bords. |

Le cadre final mesure 1472 × 1104 pixels. Les proportions du contenu sont
conservées ; la taille choisie limite sa largeur et sa hauteur. Le fond
entier peut laisser des bandes sombres si son format diffère du cadre.

Le premier plan est placé sur un panneau opaque arrondi : blanc pour
les formules et diagrammes, et de la couleur du thème pour le code.
Ce panneau garantit le contraste et laisse le fond visible autour.
La coloration TypeScript, l’indentation et les lignes sont conservées.
Le panneau du code est ajusté à l’extrait, y compris ses lignes vides.

L’aperçu est actualisé après un changement de contenu, de thème, de fond
ou de réglage. Une réponse d’aperçu devenue obsolète ne peut pas remplacer
une composition plus récente. Les sources restent modifiables dans
MathJax, Monaco et Apollon.

### Sauvegarde et réutilisation

`backgroundImageId` conserve l’identifiant de l’image, indépendamment
de son nom. Le champ `composition` conserve les réglages :

```json
{
  "position": "center",
  "sizePercent": 80,
  "margin": 64,
  "backgroundFit": "contain"
}
```

`backgroundFit` vaut `contain` pour garder l’image entière ou `cover`
pour remplir le cadre. Les anciennes ressources sans réglages explicites
utilisent les valeurs initiales.

Le rendu d’origine et la composition sont conservés séparément. Changer
de fond ou de position ne superpose donc jamais une nouvelle composition
à une image déjà composée. Pour les diagrammes, un changement de fond
peut réutiliser le PNG d’origine sans nouvel export Apollon. Retirer le
fond restitue le rendu seul.

La même image enregistrée peut être référencée par plusieurs ressources.
Son renommage ne casse pas les associations et sa réutilisation ne lance
aucune génération d’image. Si une nouvelle version de cette image est
générée, le prochain accès au PNG d’une composition actualise son rendu.

### Validation et publication

Le même moteur produit l’aperçu composé et le PNG sauvegardé. Le serveur
vérifie que la référence désigne une image, qu’un rendu est disponible et
que le fichier est lisible. Les erreurs indiquent le nom du fond concerné.

Les sources, associations, réglages et fichiers sont publiés ensemble
par écritures atomiques. Un échec de rendu ou d’écriture conserve la
version précédente et supprime les fichiers qui n’ont pas pu être publiés.
Un fond absent ou corrompu empêche également de servir une ancienne
composition comme si sa dépendance était disponible. Après restauration
du fond, l’aperçu peut être actualisé.

Les brouillons sans contenu rendu restent enregistrables. Une ancienne
description de diagramme doit être convertie dans Apollon pour obtenir
un visuel composable.

### API

Les API d’aperçu existantes acceptent maintenant `backgroundImageId` et
`composition`, en plus des données de leur éditeur :

| API | Fonction |
| --- | --- |
| `POST /api/resources/latex/preview` | Aperçu de la formule seule ou composée. |
| `POST /api/resources/typescript/preview` | Aperçu du code seul ou composé, avec son thème. |
| `POST /api/resources/diagram/preview` | Aperçu du PNG Apollon seul ou composé. |
| `POST /api/resources` et `PATCH /api/resources/:id` | Enregistrer la source, le fond, les réglages et le rendu. |
| `GET /api/resources/:id/preview` | Vérifier le fond et servir la composition enregistrée, actualisée si nécessaire. |

Les détails internes des fichiers de premier plan et de la version du fond
restent dans l’index de stockage. Les réponses publiques exposent les
réglages et `previewUrl`. Les aperçus ne sont pas mis en cache afin de
vérifier les dépendances à chaque demande.

`ResourceStore.resolvePreview()` fournit cette même vérification au montage
avec `{Ref:Nom}`, implémenté à l’[étape 7](07-reference-et-montage.md).

### Vérification

```sh
npm run build
node --import tsx --test tests/resourceComposition.test.ts tests/resourceCompositionApi.test.ts
```

Les tests vérifient les pixels du fond et du premier plan, les couleurs
du code, les marges et positions, les deux cadrages du fond, l’égalité
entre aperçu et PNG sauvegardé, la réutilisation d’une image partagée,
le retrait du fond, le redémarrage et la conservation des fichiers après
un échec. Une nouvelle version de fond et un fichier absent ou corrompu
sont également vérifiés.

Le parcours est validé dans Chrome pour les trois éditeurs : sélection
du fond, réglages, sauvegarde, réponse retardée, erreur de fond et
récupération, retrait du fond, rechargement, redémarrage et affichage mobile.
