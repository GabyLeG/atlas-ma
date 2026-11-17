# Méthodologie

## 1. Des liasses fiscales aux états financiers

Chaque ligne de la liasse (régime normal, CERFA 2050 à 2053) a un code à deux caractères. Les codes utilisés sont listés dans `pipeline/liasse.py` (`CODES`).

| Agrégat | Calcul |
|---|---|
| Chiffre d'affaires | FL |
| EBITDA (EBE) | FL + FM + FN + FO − (FS + FT + FU + FV + FW + FX + FY + FZ) |
| Amortissements | GA |
| EBIT | GG (résultat d'exploitation) |
| Intérêts | GR |
| Dette financière | DS + DT + DU + DV |
| Trésorerie | (CD − CE) + (CF − CG) |
| BFR d'exploitation | stocks nets + créances clients nettes − fournisseurs (DX) − dettes fiscales et sociales (DY) |
| Immobilisations nettes | BJ − BK |

**Contrôles** (une société dont le dernier dépôt échoue est exclue) : FR = FL + FM + FN + FO + FP + FQ ; GF = somme des charges d'exploitation ; GG = FR − GF ; total actif net = total passif (EE). Tolérance : 2 000 € ou 1 %. Le nombre d'échecs par contrôle est affiché dans le journal de chaque mise à jour : si la correspondance des codes était fausse, presque toutes les sociétés échoueraient et cela se verrait immédiatement.

## 2. Coût du capital (WACC)

- Taux sans risque : **OAT 10 ans** du jour (BCE).
- Bêta : bêta désendetté du secteur (Damodaran, Europe, corrigé de la trésorerie), réendetté avec la structure moyenne du secteur : β = βu × (1 + (1 − t) × D/E).
- Prime de risque : prime des marchés matures de Damodaran.
- **Prime de taille et d'illiquidité** (hypothèse, modifiable) : 4 % sous 10 M€ de CA, 3 % sous 50 M€, 2 % sous 250 M€, 1 % au-delà.
- Coût de la dette : **Euribor 3 mois** du jour + marge de crédit tirée d'une notation synthétique (couverture des intérêts EBIT / intérêts, grille Damodaran pour petites entreprises, marges de janvier 2026).
- WACC = E/V × Ke + D/V × Kd × (1 − 25 %).

## 3. DCF

- Croissance de l'année 1 = taux de croissance annuel moyen du CA sur les exercices publiés, borné entre −5 % et +20 % ; elle converge linéairement vers la croissance à l'infini (2 %) en année 5.
- Marge d'EBITDA = moyenne des trois derniers exercices.
- Amortissements, investissements et BFR proportionnels au CA : investissements = amortissements + (immobilisations nettes / CA) × hausse du CA ; variation du BFR = (BFR / CA) × hausse du CA.
- Impôt à 25 % sur l'EBIT positif.
- Valeur terminale (formule de Damodaran sans création de valeur au-delà de l'horizon) : NOPAT × (1 + g) × (1 − g / WACC) / (WACC − g). Nulle si le NOPAT de l'année 5 est négatif.

## 4. Multiples

VE = EBITDA × multiple VE/EBITDA du secteur (sociétés cotées européennes, Damodaran) × (1 − 20 % de décote de non-cotation). Pas de valeur si l'EBITDA est négatif.

**Valeur centrale** = moyenne du DCF (s'il est positif) et des multiples. Valeur des fonds propres = VE − dette nette.

## 5. Test de LBO

Prix d'entrée = valeur par multiples + 3 % de frais. Dette = min(4 × EBITDA, 70 % du prix), au taux Euribor + 4,5 %. Les flux du DCF, après intérêts, remboursent la dette. Sortie en année 5 au même multiple d'EBITDA. TRI = (fonds propres à la sortie / fonds propres investis)^(1/5) − 1.

## 6. Score d'attractivité (0 à 100)

Moyenne pondérée des rangs centiles dans l'univers : croissance 25 %, marge par rapport à la médiane de la division NAF 25 %, conversion de l'EBITDA en flux de trésorerie (année 1) 15 %, faible dette nette / EBITDA 15 %, TRI du test de LBO 20 %. Un facteur manquant est ignoré et les poids sont renormalisés.

## 7. Limites connues

- Les comptes ont quelques mois de retard sur l'activité.
- Aucun retraitement automatique (rémunération du dirigeant, exceptionnel, crédit-bail, loyers IFRS 16).
- Les sociétés d'un groupe sont valorisées sur leurs comptes sociaux, sans consolidation.
- La correspondance NAF → secteur Damodaran (`data/sectors.json`) est un choix d'analyste.
- Le multiple sectoriel vient de sociétés cotées ; la décote de 20 % est une convention, à discuter au cas par cas.
