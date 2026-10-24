# Étape 1 — Définir la syntaxe et la narration

[Sommaire](AvatarDefinition.md) · [Étape suivante : texte et LaTeX](02-texte-et-latex.md)

## Objectif

Séparer les commandes visuelles du texte à prononcer, puis découper le scénario
en séquences dans leur ordre d’apparition.

## Syntaxe

Une commande est entourée d’accolades et contient un nom suivi d’un contenu :

```text
{Commande: contenu}
```

Les noms définis sont `Texte`, `Latex`, `Image` et `File`. Les accolades vides
`{}` marquent le retour au mode standard.

Au début du scénario, le mode standard est actif : l’avatar prononce le texte
et son visage est animé dans la vidéo. Une commande introduit un affichage
associé au texte qui suit ; `{}` termine cet affichage et rétablit le mode
standard.

## Distinguer affichage et parole

Le nom de la commande et son contenu servent à préparer le visuel. Ils ne sont
pas ajoutés à la voix de l’avatar. Seul le texte situé hors des commandes est
destiné à être prononcé.

```text
{Texte: hello} Je suis Robert. {} Et je viens d’afficher un texte.
```

La narration complète est : « Je suis Robert. Et je viens d’afficher un texte. »
Le mot « hello » apparaît uniquement pendant « Je suis Robert. ».

## Résultat attendu

Chaque séquence doit permettre d’identifier le texte à prononcer, le mode
d’affichage et le contenu visuel éventuel. Cette séparation permet ensuite de
générer les médias et de les synchroniser avec la voix.

Les vidéos possédant leur propre son font exception au déroulement habituel :
la narration associée est reportée après leur lecture, comme expliqué à
[l’étape 4](04-fichiers-locaux.md).

## Implémentation de l’étape 1

L’analyseur `parseAvatarScript`, dans `src/avatarScript.ts`, renvoie :

- `source` : le scénario original, commandes comprises.
- `narration` : le texte à prononcer, sans les commandes ni leur contenu.
- `sequences` : les portions de narration dans l’ordre, chacune avec son `text`,
  son `mode` (`standard`, `text`, `latex`, `image` ou `file`) et, pour les modes
  visuels, son `content`.

Les espaces autour de chaque portion sont retirés et les portions sont reliées
par une espace dans la narration complète. Les espaces et retours à la ligne
à l’intérieur d’une portion sont conservés.

Les règles suivantes fixent les cas nécessaires à cette première étape :

- Les noms de commandes respectent la casse indiquée dans la définition.
- Une nouvelle commande remplace le mode actif. Sans `{}`, ce mode reste actif
  jusqu’à la fin du scénario.
- `{ }` est également accepté comme retour au mode standard. Les portions
  standard vides et les retours répétés ne créent pas de séquence de narration.
- Chaque commande `Texte`, `Latex`, `Image` ou `File` doit être suivie de paroles
  avant la prochaine commande ou la fin du scénario. Une commande sans paroles
  est refusée à sa position, selon la règle finalisée à l’étape 5.
- Le premier deux-points sépare le nom du contenu ; les suivants font partie
  du contenu. Les groupes d’accolades imbriqués et les accolades échappées dans
  les contenus LaTeX sont conservés.
- Une commande inconnue, mal formée, sans contenu ou avec des accolades
  déséquilibrées produit une erreur indiquant sa position.
- Dans les paroles, `\{`, `\}` et `\\` représentent respectivement une accolade
  ouvrante, une accolade fermante et une barre oblique inverse littérales. Les
  autres barres obliques inverses sont conservées. Le contenu des commandes
  reste inchangé, notamment les échappements LaTeX et les chemins de fichiers.
- Un scénario sans texte à prononcer est refusé par les API de création de
  génération, de génération vocale et de lancement de batch.

Le scénario analysé est conservé dans le champ `script` de la génération et du
fichier vocal. Le champ `text` de la génération garde le scénario original ;
celui du fichier vocal contient la narration effectivement envoyée au TTS.
L’ancienne interface conserve aussi le scénario original lors du rechargement.

Cette étape prépare les séquences sans produire leurs visuels ni leurs durées.
L’[étape 2](02-texte-et-latex.md) ajoute désormais la mesure des durées et le
rendu des incrustations de texte et de LaTeX.
Les modes `file` conservent la narration dans l’ordre du scénario. La détection
du son et l’insertion d’une vidéo sonore avant la narration associée sont
désormais réalisées à l’étape 4.

Vérification :

```sh
npm run build
node --import tsx --test tests/avatarScript.test.ts tests/avatarScriptApi.test.ts
```
