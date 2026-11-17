# Atlas M&A

Carte et valorisation des PME françaises dont les comptes sont **publics, complets et récents**.

- **Carte** : toutes les sociétés retenues, placées à leur siège, colorées par score, marge, croissance ou VE/EBITDA.
- **Liste** : tableau triable sur chaque colonne (CA, EBITDA, marge, croissance, dette nette, valeur DCF, valeur par multiples, VE/EBITDA, TRI de LBO, score), export CSV.
- **Analyse** : pour une société, DCF sur 5 ans, WACC détaillé, multiple d'EBITDA sectoriel, test de LBO, comparables, hypothèses modifiables au curseur, et **export Excel avec les formules**.

Les données se mettent à jour **chaque nuit** (GitHub Actions) : nouveaux dépôts de comptes, Euribor 3 mois et OAT 10 ans du jour.

## Règle d'inclusion

Une société apparaît seulement si :
1. son dernier exercice est clos depuis **moins de 18 mois** ;
2. ses comptes sont **publics** (pas d'option de confidentialité) et déposés au **régime normal** (liasse complète 2050 à 2053) ;
3. son chiffre d'affaires est d'au moins **2 M€** ;
4. ses comptes passent les **contrôles comptables** (les produits et charges s'additionnent, le bilan est équilibré).

Sont exclus : holdings, banques, assurances, administrations, associations et entrepreneurs individuels.

## Sources (toutes gratuites)

| Donnée | Source |
|---|---|
| Comptes annuels (liasse fiscale) | INPI, via « Données financières détaillées des entreprises » (data.gouv.fr, Signaux Faibles) |
| Nom, secteur NAF, siège, effectif | Base SIRENE de l'INSEE (data.gouv.fr) |
| Coordonnées de repli | geo.api.gouv.fr (centre de la commune) |
| OAT 10 ans, Euribor 3 mois | BCE, data portal (séries `IRS.M.FR.L.L40.CI.0000.EUR.N.Z`, `FM.M.U2.EUR.RT.MM.EURIBOR3MD_.HSTA`) |
| Bêtas et multiples par secteur (Europe) | Aswath Damodaran, NYU Stern (mis à jour chaque janvier) |
| Prime de risque, marges de crédit | Damodaran |

Aucune clé d'API, aucun mot de passe, aucune donnée confidentielle.

## Lancer en local

```bash
pip install -r requirements.txt
python -m pytest -q                         # tests (Node.js requis pour le test de parité Python/JS)
python -m pipeline.build --sample --offline # données fictives, pour travailler sur le design
python -m pipeline.build                    # vraies données (télécharge ~3 Go, 20 à 60 min)
cd site && python -m http.server 8000       # puis ouvrir http://localhost:8000
```

## Organisation du code

| Dossier / fichier | Rôle |
|---|---|
| `pipeline/config.py` | Toutes les hypothèses et la règle d'inclusion, au même endroit |
| `pipeline/liasse.py` | Liasse fiscale → états financiers, contrôles comptables |
| `pipeline/companies.py` | Sélection des sociétés à comptes récents (DuckDB sur le parquet data.gouv) |
| `pipeline/sirene.py` | Nom, NAF, siège et coordonnées (SIRENE) |
| `pipeline/market.py` | Taux du jour (BCE) et tables Damodaran, avec valeurs de repli |
| `pipeline/valuation.py` | WACC, DCF, multiples, LBO : **le moteur de référence** |
| `pipeline/build.py` | Assemble le tout, calcule le score, écrit `site/data/` |
| `web/valuation.js` | Copie exacte du moteur en JavaScript (recalcul en direct) |
| `web/app.js`, `web/app.css`, `web/index.html` | Interface : carte, liste, analyse |
| `web/excel.js` | Export du modèle Excel avec formules |
| `data/` | Secteurs NAF → Damodaran, contours des départements, valeurs de repli |
| `tests/` | Tests du moteur (valeurs vérifiées à la main), du SQL, de la parité Python/JS |

## Répartition proposée pour le groupe (une branche et des PR par personne)

1. **Données entreprises** : `companies.py`, `sirene.py`, `liasse.py`
2. **Données de marché et mise à jour** : `market.py`, workflow GitHub Actions
3. **Moteur de valorisation** : `valuation.py`, `valuation.js`, tests de parité
4. **Interface carte et liste** : `app.js` (carte, filtres, liste), `app.css`
5. **Analyse et export** : `app.js` (vue analyse), `excel.js`, méthodologie

Voir `docs/METHODOLOGY.md` pour le détail des calculs et `AGENTS.md` pour les règles de contribution.

*Outil d'aide à l'analyse, pas un conseil en investissement.*
