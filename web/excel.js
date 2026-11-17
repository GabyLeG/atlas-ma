/* Excel export: a live model (formulas, not frozen values) that reproduces the app's DCF, WACC and multiples. */
(function (root) {
  "use strict";
  const LIB = "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js";
  let loading;
  function lib() {
    if (root.ExcelJS) return Promise.resolve(root.ExcelJS);
    loading = loading || new Promise((ok, ko) => {
      const s = document.createElement("script");
      s.src = LIB; s.onload = () => ok(root.ExcelJS); s.onerror = () => ko(new Error("ExcelJS indisponible"));
      document.head.appendChild(s);
    });
    return loading;
  }
  const K = (e) => (e === null || e === undefined ? null : e / 1000);
  const PCT = "0.00%", KEUR = '#,##0;[Red]-#,##0', X = '0.0"x"';

  function style(ws) {
    ws.getColumn(1).width = 44;
    for (let c = 2; c <= 8; c++) ws.getColumn(c).width = 14;
    ws.getRow(1).font = { bold: true, size: 14 };
  }
  function head(ws, r, labels) {
    const row = ws.getRow(r);
    labels.forEach((l, i) => { const c = row.getCell(i + 1); c.value = l; c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D1B2A" } }; });
  }

  async function build(o) {
    const ExcelJS = await lib();
    const wb = new ExcelJS.Workbook();
    wb.creator = "Atlas M&A"; wb.created = new Date();
    wb.calcProperties.fullCalcOnLoad = true;
    const v = o.v, w = v.wacc, d = v.dcf, p = v.params, m = o.meta.market;

    /* Hypothèses */
    const H = wb.addWorksheet("Hypotheses");
    style(H); H.getColumn(3).width = 70;
    H.getCell("A1").value = `${o.name} (SIREN ${o.siren}) · modèle de valorisation`;
    head(H, 2, ["Hypothèse", "Valeur", "Source / commentaire"]);
    const hyp = [
      ["Taux sans risque (OAT 10 ans)", w.rf, PCT, `BCE, ${m.rates.oat10.date}`],
      ["Prime de risque du marché", w.erp, PCT, m.erp.source],
      ["Bêta désendetté du secteur", w.beta_u, "0.00", `${o.sector.industry} · ${m.betas_source.source}`],
      ["Dette / fonds propres cible", w.de, PCT, "Structure moyenne du secteur (Damodaran)"],
      ["Prime de taille et d'illiquidité", w.size_premium, PCT, "Hypothèse selon le chiffre d'affaires"],
      ["Euribor 3 mois", w.euribor, PCT, `BCE, ${m.rates.euribor3m.date}`],
      ["Marge de crédit", w.spread, PCT, `Notation synthétique ${w.rating} (Damodaran)`],
      ["Taux d'impôt sur les sociétés", p.tax, PCT, "Taux normal de l'IS"],
      ["Croissance du CA, année 1", d.g0, PCT, "Croissance annuelle historique (bornée)"],
      ["Croissance à l'infini", p.g_terminal, PCT, "Proche de l'inflation cible"],
      ["Marge d'EBITDA projetée", d.margin, PCT, "Moyenne des 3 derniers exercices"],
      ["Amortissements / CA", d.da_pct, PCT, "Dernier exercice"],
      ["Immobilisations nettes / CA", d.capital_intensity, "0.00", "Investissement net par euro de CA supplémentaire"],
      ["BFR / CA", d.bfr_pct, PCT, "Dernier exercice"],
      ["Multiple VE/EBITDA du secteur", v.multiple.multiple, "0.0", m.multiples_source.source],
      ["Décote de non-cotation", p.illiquidity, PCT, "Hypothèse usuelle pour une PME"],
      ["Dette financière (k€)", K(o.c.fin_debt), KEUR, `Comptes au ${o.closing}`],
      ["Trésorerie (k€)", K(o.c.cash), KEUR, `Comptes au ${o.closing}`],
      ["Chiffre d'affaires, dernier exercice (k€)", K(o.c.revenue), KEUR, `Comptes au ${o.closing}`],
      ["EBITDA, dernier exercice (k€)", K(o.c.ebitda), KEUR, `Comptes au ${o.closing}`],
      ["Ajustement du WACC", p.wacc_shift || 0, PCT, "0 par défaut"],
    ];
    hyp.forEach(([l, val, fmt, src], i) => {
      const r = H.getRow(3 + i);
      r.getCell(1).value = l; r.getCell(2).value = val; r.getCell(2).numFmt = fmt; r.getCell(3).value = src;
      r.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4D6" } };
    });
    const h = (n) => `Hypotheses!$B$${n}`;  // rows: rf 3, erp 4, bu 5, de 6, size 7, eur 8, spread 9, tax 10, g0 11, gT 12, margin 13, da 14, k 15, bfr 16, mult 17, illiq 18, debt 19, cash 20, rev 21, ebitda 22, shift 23

    /* WACC */
    const Wk = wb.addWorksheet("WACC");
    style(Wk);
    Wk.getCell("A1").value = "Coût moyen pondéré du capital";
    const wr = [
      ["Bêta réendetté", `${h(5)}*(1+(1-${h(10)})*${h(6)})`, "0.00"],
      ["Coût des fonds propres", `${h(3)}+B3*${h(4)}+${h(7)}`, PCT],
      ["Coût de la dette avant impôt", `${h(8)}+${h(9)}`, PCT],
      ["Poids de la dette", `${h(6)}/(1+${h(6)})`, PCT],
      ["Poids des fonds propres", "1-B6", PCT],
      ["WACC", `B7*B4+B6*B5*(1-${h(10)})+${h(23)}`, PCT],
      ["Croissance à l'infini retenue", `MIN(${h(12)},B8-0.005)`, PCT],
    ];
    wr.forEach(([l, f, fmt], i) => { const r = Wk.getRow(3 + i); r.getCell(1).value = l; r.getCell(2).value = { formula: f }; r.getCell(2).numFmt = fmt; });
    Wk.getRow(8).font = { bold: true };

    /* DCF */
    const D = wb.addWorksheet("DCF");
    style(D);
    D.getCell("A1").value = "Flux de trésorerie actualisés (k€)";
    head(D, 2, ["", "Réel", "A+1", "A+2", "A+3", "A+4", "A+5"]);
    const cols = ["C", "D", "E", "F", "G"];
    const set = (row, label, b, f, fmt) => {
      D.getCell(`A${row}`).value = label;
      if (b !== null) D.getCell(`B${row}`).value = b;
      cols.forEach((c, j) => { const prev = j === 0 ? "B" : cols[j - 1]; D.getCell(`${c}${row}`).value = { formula: f(c, prev) }; D.getCell(`${c}${row}`).numFmt = fmt; });
      D.getCell(`B${row}`).numFmt = fmt;
    };
    D.getCell("A3").value = "Année"; D.getCell("B3").value = 0; cols.forEach((c, j) => (D.getCell(`${c}3`).value = j + 1));
    set(4, "Croissance du CA", null, (c) => `${h(11)}+(WACC!$B$9-${h(11)})*(${c}3-1)/4`, PCT);
    set(5, "Chiffre d'affaires", { formula: h(21) }, (c, pv) => `${pv}5*(1+${c}4)`, KEUR);
    set(6, "EBITDA", { formula: h(22) }, (c) => `${h(13)}*${c}5`, KEUR);
    set(7, "Amortissements", null, (c) => `${h(14)}*${c}5`, KEUR);
    set(8, "EBIT", null, (c) => `${c}6-${c}7`, KEUR);
    set(9, "Impôt", null, (c) => `MAX(0,${c}8)*${h(10)}`, KEUR);
    set(10, "Résultat d'exploitation après impôt", null, (c) => `${c}8-${c}9`, KEUR);
    set(11, "Variation du CA", null, (c, pv) => `${c}5-${pv}5`, KEUR);
    set(12, "Investissements", null, (c) => `${c}7+${h(15)}*${c}11`, KEUR);
    set(13, "Variation du BFR", null, (c) => `${h(16)}*${c}11`, KEUR);
    set(14, "Flux de trésorerie disponible (FCFF)", null, (c) => `${c}10+${c}7-${c}12-${c}13`, KEUR);
    set(15, "Facteur d'actualisation", null, (c) => `(1+WACC!$B$8)^-${c}3`, "0.000");
    set(16, "Valeur actuelle", null, (c) => `${c}14*${c}15`, KEUR);
    D.getRow(14).font = { bold: true };
    const tot = [
      [18, "Somme des flux actualisés", "SUM(C16:G16)"],
      [19, "Valeur terminale", "IF(G10>0,G10*(1+WACC!B9)*(1-WACC!B9/WACC!B8)/(WACC!B8-WACC!B9),0)"],
      [20, "Valeur terminale actualisée", "B19*G15"],
      [21, "Valeur d'entreprise (DCF)", "B18+B20"],
      [22, "Dette nette", `${h(19)}-${h(20)}`],
      [23, "Valeur des fonds propres (DCF)", "B21-B22"],
    ];
    tot.forEach(([r, l, f]) => { D.getCell(`A${r}`).value = l; D.getCell(`B${r}`).value = { formula: f }; D.getCell(`B${r}`).numFmt = KEUR; });
    D.getRow(21).font = { bold: true }; D.getRow(23).font = { bold: true };

    /* Multiples */
    const Mu = wb.addWorksheet("Multiples");
    style(Mu);
    Mu.getCell("A1").value = "Valorisation par multiple d'EBITDA";
    [["EBITDA (k€)", h(22), KEUR], ["Multiple VE/EBITDA du secteur", h(17), "0.0"], ["Décote de non-cotation", h(18), PCT],
      ["Multiple appliqué", "B4*(1-B5)", "0.0"], ["Valeur d'entreprise (k€)", 'IF(B3>0,B3*B6,"n.s.")', KEUR], ["Valeur des fonds propres (k€)", 'IF(ISNUMBER(B7),B7-DCF!B22,"n.s.")', KEUR]]
      .forEach(([l, f, fmt], i) => { const r = Mu.getRow(3 + i); r.getCell(1).value = l; r.getCell(2).value = { formula: f }; r.getCell(2).numFmt = fmt; });

    /* Synthèse */
    const Sy = wb.addWorksheet("Synthese");
    style(Sy);
    Sy.getCell("A1").value = `${o.name} · synthèse (k€)`;
    [["Valeur d'entreprise · DCF", "DCF!B21", KEUR], ["Valeur d'entreprise · multiples", "Multiples!B7", KEUR],
      ["Valeur d'entreprise centrale", 'IF(AND(DCF!B21>0,ISNUMBER(Multiples!B7)),(DCF!B21+Multiples!B7)/2,IF(DCF!B21>0,DCF!B21,Multiples!B7))', KEUR],
      ["Dette nette", "DCF!B22", KEUR], ["Valeur des fonds propres", "B5-B6", KEUR], ["VE centrale / EBITDA", `IF(${h(22)}>0,B5/${h(22)},"n.s.")`, X], ["WACC", "WACC!B8", PCT]]
      .forEach(([l, f, fmt], i) => { const r = Sy.getRow(3 + i); r.getCell(1).value = l; r.getCell(2).value = { formula: f }; r.getCell(2).numFmt = fmt; });
    Sy.getRow(5).font = { bold: true }; Sy.getRow(7).font = { bold: true };
    if (v.lbo) {
      Sy.getCell("A11").value = "Test de LBO (valeurs calculées par Atlas)"; Sy.getCell("A11").font = { bold: true };
      [["Prix d'entrée (k€)", K(v.lbo.entry_ev), KEUR], ["Dette d'acquisition (k€)", K(v.lbo.debt0), KEUR], ["Fonds propres investis (k€)", K(v.lbo.equity0), KEUR],
        ["Fonds propres à la sortie (k€)", K(v.lbo.exit_equity), KEUR], ["Multiple de mise", v.lbo.moic, X], ["TRI", v.lbo.irr, PCT]]
        .forEach(([l, val, fmt], i) => { const r = Sy.getRow(12 + i); r.getCell(1).value = l; r.getCell(2).value = val; r.getCell(2).numFmt = fmt; });
    }

    /* Historique */
    const Hi = wb.addWorksheet("Historique");
    style(Hi);
    Hi.getCell("A1").value = "Comptes publiés (k€)";
    head(Hi, 2, ["Poste"].concat(o.years.map((y) => "Clôture " + y.closing)));
    const lab = { revenue: "Chiffre d'affaires", ebitda: "EBITDA (EBE)", da: "Dotations aux amortissements", ebit: "Résultat d'exploitation", interest: "Intérêts payés",
      income_tax: "Impôt sur les bénéfices", net_income: "Résultat net", equity: "Capitaux propres", fin_debt: "Dettes financières", cash: "Trésorerie et VMP",
      bfr: "BFR d'exploitation", fixed_assets_net: "Immobilisations nettes", total_assets: "Total du bilan", wages: "Salaires et charges sociales" };
    o.meta.detail_fields.forEach((f, i) => {
      const r = Hi.getRow(3 + i);
      r.getCell(1).value = lab[f] || f;
      o.years.forEach((y, j) => { r.getCell(2 + j).value = K(y[f]); r.getCell(2 + j).numFmt = KEUR; });
    });

    /* Sources */
    const So = wb.addWorksheet("Sources");
    So.getColumn(1).width = 120;
    [`Atlas M&A · export du ${new Date().toLocaleDateString("fr-FR")}`,
      `Comptes : liasse fiscale déposée à l'INPI, exercice clos le ${o.closing} (data.gouv.fr, « Données financières détaillées des entreprises »).`,
      "Identité et secteur : base SIRENE (INSEE).",
      `OAT 10 ans : ${m.rates.oat10.source}, ${m.rates.oat10.date}. Euribor 3 mois : ${m.rates.euribor3m.source}, ${m.rates.euribor3m.date}.`,
      `Bêtas : ${m.betas_source.source}. Multiples : ${m.multiples_source.source}. Marges de crédit : ${m.ratings.source}.`,
      "Les cellules jaunes de l'onglet Hypotheses sont modifiables ; tout le modèle se recalcule.",
      "Outil d'aide à l'analyse, pas un conseil en investissement."].forEach((t, i) => (So.getCell(`A${i + 1}`).value = t));
    So.getCell("A1").font = { bold: true, size: 13 };

    wb.views = [{ activeTab: 0 }];
    return wb;
  }

  async function exportModel(o) {
    try {
      const wb = await build(o);
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `atlas-${o.siren}-valorisation.xlsx`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    } catch (e) {
      console.error(e);
      const b = document.getElementById("xlsBtn");
      if (b) b.textContent = "Export impossible ici : " + e.message;
    }
  }
  root.AtlasExcel = { export: exportModel, build };
})(typeof self !== "undefined" ? self : this);
