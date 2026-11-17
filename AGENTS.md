# Règles de contribution (humains et assistants IA)

1. **Une branche par tâche, une petite PR relue par un autre membre.** La branche `main` est protégée. Pour un travail à deux, ajoutez `Co-authored-by:` au commit.
2. **`pipeline/valuation.py` est la référence.** Toute modification du calcul doit être faite aussi dans `web/valuation.js` ; `tests/test_parity.py` doit passer.
3. **Ne jamais modifier une valeur attendue dans un test pour le faire passer.** Les valeurs de `tests/test_pipeline.py` sont vérifiées à la main ; si le calcul change volontairement, recalculez-les à la main et expliquez pourquoi dans la PR.
4. **Toute hypothèse va dans `pipeline/config.py`**, avec sa justification en commentaire.
5. **Données : uniquement des sources publiques et gratuites.** Aucune donnée client, aucune information confidentielle (stage compris), aucune clé d'API ni mot de passe dans le code, dans Git ou dans un prompt.
6. **Vie privée** : pas de noms de dirigeants, pas d'entrepreneurs individuels, uniquement les unités légales en diffusion publique (SIRENE).
7. Avant chaque PR : `python -m pytest -q` et `python -m pipeline.build --sample --offline` puis un coup d'œil au site.
8. Tout usage d'un assistant IA est noté dans le rapport d'usage de l'IA du projet (ce qui a été demandé, ce qui a été vérifié).
