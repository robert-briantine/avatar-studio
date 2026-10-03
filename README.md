# DGX Avatar Studio v0.4.0

Application locale DGX Spark : image Qwen, voix Qwen3-TTS et vidéo Wan2.2-S2V.

## Durée de stabilisation réglable — octobre 2026

En mode **Stabilisé**, le champ **Intervalle entre les reprises (secondes)** permet de
choisir la durée de mouvement continu entre deux reprises : **20 s par défaut**,
de 1 à 120 s. Le réglage est enregistré dans le projet au lancement, même si la
génération échoue, puis retrouvé au rechargement. Le mode Continu masque ce champ
et conserve son fonctionnement habituel.

Dans la section **3. Vidéo**, choisir cet intervalle dans l'interface, juste
au-dessus du bouton **Générer la vidéo parlante**, puis lancer la génération.
L'intervalle et le mode sont verrouillés dès le clic et pendant tout le rendu.
Ils redeviennent modifiables après la fin ou une erreur, pour la prochaine vidéo.

Avec 20 s, les reprises commencent à 20, 40, 60 s, etc. La dernière image avant
chaque reprise est extraite du décodage avant compression : à 16 fps, l'image 319
pour reprendre à l'image 320. Elle sert seulement à estimer la pose. Le nœud
`DGXRestoreWanReference` applique cette pose aux pixels de l'avatar original ;
cette image reconstruite devient le contexte de mouvement (`ref_motion`, répété
sur 73 images). Le flou, les couleurs altérées et les détails inventés par la
fenêtre précédente ne sont donc pas recopiés. L'avatar original reste aussi la
référence d'identité (`ref_image`) de toutes les passes.

Les raccords de 0,5 s commencent **après** la durée choisie, pour préserver tout
le début du mouvement. Une fenêtre peut donc couvrir 20,5 s. S'il reste au plus
0,5 s à la prochaine reprise, la fenêtre en cours termine la vidéo sans nouvelle
réinitialisation. Les fractions de seconde sont arrondies à l'image la plus proche
(1/16 s). Le WAV complet reste la piste finale, sans répétition ni coupure audio.
Si l'estimation de pose est peu fiable, le raccord repart de l'avatar original.
Réduire la durée permet toujours de réancrer plus tôt. La qualité visuelle reste
à valider sur le rendu GPU.

Pour **extra-terrestre**, sélectionner **Stabilisé**, garder **20** puis lancer
la génération. La vidéo continue existante n'est pas modifiée par cette mise à jour.
Sauvegarde des sources précédentes :
`backups/avant-stabilisation-reglable-20261001.tar.gz`.

## Niveau des voix générées — septembre 2026

Les nouvelles voix sont normalisées par FFmpeg à une cible de **−18 LUFS** avec
un niveau de crête limité à **−2 dBTP**, puis enregistrées en PCM 48 kHz. La
normalisation intervient après le filtre vocal et l'accélération, une fois la
détection de silence terminée : elle n'amplifie pas le bruit pendant ce contrôle
et ne modifie pas le WAV brut de Qwen. Elle couvre la voix de préécoute, les voix
clonées et les lots. Le rendu vidéo conserve la voix déjà normalisée du projet.

Mesure sur un WAV généré existant : niveau intégré initial de −31,74 LUFS et crête
de −12,86 dBTP. L'application du réglage produit −18,16 LUFS et −2,00 dBTP. Les
WAV déjà enregistrés dans les projets ne sont pas réécrits ; régénère la voix pour
profiter du nouveau niveau. Le fichier de démonstration réunit aussi une minute
avec une voix normalisée ; il garde la même durée, le même son et les six raccords.

Fichiers de contrôle : [vidéo 60 s](backups/validation-restauration-pose-20260930/video-60s.mp4),
[rapport avec les mesures](backups/validation-restauration-pose-20260930/rapport.json)
et [comparaison avant/après](backups/validation-reprise-pose-20260930/comparaison.mp4).

## Historique : restaurer les raccords avec l'avatar original — septembre 2026

