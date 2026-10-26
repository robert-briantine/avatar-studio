# Étape 4 — Éditer et afficher du code TypeScript

[Étape précédente : LaTeX](03-expressions-latex.md) · [Sommaire](spec.md) · [Étape suivante : diagrammes](05-diagrammes.md)

## Objectif

Créer des ressources de code TypeScript avec Monaco Editor et produire un
visuel qui conserve la coloration syntaxique de type VS Code.

## Comportement attendu

1. Choisir le type « Code TypeScript » et donner un nom à la ressource.
2. Ouvrir Monaco Editor configuré pour le langage TypeScript.
3. Permettre la saisie et la modification du code avec sa coloration syntaxique.
4. Afficher un aperçu du visuel destiné à la vidéo.
5. Enregistrer le code source pour pouvoir le rouvrir dans Monaco Editor.
6. Préserver dans le rendu les couleurs, l’indentation et les retours à la ligne.

Le code constitue le contenu visuel de la ressource. Sa composition sur une
image générée sera ajoutée à l’étape 6. Le thème se choisit dans le formulaire :
VS Code sombre (Dark+) ou clair (Light+), avec Dark+ par défaut.

## Exemple

La ressource `ExempleTypeScript` contient :

```typescript
type Avatar = {
  name: string;
};

const avatar: Avatar = { name: "Robert" };
console.log(avatar.name);
```

## Critères de validation

- Monaco Editor permet de modifier et de retrouver le code enregistré.
- L’aperçu et le visuel produit conservent la coloration syntaxique choisie.
- Les espaces, l’indentation et les lignes sont préservés.
- Le cadrage permet de lire le code sans coupe involontaire.

## Implémentation de l’étape 4

### Édition et thèmes

Le type **Code TypeScript** ouvre Monaco Editor avec le langage TypeScript,
ses aides de saisie et une coloration TextMate Shiki. L’éditeur et le rendu
utilisent la même grammaire et les mêmes thèmes VS Code Dark+ et Light+.
La coloration sémantique et les couleurs supplémentaires des paires
d’accolades sont désactivées pour conserver les couleurs du visuel.

Le code reste éditable après sauvegarde, rechargement et redémarrage. La
source est enregistrée sans suppression des espaces, conversion des
tabulations ou formatage automatique. Les tabulations occupent quatre
colonnes à l’affichage. Les lignes vides et la dernière fin de ligne sont
conservées. Une réouverture sans modification du code préserve aussi ses
fins de ligne CRLF. **Ctrl+M** permet d’utiliser Tab pour quitter l’éditeur.

Le thème est enregistré dans le champ `codeTheme`, avec les valeurs
`dark-plus` et `light-plus`. Les anciennes ressources sans ce champ
s’ouvrent avec Dark+.

### Aperçu et enregistrement

L’aperçu est actualisé après la saisie ou un changement de thème. Il utilise
exactement le même rendu que le PNG enregistré, de 1472 × 1104 pixels,
avec le fond du thème choisi et une marge de 64 pixels. Les réponses
d’aperçu devenues obsolètes sont ignorées.

Le texte est affiché sans retour à la ligne ajouté. Sa taille diminue de
32 à 14 pixels pour que toutes les lignes entrent dans le cadre. La
largeur des caractères Unicode est mesurée avec les polices du rendu.
Si l’extrait demande une taille inférieure à 14 pixels, un message invite
à raccourcir les lignes ou à répartir le code entre plusieurs ressources.
La limite de source rendue est de 20 000 caractères.

La sauvegarde publie la source, le thème et le PNG ensemble. Une erreur
de rendu ou d’écriture conserve la version précédente. Une source vide
peut être enregistrée comme brouillon sans aperçu. Le code est traité
comme du texte à colorer, sans exécution.

L’association à une image de fond reste enregistrée ; la composition
avec cette image est disponible à l’[étape 6](06-composition-sur-un-fond.md).

### Construction locale et API

`npm run build:editor` construit Monaco, ses styles, ses workers et la
coloration dans `public/editor-assets/`. Ces fichiers sont générés et
ignorés par Git. La construction est également lancée par les commandes
`dev`, `start` et `build`. L’éditeur est chargé à la première ouverture
d’une ressource TypeScript et ne dépend d’aucun CDN.

| API | Fonction |
| --- | --- |
| `POST /api/resources/typescript/preview` | Rendre `{ source, codeTheme }` en PNG sans modifier la bibliothèque. |
| `POST /api/resources` avec le type `typescript` | Enregistrer la source, le thème et le visuel. |
| `PATCH /api/resources/:id` | Mettre à jour le code ou son thème, après validation du rendu. |
| `GET /api/resources/:id` | Retrouver la source, le thème et l’adresse du PNG enregistré. |

### Vérification

```sh
npm run build
node --import tsx --test tests/resourceCode.test.ts tests/resourceCodeApi.test.ts
```

Les tests utilisent la vraie coloration Shiki et le vrai rendu PNG. Ils
vérifient les couleurs des pixels, les espaces et les lignes, les thèmes,
le cadrage, la sauvegarde après redémarrage et la conservation de la
version enregistrée après une erreur de rendu ou d’écriture.

Le parcours a également été vérifié dans Chrome : saisie réelle dans
Monaco, couleurs des mots-clés et des accolades, changement de thème,
worker TypeScript local, réponse d’aperçu retardée, source CRLF, réouverture
après rechargement et redémarrage, et affichage sur écran étroit.
