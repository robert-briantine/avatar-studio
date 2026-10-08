# Règles de stabilité du visage — recherche du 8 octobre 2026

## Conclusions applicables au projet

Les tests visage actuellement lancés modifient uniquement le prompt positif. Ce n’est pas un verrou des pixels du visage : une amélioration reste à vérifier. Aucun nouveau réglage n’a été ajouté en cours de calcul.

1. **Garder l’image originale comme référence d’identité de chaque passe.** Wan encode la référence séparément du contexte de mouvement. Le projet le fait déjà : conserver ce comportement et vérifier les liens ref_image dans chaque workflow. Source : https://github.com/Wan-Video/Wan2.2/blob/main/wan/speech2video.py

2. **Ne pas considérer les images récentes générées comme une vérité sur l’identité.** AsymTalker décrit une dérive en cascade propagée par les références de continuité générées. Le réencodage VAE de notre pipeline renouvelle la représentation du contexte ; il ne restaure pas automatiquement les détails perdus. Piste pour Wan : tester un réancrage visuel propre à intervalles contrôlés. C’est une hypothèse d’adaptation, pas la méthode AsymTalker : cette dernière utilise un entraînement/distillation spécifique. Source : https://arxiv.org/abs/2605.02948

3. **Une vidéo de référence apporte davantage de contrôle qu’un prompt seul.** InfiniteTalk conserve des images de référence pour guider identité, décor et caméra, et utilise des images de contexte pour la continuité. Ses auteurs signalent aussi une dérive de couleur au-delà d’une minute en image-to-video. Le principe est pertinent ; ses réglages ne se transposent pas directement à Wan S2V. La branche control_video de Wan est un conditionnement supplémentaire, pas une garantie de conservation du visage. Sources : https://meigen-ai.github.io/InfiniteTalk/ ; https://github.com/MeiGen-AI/InfiniteTalk ; https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_wan.py

4. **Si la priorité est la conservation du visage, réduire la région qui peut être réinventée.** Les méthodes de lip-sync par inpainting (MuseTalk, LatentSync) travaillent dans une région faciale limitée. Proposition d’architecture : conserver les pixels d’une référence propre hors du masque bouche/mâchoire et animer la région nécessaire à la parole. La conservation hors masque dépend du montage ; les mouvements de tête doivent être alignés pour éviter une bouche flottante ou des raccords visibles. MuseTalk reconnaît des pertes de détails de moustache, de forme/couleur de lèvres et du jitter : ce n’est pas une solution garantie pour Robert. Sa généralisation à l’anatomie extraterrestre n’est pas démontrée par les benchmarks humains. Sources : https://github.com/TMElyralab/MuseTalk ; https://github.com/bytedance/LatentSync

5. **Conserver BF16 et éviter les accélérateurs non adaptés au modèle.** ComfyUI recommande BF16 pour réduire la dégradation et indique que sa LoRA Lightning non spécialisée S2V entraîne des pertes de qualité et de dynamique. Ce principe est déjà appliqué. Il ne garantit pas une identité stable. Source : https://docs.comfy.org/tutorials/video/wan/wan2-2-s2v

6. **Traiter les valeurs officielles comme un profil à comparer, pas comme une preuve.** Wan S2V configure shift 3, 40 étapes, CFG 4,5 ; ComfyUI documente aussi 20 étapes, CFG 6. Il n’y a pas de preuve dans ces sources qu’augmenter les étapes ou baisser CFG suffise à corriger notre dérive. Prochaine comparaison possible après validation : CFG 6 → 4,5 seul, puis shift 8 → 3 seul, puis 20 → 40 étapes seul. Ne pas modifier trois paramètres ensemble si l’on veut identifier leur contribution. Sources : https://github.com/Wan-Video/Wan2.2/blob/main/wan/configs/wan_s2v_14B.py ; https://docs.comfy.org/tutorials/video/wan/wan2-2-s2v

## Protocole proposé après les rendus en cours

- Valider d’abord les deux variantes visage actuellement en cours/file, sans modifier leur workflow pendant l’exécution.
- Conserver pour chaque personnage l’image et le WAV complets avec leur SHA-256, les mêmes graines et la même résolution.
- Comparer au début, à 30, 60, 88 secondes pour Robert ; ajouter 90, 120 et 121 secondes pour l’extraterrestre. Les mesures automatiques de durée et d’intégrité ne valident pas l’identité.
- Robert : surveiller yeux, nez, mâchoire, barbe, marques noires et implants. Extraterrestre : yeux et iris, antennes, oreilles, proportions, peau verte.
- Noter séparément identité, netteté, couleurs, synchronisation de bouche et raccords. Éviter de prendre le clignement ou l’articulation normale pour un changement d’identité.
- Si le prompt est insuffisant, commencer par une comparaison de paramètres isolés. Un test avec ancrages visuels ou masque bouche demande un prototype distinct et une vérification des raccords. Les méthodes de reconnaissance de visages humains ne constituent pas un arbitre fiable pour l’extraterrestre.

Aucune des sources consultées ne fournit un réglage unique garantissant la stabilité indéfinie de Wan S2V, ni une validation spécifique à nos deux personnages.
