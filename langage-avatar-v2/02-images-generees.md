# Étape 2 — Créer des ressources d’images générées

[Étape précédente : bibliothèque](01-bibliotheque-de-ressources.md) · [Sommaire](spec.md) · [Étape suivante : LaTeX](03-expressions-latex.md)

## Objectif

Créer des images nommées utilisables directement dans un scénario ou comme
fond d’une autre ressource.

## Comportement attendu

1. Choisir le type « Image générée » dans la bibliothèque.
2. Saisir le nom de la ressource et la description de l’image souhaitée.
3. Générer l’image avec l’outil de génération déjà disponible.
4. Afficher un aperçu pour vérifier le résultat.
5. Enregistrer l’image et sa description dans la ressource.

L’image enregistrée est réutilisée lors des affichages suivants. Appeler la
ressource ne demande pas de générer une nouvelle image à chaque fois.

## Exemple

```text
Nom : FondCours
Type : Image générée
Description : Un tableau sombre avec un espace central dégagé.
```

Cette image pourra servir de fond à l’étape 6. Une fois la commande `Ref`
intégrée à l’étape 7, elle pourra aussi être appelée directement :

```text
{Ref:FondCours} Voici le support de notre cours. {} Continuons.
```

## Critères de validation

- L’image produite est visible dans l’aperçu de la ressource.
- Son nom, sa description et son fichier sont conservés après redémarrage.
- L’image enregistrée peut être retrouvée pour un nouvel affichage.
- Un échec de génération est signalé et ne présente pas la ressource comme prête.

## Implémentation de l’étape 2

Dans l’onglet **Ressources**, le type **Image générée** propose le bouton
**Générer l’image**. Il devient disponible lorsque le nom et la description
sont renseignés. Le formulaire est enregistré automatiquement avant le
lancement du traitement ; l’utilisateur peut aussi enregistrer un brouillon
sans générer son image.

Le traitement utilise le générateur Qwen-Image de l’application, avec le
graphe Qwen-Image-2512, au format 1472 × 1104 pixels. La description source
reste enregistrée dans la ressource. Le résultat est vérifié et conservé
comme PNG dans le dossier de données de la bibliothèque.

La liste indique si la génération est en cours, terminée, interrompue ou en
erreur. L’aperçu se met à jour automatiquement à la fin du traitement. Pendant
la génération, la ressource concernée est verrouillée en modification ;
l’utilisateur peut consulter ou préparer d’autres ressources.

### Réutilisation et modifications

- Une image enregistrée et valide est réutilisée lors d’un nouvel appel de
  génération, sans solliciter Qwen ni modifier ses pixels.
- Un renommage conserve l’image associée à la ressource.
- Un changement de description invalide l’aperçu associé. Une nouvelle
  génération prépare l’image correspondant à cette description.
- Un fichier absent ou corrompu peut être recréé en relançant la génération.
- L’ouverture d’une ressource et la consultation de son aperçu utilisent le
  fichier enregistré, sans génération automatique.

### Persistance et gestion des erreurs

Les PNG sont enregistrés dans `DGX_AVATAR_DATA_DIR/resources/previews`, ou
dans `~/dgx-avatar-studio-data/resources/previews` avec le stockage par défaut.
Chaque nouveau PNG porte un nom composé de l’identifiant de la ressource et
d’un identifiant de version. La publication du fichier précède la validation
de son association dans l’index ; un échec de publication conserve l’image
précédemment associée et nettoie le nouveau fichier incomplet.

L’index conserve également l’identifiant du traitement, son état, ses dates
et son éventuel message d’erreur. Un redémarrage conserve les images terminées
et marque les traitements inachevés comme interrompus, pour permettre une
nouvelle tentative.

Le bouton **Arrêter la génération** annule le traitement de cette ressource
et demande l’arrêt du travail ComfyUI correspondant par son identifiant.
Une erreur ou une annulation laisse le contenu source éditable pour corriger
la description ou relancer le traitement.

### API

| API | Fonction |
| --- | --- |
| `POST /api/resources/:id/generate-image` | Démarrer la préparation de l’image et renvoyer l’état du traitement avec HTTP 202. |
| `POST /api/resources/:id/generate-image/stop` | Demander l’arrêt de la génération de cette ressource. |
| `GET /api/resources/:id` | Lire l’état du traitement et l’adresse de l’aperçu disponible. |
| `GET /api/resources/:id/preview` | Lire le PNG enregistré de la ressource. |

Une référence inconnue, un autre type de ressource, une description vide ou
une génération déjà active sont refusés avant de lancer un travail Qwen.

### Vérification

```sh
npm run build
node --import tsx --test tests/resourceImages.test.ts tests/resourceImagesApi.test.ts
```

Les tests couvrent la génération, la conservation des pixels après réutilisation
et redémarrage, les images absentes ou corrompues, les erreurs, l’annulation,
les modifications concurrentes et les échecs de publication.

Le parcours a aussi été vérifié dans Chrome : enregistrement automatique de
la description, génération, mise à jour de l’aperçu, réutilisation, erreur,
arrêt et nouvelle tentative. Les vérifications d’intégration et d’interface
utilisent un ComfyUI simulé ; elles n’exécutent pas les modèles sur le GPU.
