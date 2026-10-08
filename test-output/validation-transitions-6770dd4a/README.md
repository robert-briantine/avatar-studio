# Exemples de montage — test 6770dd4a

Ouvrir d’abord [comparaison-4-variantes.mp4](comparaison-4-variantes.mp4) pour voir les quatre propositions simultanément, avec une seule piste audio.

Les reprises se situent à **4,50 s**, **9,67 s** et **12,92 s**. Regarder aussi la seconde qui suit chaque reprise : c’est là que le nouveau morceau change de pose et de contraste.

| Version | Fichier | Effet à comparer |
| --- | --- | --- |
| Référence | [00-reference-originale.mp4](00-reference-originale.mp4) | Copie exacte de ton dernier test. |
| 1 | [01-fondu-court.mp4](01-fondu-court.mp4) | Fondu de 0,20 s : reprise rapide. |
| 2 | [02-fondu-doux.mp4](02-fondu-doux.mp4) | Fondu de 0,40 s : plus progressif, mais peut dédoubler le visage. |
| 3 | [03-mouvement-interpole.mp4](03-mouvement-interpole.mp4) | Images intermédiaires du mouvement et passage progressif entre les poses sur 0,30 s. |
| 4 | [04-reprise-reconstruite.mp4](04-reprise-reconstruite.mp4) | Passage entre deux poses réelles sur 0,50 s, en évitant les premières images instables du nouveau morceau. |

Les quatre variantes adoucissent également l’évolution de la lumière autour des reprises à partir du fond de l’image. Elles conservent le son exact et la durée du test : **23,52 s à 48 images/s**. Elles peuvent rendre les premiers mouvements de bouche plus progressifs ; vérifier aussi la synchronisation des premières syllabes, particulièrement pour la version 4 qui reconstruit les premières 0,375 s du nouveau morceau.

[comparaison-raccord-2-ralenti.mp4](comparaison-raccord-2-ralenti.mp4) montre la deuxième reprise à demi-vitesse, sans son.

Pour valider, indiquer **1, 2, 3 ou 4**, et préciser si la lumière ou le mouvement reste gênant. Ces fichiers sont des exemples de comparaison ; le réglage de l’application n’a pas été changé pendant leur création.

Les vérifications de durée, de cadence et d’identité de la piste audio sont enregistrées dans [variantes.json](variantes.json). Le script [creer-exemples.py](creer-exemples.py) permet de reproduire les quatre montages avec le Python de ComfyUI.
