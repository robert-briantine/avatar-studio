# Recherche et protocole — 8 octobre 2026

Le retour utilisateur confirme une amélioration du flou et de la stabilité, mais signale une évolution du personnage par rapport à l’original. La stabilité du cadrage ne suffit donc pas à valider la fidélité de l’identité.

## Sources primaires consultées

- https://github.com/Wan-Video/Wan2.2/blob/main/wan/configs/wan_s2v_14B.py : profil S2V de référence, shift 3, 40 étapes, CFG 4,5 ; contexte de mouvement 73 images.
- https://github.com/Wan-Video/Wan2.2/blob/main/wan/speech2video.py : référence d’image encodée et conservée entre les passes ; images de mouvement réencodées et seed + index. Ces deux dernières pratiques sont déjà présentes dans le rendu étape 3. Le code documente aussi une branche pose_video et init_first_frame ; elles ne constituent pas une garantie de fidélité des textures.
- https://docs.comfy.org/tutorials/video/wan/wan2-2-s2v : exemple natif 20 étapes / CFG 6 ; BF16 conseillé pour réduire les pertes de qualité ; la LoRA Lightning peut dégrader la qualité et le mouvement. BF16 est déjà utilisé, aucune LoRA rapide dans ce test.
- https://github.com/MeiGen-AI/InfiniteTalk : les auteurs reconnaissent une dérive des couleurs au-delà d’une minute en image-to-video ; suggèrent une vidéo de contrôle dérivée de l’image pour les longues durées. C’est une autre méthode et non un correctif transposable directement au control_video Wan S2V.

## Test réalisé ici

Un seul profil expérimental : 40 étapes / CFG 4,5 / shift 3, comparé au dernier rendu étape 3 de 67,382 s. Il change trois réglages simultanément ; aucune attribution causale à un seul paramètre n’est possible. UniPC/simple de ComfyUI est conservé : on ne reproduit pas exactement le scheduler de l’inférence officielle Wan.

Le robot, le WAV intégral, les SHA-256, BF16, la résolution 384 × 512, les graines progressives, les prompts, le contexte réencodé et la continuité Extend sont conservés. Aucun reset indépendant ni retouche d’identité ou de couleur. Les réglages de production ne sont pas modifiés.

À la fin : vérification automatique du WAV, de la durée et des empreintes des images natives ; captures à 0, 10, 30, 45, 50, 60 et 66 s. La page validation.html montre l’original et les deux vidéos et permet de démarrer aux mêmes instants.

Critères humains : géométrie de tête et des yeux, composants métalliques, détails, matériau, couleurs, fond, mouvement de bouche. Les différences de pose ou d’expression ne doivent pas être confondues avec une nouvelle identité. Une mesure de similarité globale des pixels ne suffit pas à prouver la conservation d’identité d’un robot animé.

Le test est limité à 67 s et à une paire image/audio. Même une validation positive ne prouve pas une stabilité sur plusieurs minutes. Après validation, un rendu de durée supérieure sera nécessaire. Si la dérive persiste, tester séparément le guidage de pose vidéo ou une stratégie de réancrage, en surveillant les raccords et la synchronisation.