Le mode **Stabilisé** reconstruit maintenant chaque image de raccord avec les
pixels de l'avatar original. La dernière image utile du bloc sert uniquement à
estimer la pose. Son flou, ses changements de couleur et ses détails inventés ne
sont plus recopiés dans l'image de référence du bloc suivant. L'original reste
aussi la référence `ref_image` de toutes les passes Wan.

Le nœud local `DGXRestoreWanReference` recale l'original vers la pose observée.
Il vérifie les correspondances dans les deux sens, atténue les mouvements peu
fiables et les variations locales, puis limite le déplacement à 8 % du petit côté
et la variation spatiale du déplacement à 0,25. Ces bornes sont mesurées par
rapport à l'original à chaque raccord : elles ne s'accumulent pas d'un bloc au
suivant. Les pixels sont rééchantillonnés une seule fois depuis l'original, sans
accentuation répétée ni mélange de deux visages décalés.

Si l'alignement est trop incertain, le nœud réutilise l'original. Ce retour peut
créer un raccord plus visible, adouci par le chevauchement existant. Ce recalage
2D conserve approximativement la pose ; il ne peut pas reconstruire une vue de
profil absente de l'image source. Wan peut encore produire des défauts à
l'intérieur d'une fenêtre de 9,625 s ; le traitement vise leur propagation entre
fenêtres. Il ne modifie pas les vidéos déjà produites.

Le contexte de 73 images identiques, les chevauchements de 0,5 s, la chronologie
audio et les modes courts/Continu restent inchangés. Aucune nouvelle passe de
diffusion ou nouveau modèle n'est nécessaire. OpenCV et NumPy sont utilisés dans
le Python de ComfyUI, déjà équipé de ces dépendances sur le DGX.

**Chargement :** `./start.sh` passe désormais
`--extra-model-paths-config "$APP_DIR/comfy/extra_paths.yaml"` à ComfyUI. Le nœud
reste dans ce projet, sous `comfy/custom_nodes/dgx_avatar` ; aucune copie dans
l'installation ComfyUI n'est nécessaire. Si ComfyUI tourne déjà, il faut le
redémarrer avec cette option : relancer uniquement le serveur Node ne recharge
pas ses nœuds. L'application signale un nœud absent avant le calcul vidéo. Avec
`--disable-all-custom-nodes`, ajouter `--whitelist-custom-nodes dgx_avatar`.

Vérifications :

```bash
npm test
npm run build
bash -n start.sh
/home/blockapicoder/comfyui-spark/comfyui-env/bin/python tests/wan_reference_test.py
/home/blockapicoder/comfyui-spark/comfyui-env/bin/python tests/wan_transitions_test.py
```

Les 16 tests de workflow contrôlent notamment que chaque restauration reçoit
l'original intact. Les 6 tests de restauration couvrent le flou simulé, 20
transmissions successives, les déformations excessives et le repli en cas de
mauvais alignement. Les 4 tests de montage contrôlent les raccords et le son.

