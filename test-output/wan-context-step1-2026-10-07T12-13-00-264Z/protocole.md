# Étape 1 — contexte de mouvement réencodé

Une seule variable est changée : les 73 dernières images décodées sont réencodées par le VAE avant chaque extension. Un proxy conserve le nombre total de latents, pour préserver la position audio native. Le proxy sert uniquement au conditionnement d’Extend ; le latent cumulé d’origine reste utilisé pour le montage final.

Référence : `../wan-extend-2026-10-07T09-03-12-917Z/`. Le robot, le WAV complet de 67,382 s (SHA-256 identique), le prompt, le checkpoint BF16, la résolution 384 × 512, les 20 étapes, le CFG 6, le shift 8 et le seed fixe 123456 sont conservés. Aucun reset indépendant, découpage audio ou traitement de couleur n’est ajouté.

Le rendu reste expérimental et n’est pas activé dans l’application. La validation humaine du robot, de ses matériaux, du fond et du mouvement de bouche après 45 s est nécessaire avant une étape suivante.
