# Recherche Wan-S2V — 7 octobre 2026

Le rendu continu de 67,382 secondes a été refusé : texture métallique et fond dégradés en fin de vidéo. Le WAV était intact et les images finales correspondaient aux images natives. La coupe audio et l’export ne suffisent donc pas à expliquer les défauts observés.

## Pistes vérifiées dans les sources primaires

1. **Paramètres d’origine Wan** : shift 3, CFG 4,5, 40 étapes. Le rendu refusé utilisait shift 8, CFG 6, 20 étapes. ComfyUI documente bien 20 étapes et CFG 6 : cette différence ne démontre pas une erreur, mais fournit une comparaison utile.
   Sources : https://github.com/Wan-Video/Wan2.2/blob/main/wan/configs/wan_s2v_14B.py ; https://docs.comfy.org/tutorials/video/wan/wan2-2-s2v

2. **Contexte de mouvement** : Wan décode puis réencode les images récentes pour la passe suivante, avec seed + numéro de passe. Extend natif ComfyUI transmet directement les 19 derniers latents ; notre graphe conserve le même seed. Hypothèse à tester : ces différences peuvent contribuer à la propagation des défauts. Leur effet sur ce robot reste inconnu.
   Sources : https://github.com/Wan-Video/Wan2.2/blob/main/wan/speech2video.py ; https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_wan.py

3. **Fenêtres de contexte S2V** : support spécifique intégré dans ComfyUI le 20 mars 2026. `ContextWindowsManual` et `WanContextWindowsManual` sont exposés par l’installation locale 0.28.2. Le code indique un mode expérimental. Cette stratégie se teste séparément et ne constitue pas un correctif déjà validé.
   Sources : https://github.com/Comfy-Org/ComfyUI/pull/12645 ; https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_context_windows.py

4. **BF16 et absence de LoRA rapide** : ces précautions sont déjà appliquées au test refusé. La documentation ComfyUI recommande BF16 et signale une perte de qualité avec la LoRA Lightning employée par son exemple rapide ; cela ne fournit pas une correction supplémentaire au cas présent.
   Source : https://docs.comfy.org/tutorials/video/wan/wan2-2-s2v

5. **Alternatives avec vidéo de référence** : InfiniteTalk propose le guidage par vidéo et reconnaît des dérives de couleur au-delà d’une minute en génération depuis une seule image. Cela nécessite une autre méthode et ne garantit pas une résolution du problème. À garder en recours si Wan-S2V reste insuffisant.
   Source : https://github.com/MeiGen-AI/InfiniteTalk

## Protocole proposé

Conserver le même robot, le WAV complet et la résolution 384 × 512. Comparer la transmission du contexte et le seed en gardant les autres paramètres fixes ; comparer ensuite le profil Wan 3 / 4,5 / 40. Vérifier 0, 30, 45, 50, 60 et 66 secondes. La continuité de la bouche, la forme du robot, les textures et le fond restent les critères de validation humaine.

Aucun nouveau rendu GPU ni changement des réglages de production n’a été effectué durant cette recherche. Les pistes sont des expériences à valider, pas des solutions garanties.
