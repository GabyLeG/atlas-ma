# Atlas M&A

Carte et valorisation des PME françaises dont les comptes sont **publics, complets et récents**.

- **Carte** : toutes les sociétés retenues, placées à leur siège, colorées par score, marge, croissance ou VE/EBITDA.
- **Liste** : tableau triable sur chaque colonne (CA, EBITDA, marge, croissance, dette nette, valeur DCF, valeur par multiples, VE/EBITDA, TRI de LBO, score), export CSV.
- **Analyse** : pour une société, DCF sur 5 ans, WACC détaillé, multiple d'EBITDA sectoriel, test de LBO, comparables, hypothèses modifiables au curseur, et **export Excel avec les formules**.

Les données se mettent à jour **chaque nuit** (GitHub Actions) : nouveaux dépôts de comptes, Euribor 3 mois et OAT 10 ans du jour.

## Règle d'inclusion (fiabilité)

Un acheteur demandera toujours les **derniers comptes**. Une société n'apparaît donc que si :
1. **les derniers comptes exigibles sont déposés** : approbation sous 6 mois, dépôt sous 2 mois, donc les comptes d'un exercice sont dus 8 mois après la clôture. Une société dont la dernière clôture date de plus de 20 mois est en retard et n'apparaît pas ;
2. ces comptes viennent de l'**API officielle de l'INPI**, sont **publics**, au **régime normal** (liasse complète), sur **12 mois**, en **euros**, et saisis par l'INPI **sans anomalie** (code qualité 0) ;
3. ils passent les **contrôles comptables** (produits et charges qui s'additionnent, bilan équilibré, résultat cohérent) ;
4. le chiffre d'affaires atteint **2 M€**.

Chaque fiche affiche la date de dépôt, les contrôles passés et un lien vers le dépôt officiel sur data.inpi.fr. Les chiffres publiés (CA, EBITDA, dette, trésorerie) sont repris tels quels ; la valeur d'entreprise, la valeur des fonds propres et le TRI sont des estimations du modèle.

### Brancher l'API INPI (une fois)
1. Créer un compte gratuit sur https://data.inpi.fr (aucune validation nécessaire).
2. Dans GitHub : Settings → Secrets and variables → Actions → New repository secret : `INPI_USERNAME` (l'email du compte) et `INPI_PASSWORD`.
3. Relancer « Mise à jour nocturne » dans Actions. Quota INPI : 10 000 appels par jour ; la mise à jour en utilise environ 1 000 à 2 000.

## Sources (toutes gratuites)

| Donnée | Source |
|---|---|
| Derniers comptes annuels | API officielle de l'INPI (Registre national des entreprises), mise à jour chaque jour |
| Historique des comptes | INPI, via « Données financières détaillées des entreprises » (data.gouv.fr, Signaux Faibles) |
| Nom, secteur NAF, siège, effectif | Base SIRENE de l'INSEE (data.gouv.fr) |
| Coordonnées de repli | geo.api.gouv.fr (centre de la commune) |
| OAT 10 ans, Euribor 3 mois | BCE, data portal (séries `IRS.M.FR.L.L40.CI.0000.EUR.N.Z`, `FM.M.U2.EUR.RT.MM.EURIBOR3MD_.HSTA`) |
| Bêtas et multiples par secteur (Europe) | Aswath Damodaran, NYU Stern (mis à jour chaque janvier) |
| Prime de risque, marges de crédit | Damodaran |

Les identifiants INPI sont des secrets GitHub : jamais dans le code ni dans Git. Aucune donnée confidentielle.

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
| `pipeline/companies.py` | Candidats (parquet data.gouv), fusion avec l'API INPI, règle d'inclusion |
| `pipeline/inpi.py` | Client de l'API INPI et contrôles de fiabilité des dépôts |
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