Implémentation du recalage : [flux optique OpenCV](https://docs.opencv.org/4.13.0/dc/d6b/group__video__track.html)
et [rééchantillonnage OpenCV](https://docs.opencv.org/4.13.0/da/d54/group__imgproc__transform.html).
Sauvegarde de la version précédente :
`backups/avant-restauration-reference-20260930.tar.gz`.

## Historique : reprise de la pose entre les blocs

Le mode **Stabilisé** transmet désormais une image de la fenêtre précédente à la
suivante. Cette image est extraite directement du décodage, avant toute compression
MP4, puis reçoit une légère correction de netteté. Elle sert de référence de pose
(`ref_motion`) ; **l'avatar original reste la référence d'identité** (`ref_image`)
pour chaque passe. L'historique latent est toujours réinitialisé toutes les deux
passes, soit au plus 9,625 s par fenêtre.

La même pose est répétée sur les 73 images de contexte attendues par Wan. Cela
évite le remplissage gris que le nœud natif applique à une image isolée, sans
réinjecter l'historique de mouvement des fenêtres précédentes. Ces répétitions
servent uniquement au conditionnement et ne sont pas ajoutées à la vidéo finale.

Les fenêtres se chevauchent de 8 images (0,5 s). L'image transmise est donc la
dernière image **avant le début de la fenêtre suivante** : par exemple l'image 145
pour une fenêtre démarrant à l'image 146, en comptant à partir de zéro. Utiliser
l'image 153 reviendrait à reprendre une pose située dans le futur du passage audio.
Les extensions internes à chaque fenêtre gardent leur continuité native.

La netteté utilise le nœud natif `ImageSharpen`, rayon 1, sigma 1, alpha 0,03
(le nœud multiplie alpha par 10). Le traitement ne modifie pas l'avatar original.
Cette correction modérée et la référence originale limitent le risque de flou
cumulatif ; elles ne peuvent pas recréer des détails déjà perdus ni garantir
l'absence de dérive sur toute vidéo longue. Aucune restauration générative du
visage n'est appliquée.

Le montage des chevauchements et le WAV complet sont conservés. Les vidéos de
9,625 s ou moins, le mode **Continu** et le benchmark gardent leur workflow.
ComfyUI doit proposer `ImageSharpen`, `RepeatImageBatch` et l'entrée `ref_motion` de
`WanSoundImageToVideo` pour les vidéos stabilisées à plusieurs fenêtres ; ces
capacités sont vérifiées avant le calcul GPU.

Validation automatique : 16 tests de workflow et 4 tests Python. Les tests couvrent
le chaînage sur 60 s, les références originales, l'absence de cycles, l'instant
d'extraction, les durées vidéo et la conservation du son. Compilation TypeScript
réussie.

Validation GPU : comparaison de 24 s à 256×144, 12 étapes, CFG 5,5, même seed,
même avatar et même audio. Le MP4 final contient 384 images à 16 fps et 24 s
d'audio ; la corrélation avec le WAV maître décodé dépasse 0,9998. La reprise de
pose réduit le saut au premier raccord. Quelques artefacts restent visibles à
cette petite résolution ; ce test ne garantit pas la qualité sur plusieurs minutes
ou au profil Normal. Les fichiers de contrôle sont dans
[`backups/validation-reprise-pose-20260930`](backups/validation-reprise-pose-20260930/)
(`comparaison.mp4`, `rendu-24s.mp4`, `rapport.json`).

Relancer `./start.sh`, recharger la page et générer une nouvelle vidéo en mode
**Stabilisé**. Sauvegarde du code précédent :
`backups/avant-reprise-image-raccord-20260930.tar.gz`.

## Historique : raccords progressifs du mode stabilisé

Les fenêtres stabilisées se chevauchent désormais de **8 images, soit 0,5 s**.
Les deux fenêtres utilisent le même passage audio pendant le chevauchement.
Le montage estime le déplacement dans les deux sens et déforme progressivement
les images avant de les mélanger. Cela adoucit le changement de pose tout en
conservant les réancrages qui limitent le flou progressif. De grands écarts de pose
ou des détails masqués peuvent encore produire un raccord perceptible.

Le MP4 intermédiaire contient les fenêtres juxtaposées et n'a pas de son. Après
fusion des chevauchements, le WAV original complet est ajouté au MP4 final :
aucune durée n'est supprimée de la narration, ni dupliquée dans la vidéo finale.
Le traitement ne garde en mémoire que la courte zone de raccord. Le résultat
remplace l'ancienne vidéo seulement après un montage réussi.

Le Python ComfyUI déjà installé fournit OpenCV et NumPy. Sur une autre installation,
`WAN_TRANSITION_PYTHON` permet de choisir ce Python ; sa disponibilité est vérifiée
avant de lancer le calcul GPU. Le mode Continu et les vidéos stabilisées de
9,625 s ou moins conservent leur finalisation précédente.

Validation : 14 tests de workflow et 4 tests Python, compilation, vérification du
son et du nombre d'images avec FFmpeg. Une comparaison GPU de 24 s à 256×144,
12 étapes, CFG 5,5 a couvert deux raccords ; le MP4 final contient 384 images et
24 s d'audio. Les raccords ont été comparés visuellement à une coupe franche sur
les mêmes blocs. Le montage a pris environ 1 s sur cet extrait. Le chevauchement
peut ajouter un bloc de calcul selon la durée : ce test utilise 6 passes au lieu
de 5 sans chevauchement. Ce coût n'est pas celui du profil Normal.

Commandes de vérification :

```bash
npm run build
npm test
/home/blockapicoder/comfyui-spark/comfyui-env/bin/python tests/wan_transitions_test.py
```

Relancer `./start.sh`, recharger la page et générer une nouvelle vidéo en mode
**Stabilisé**. Sauvegarde précédente : `backups/avant-raccords-adoucis-20260929.tar.gz`.

## Historique : limiter le flou progressif des vidéos longues

Le mode **Stabilisé**, sélectionné par défaut, limite la propagation des
défauts du visage : chaque fenêtre de deux blocs (9,625 s, dont 0,5 s partagée avec
la suivante) repart de l'image
originale. Une seule extension reprend le mouvement précédent dans chaque
fenêtre. Le mode **Continu** reste disponible dans « Mode longue durée » pour
retrouver la chaîne d'extensions sans réinitialisation.

Le réancrage peut créer un raccord de pose visible. Il limite la dérive cumulée,
sans garantir un visage parfait sur tout contenu. Les vidéos de 9,625 s ou moins
utilisent le workflow précédent. Les paramètres de qualité, le batch de 1 et le
cache optimisé sont conservés.

Chaque fenêtre reçoit l'extrait audio correspondant à sa position exacte. Ses
images sont découpées à la bonne longueur avant assemblage ; le WAV original
complet est la piste audio finale. Le mode est enregistré avec la vidéo. Le temps
total de génération reste affiché à la fin, et la progression tient compte de
l'ordre de calcul des fenêtres choisi par ComfyUI. Le benchmark conserve le
workflow continu pour rester comparable aux mesures existantes.

Validation initiale, avant l'ajout des transitions progressives : 12 tests réussis, compilation réussie et contrôle
de l'interface. Deux rendus réels de 24 s à 256×144, 12 étapes, CFG 5,5, même seed
et mêmes sources ont été comparés visuellement : le mode stabilisé conserve mieux
les détails et l'apparence sur cet extrait. Temps observés : continu 154,472 s,
stabilisé 157,420 s ; ces mesures ponctuelles ne prédisent pas le coût au profil
Normal. Le MP4 stabilisé contient exactement 384 images à 16 fps et 24 s d'audio,
avec décodage complet vérifié. Un autre test via l'API a validé le mode par défaut,
la progression croissante, le MP4 final de 10 s et l'enregistrement du projet.

Relancer `./start.sh`, recharger la page, puis générer une nouvelle vidéo avec
**Stabilisé**. La version précédente est sauvegardée dans
`backups/avant-correction-flou-20260929.tar.gz`. Les anciennes vidéos restent
disponibles jusqu'à leur remplacement par une nouvelle génération.

## Optimisation vidéo — septembre 2026

- Correction du batch Wan : une seule vidéo est calculée, puis prolongée avec les
  blocs Extend. Auparavant, le nombre de blocs était aussi utilisé comme nombre
  de vidéos indépendantes : une narration de 10 s (3 blocs) calculait 3 variantes
  à chaque passe, alors qu'une seule était utilisée dans la vidéo finale.
- Les réglages de qualité sont conservés : profil Normal à 768×432, 20 étapes,
  CFG 6 et 16 fps, avec les mêmes modèles, prompts et références de visage.
- `start.sh` utilise désormais le cache natif de ComfyUI. Avec la version installée
  (0.28.2), ce cache s'adapte à la pression mémoire. L'application ne force plus
  son vidage avant chaque vidéo ; ComfyUI reste responsable de l'éviction des
  modèles lorsque la mémoire manque.
- Les workers lancés par `scripts/start-benchmark-workers.sh` conservent leur
  réglage `--cache-none` ; la correction du batch s'applique aussi au benchmark.

Relancer l'application avec `./start.sh` pour appliquer les changements. Une
instance ComfyUI déjà active est réutilisée avec ses paramètres de démarrage
actuels ; le réglage du cache s'applique lorsque `start.sh` démarre ComfyUI.
Le fichier `.env` existant n'a pas besoin d'être remplacé.

Pour retrouver la gestion mémoire précédente, ajouter dans `.env` puis relancer :

```dotenv
COMFY_CACHE_MODE=none
WAN_FREE_MEMORY_BEFORE_VIDEO=true
```

Les sources et fichiers compilés d'origine sont sauvegardés dans
`backups/avant-optimisation-video-20260929.tar.gz`. Les projets et médias persistants
ne sont pas modifiés par cette mise à jour. Les tests de non-régression du workflow
s'exécutent avec `npm test`, et la compilation avec `npm run build`.

Vérification sur le DGX Spark GB10 le 29 septembre 2026 : compilation réussie,
6 tests de non-régression réussis, import d'avatar et routes de l'application
vérifiés dans un stockage temporaire. Une vraie génération GPU de 6 s avec
2 blocs Extend a produit un MP4 H.264/AAC à 16 fps, son et vidéo de 6 s, entièrement
décodable. Le service TTS n'a pas été lancé pour ces tests à partir d'un WAV.

Comparaison supplémentaire avec GPU déjà chargé, mêmes image, WAV et seed,
cache natif activé dans les deux cas, **256×144 et 4 étapes** :

| Batch Wan | Temps de génération mesuré |
| --- | ---: |
| Ancien comportement : 2 vidéos pour 2 blocs | 39,144 s |
| Correctif : 1 vidéo pour 2 blocs | 20,064 s |

Soit environ 49 % de temps en moins sur ce petit test. Il valide les extensions
et la réutilisation du cache, mais ne mesure pas le gain au profil Normal et
ne constitue pas une évaluation visuelle à 20 étapes. Les réglages de qualité
sont conservés ; un changement de batch peut toutefois modifier le rendu pour
un même seed. Les vidéos d'un seul bloc ne bénéficient pas de la correction du
batch ; le cache peut accélérer leurs générations successives.

## Jobs persistants

Les générations image, voix, vidéo test et Wan2.2 sont maintenant lancées comme des **jobs côté serveur**.

- La requête HTTP répond immédiatement avec un job.
- Fermer ou recharger l'onglet navigateur n'arrête pas la génération.
- Le statut courant est sauvegardé dans le `project.json` persistant.
- En rouvrant l'application, le projet indique automatiquement le job en cours.
- L'interface interroge l'état toutes les 2 secondes et affiche une barre de progression.
- Pour Wan2.2, la progression affiche le segment courant lorsqu'il y en a plusieurs.
- Les 20 derniers jobs terminés sont conservés dans `jobHistory`.

### Important

La fermeture de **l'onglet ou de la fenêtre du navigateur** n'arrête plus une génération. En revanche, arrêter le processus Node (`./start.sh`), éteindre la machine ou redémarrer le serveur interrompt le job. Au redémarrage, un ancien job encore marqué `running` est automatiquement indiqué comme **interrompu**.

## Modes vidéo

- Auto
- Continu
- Long segments
- Safe

La durée finale est pilotée par le WAV.

## Démarrage

```bash
cp .env.example .env
./start.sh
```

Puis ouvrir :

```text
http://127.0.0.1:3010
```


## Nouveauté v0.4.1

- Affichage de l'avancement détaillé pour les vidéos Wan2.2 : pourcentage, segment courant/total, durée de vidéo déjà traitée, durée totale audio et estimation du temps restant.


## Nouveauté v0.4.2

- Suppression du timeout applicatif sur la génération **vidéo Wan2.2-S2V**.
- L'application attend désormais **sans limite de temps** la sortie vidéo de ComfyUI pour Wan2.2.
- Tant que ComfyUI continue de calculer, le job reste en cours au lieu d'échouer au bout de 90 minutes.


## Nouveauté v0.4.3

- Correction du mode **Continu** pour limiter la dérive du visage.
- Le mode continu n'envoie plus une seule génération vidéo géante à Wan2.2.
- Il utilise désormais des **blocs stabilisés d'au plus 8 secondes**, tous réancrés sur l'image originale de l'avatar.
- Résultat attendu : bien meilleure fidélité du visage, au prix de légers raccords possibles entre blocs.


## Nouveauté v0.4.4 — fidélité image source

- Nouveau mode **Image stricte** (par défaut) : aucun prompt positif n'est envoyé à Wan2.2-S2V.
- L'image importée est copiée telle quelle vers ComfyUI quand le cadrage **Original** est choisi : pas de resize, crop, sharpen ou conversion par l'étape vidéo.
- Prompt mouvement disponible uniquement en mode **Créatif**.
- Nouveau choix de cadrage : **Original**, **Fit**, **Crop**.
- Le négatif du mode strict renforce explicitement la lutte contre le changement d'identité et le face morphing.
- Le mode continu reste **stabilisé par blocs de 8 s** et la génération vidéo reste **sans timeout applicatif**.


## Nouveauté v0.4.5

- Le **nom du projet est obligatoire** à la création.
- Les dossiers projet portent maintenant un nom lisible : `Nom-du-projet--xxxxxxxx`.
- Les anciens projets stockés dans des dossiers UUID sont détectés et migrés automatiquement au démarrage.
- Les fichiers projet sont servis par l’ID interne, donc renommer un projet/dossier ne casse plus les aperçus.
- Le stockage reste externe à l’application via `DGX_AVATAR_DATA_DIR`.


## Nouveauté v0.5.0

- Nouveau moteur vidéo **Wav2Lip** intégré tout en gardant la même interface.
- Wav2Lip devient le moteur par défaut pour les avatars parlants, car il préserve mieux le visage d'une image source fournie par l'utilisateur.
- Wan2.2-S2V reste disponible comme moteur alternatif plus génératif.
- Nouvelle configuration `.env` : `WAV2LIP_DIR`, `WAV2LIP_PYTHON`, `WAV2LIP_CHECKPOINT`.


## Nouveauté v0.5.1

- Wan2.2-S2V reste le moteur de qualité principal.
- Modes Auto/Continu : blocs d'environ 10 secondes avec 0,75 s de chevauchement.
- Assemblage vidéo par `xfade` pour masquer les coupures entre blocs.
- La piste audio finale est le WAV original complet : pas de raccord audio AAC entre segments.


## Nouveauté v0.5.2

- Wan2.2 reste le moteur vidéo principal de qualité.
- Segments longs limités à environ **9,5 s** pour rester dans la zone où l'identité est la plus stable.
- **1,25 s de chevauchement audio/vidéo** entre segments.
- Remplacement du simple fondu par un **morphing optical-flow** frame par frame.
- Correction colorimétrique légère entre les deux segments avant morphing pour réduire les variations d'arrière-plan et d'exposition.
- Le **WAV original complet** est réinjecté à la fin pour éviter toute rupture audio.
- Le morphing utilise `MORPH_PYTHON`, par défaut le Python ComfyUI déjà équipé d'OpenCV sur le DGX Spark.

## v0.6.0 — Wan2.2 S2V Extend natif

- Suppression complète de Wav2Lip de l'application.
- Suppression du morphing / xfade externe pour les longues vidéos.
- Longue durée réalisée avec `WanSoundImageToVideoExtend` et `LatentConcat` natifs ComfyUI.
- Chunk officiel : 77 frames à 16 fps.
- Un seul WAV complet est encodé ; les extensions se décalent à partir du latent précédent.
- Le latent complet n'est décodé qu'une fois à la fin, puis la vidéo est coupée exactement à la durée audio.
- Aucun timeout applicatif sur la génération Wan2.2.


## Édition benchmark DGX Spark (v0.7.0-benchmark)

Interface : `http://127.0.0.1:3010/benchmark.html`

Cette page mesure le débit Wan2.2 avec la même paire image + WAV. Chaque répétition utilise un seed différent pour forcer un vrai sampling.

- mode séquentiel : un seul worker ComfyUI ;
- mode parallèle : 1 à 4 workers ComfyUI distincts ;
- nombre total de générations configurable ;
- temps global du batch + temps de chaque génération ;
- débit en jobs/minute ;
- journal JSON persistant dans `~/dgx-avatar-studio-data/benchmarks/logs`.

Pour démarrer jusqu'à 4 workers :

```bash
./scripts/start-benchmark-workers.sh 4
```

Pour couper uniquement les workers supplémentaires 8189-8191 :

```bash
./scripts/stop-benchmark-workers.sh
```

Attention : plusieurs workers chargent chacun leurs propres poids/activations sur le même DGX Spark. Le test peut donc saturer la mémoire unifiée à 3 ou 4 workers ; un échec/OOM est lui-même un résultat utile du benchmark.
