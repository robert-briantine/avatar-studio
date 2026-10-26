# Étape 5 — Créer et éditer des diagrammes

[Étape précédente : TypeScript](04-code-typescript.md) · [Sommaire](spec.md) · [Étape suivante : composition](06-composition-sur-un-fond.md)

## Objectif

Créer un diagramme dans un éditeur graphique, puis conserver son contenu
éditable et son rendu visuel comme ressource réutilisable.

## Bibliothèque retenue

L’utilisateur a confirmé [Apollon](https://github.com/ls1intum/Apollon),
publié sous le nom `@tumaet/apollon`. L’intégration utilise la version 5.4.0,
avec ses données de modèle au format 4.2.0.

## Comportement attendu

1. Choisir le type « Diagramme » et donner un nom à la ressource.
2. Ouvrir l’éditeur de la bibliothèque retenue.
3. Créer et modifier le diagramme avec les outils de cet éditeur.
4. Afficher un aperçu de son rendu.
5. Enregistrer les données nécessaires pour rouvrir et modifier le diagramme.
6. Préparer un visuel exploitable par le montage vidéo.

La composition du diagramme sur une image générée sera ajoutée à l’étape 6.

## Exemple

La ressource `SchemaTraitement` présente le déroulement suivant, avec les
formes et les liens proposés par l’éditeur :

```text
Texte du scénario → Génération de la voix → Montage vidéo
```

## Critères de validation

- Un diagramme peut être créé, enregistré puis rouvert pour modification.
- Son rendu conserve les éléments, les liens et les libellés du diagramme.
- L’aperçu correspond au visuel préparé pour la vidéo.
- Le contenu reste lisible lorsqu’il est intégré à une composition.

## Implémentation de l’étape 5

### Création et édition

Le type **Diagramme** ouvre le véritable éditeur Apollon. Le type initial
est **Organigramme**. Un sélecteur propose aussi activités, classes, objets,
cas d’utilisation, communication, composants, déploiement, BPMN, réseau
de Petri, graphe d’accessibilité, arbre syntaxique et Grafcet.

La palette native permet d’ajouter les formes. Elles peuvent être déplacées,
redimensionnées et reliées par leurs poignées. Un double-clic ouvre les
propriétés d’une forme ou d’un lien, notamment son libellé. Les outils natifs
de zoom, d’annulation et de rétablissement restent disponibles.

**Ajouter l’exemple** ajoute les trois étapes de l’exemple et leurs deux
flèches à un organigramme. **Tout afficher** recadre le diagramme ;
**Agrandir** ouvre l’éditeur en plein écran. Changer de type avec un
diagramme déjà rempli demande confirmation avant d’effacer ses éléments.

**Importer JSON** ouvre un fichier contenant un modèle natif Apollon au format
4.x (1 Mo maximum). Le fichier est validé avant le remplacement du diagramme ;
si celui-ci contient déjà des éléments, une confirmation est demandée. Un
fichier invalide laisse le diagramme en cours intact. Après l’import,
**Enregistrer la ressource** conserve le diagramme dans la bibliothèque.

**Exporter JSON** télécharge le modèle éditable actuel dans un fichier
`NomDeLaRessource.apollon.json`, y compris les modifications non enregistrées.
Ce fichier conserve les formes, les liens, les positions et les propriétés,
et peut être réimporté avec **Importer JSON**. L’export JSON fonctionne aussi
pour un diagramme vide ou dont le rendu PNG est trop étendu.

Les anciens contenus textuels sont conservés tels quels. Le bouton
**Convertir le texte** transforme les étapes séparées par `→`, `->` ou
une nouvelle ligne en formes reliées, puis permet de les modifier dans
Apollon. Cette conversion accepte jusqu’à 30 étapes de 200 caractères.

### Aperçu et sauvegarde

Le navigateur utilise l’export SVG natif d’Apollon puis son export PNG
avec les polices Inter embarquées. L’image exportée est transmise au
serveur, qui vérifie le modèle et le PNG et prépare un cadre transparent
de 1472 × 1104 pixels avec des marges de 64 pixels.

L’aperçu utilise ce même cadrage. Les formes, connexions, couleurs et
libellés sont conservés. Les réponses d’aperçu devenues obsolètes sont
ignorées. Si le schéma est trop étendu pour rester lisible, un message
invite à rapprocher ses éléments ou à le répartir entre plusieurs ressources.

La source contient le JSON natif du modèle Apollon, avec les identifiants,
positions, dimensions, données des formes et liens. Elle est vérifiée avec
le schéma officiel de la bibliothèque et les références entre éléments.
La limite est de 1 Mo, 150 éléments et 300 liens ; l’export PNG est limité
à 2 Mo et à 4096 pixels par côté avant cadrage.

Les données éditables et le PNG sont publiés ensemble par écritures
atomiques. Une erreur de modèle, d’export, d’image ou d’écriture laisse
la version précédente disponible. Un diagramme vide peut être enregistré
comme brouillon sans aperçu. La réouverture après rechargement ou
redémarrage conserve les éléments et permet de poursuivre l’édition.

L’association à une image de fond reste enregistrée. La composition avec
cette image est disponible à l’[étape 6](06-composition-sur-un-fond.md).

### Construction locale et API

`npm run build:editor` construit les éditeurs TypeScript et Apollon dans
`public/editor-assets/`, avec styles, polices, workers et moteur PNG WASM.
Cette commande est exécutée par `dev`, `start` et `build`. L’éditeur
Apollon est chargé à l’ouverture d’une ressource Diagramme et fonctionne
dans un cadre isolé pour préserver les styles et raccourcis du studio.
Aucun CDN ni service de conversion externe n’est nécessaire.

| API | Fonction |
| --- | --- |
| `POST /api/resources/diagram/preview` | Vérifier `{ source, diagramPreview }` et renvoyer le PNG cadré, sans modifier la bibliothèque. |
| `POST /api/resources` avec le type `diagram` | Enregistrer le JSON éditable et son PNG. |
| `PATCH /api/resources/:id` | Modifier le diagramme ; un nouvel export est requis si le contenu change. |
| `GET /api/resources/:id` | Retrouver le JSON éditable et l’adresse du PNG enregistré. |

`diagramPreview` est une URL de données `data:image/png;base64,…` produite
par l’éditeur. Elle est requise pour un nouveau diagramme non vide ou un
changement qui invalide son aperçu. Elle n’est pas dupliquée dans le
fichier d’index. Un renommage peut réutiliser le PNG existant. Les anciens
contenus sans modèle Apollon restent sauvegardables sans aperçu jusqu’à
leur conversion explicite.

### Vérification

```sh
npm run build
node --import tsx --test tests/resourceDiagram.test.ts tests/resourceDiagramApi.test.ts
```

Les tests vérifient le schéma officiel, les références entre éléments,
les libellés, le cadrage et la transparence du PNG, les erreurs, la
sauvegarde après redémarrage et la conservation de la version enregistrée
en cas d’échec de rendu ou d’écriture.

Le parcours a aussi été validé dans Chrome avec le véritable éditeur :
ajout depuis la palette native, modification d’un libellé, déplacement
à la souris, export PNG, réponse d’aperçu retardée, conversion d’ancien
texte, changement de type, réouverture après rechargement et redémarrage,
et affichage mobile. Le parcours de l’éditeur TypeScript a été revérifié.
