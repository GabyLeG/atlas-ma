/* Excel export: a live model (formulas, not frozen values) that reproduces the app's DCF, WACC and multiples. */
(function (root) {
  "use strict";
  const LIB = "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js";
  let loading;
  function lib() {
    if (root.ExcelJS) return Promise.resolve(root.ExcelJS);
    loading = loading || new Promise((ok, ko) => {
      const s = document.createElement("script");
      s.src = LIB; s.onload = () => ok(root.ExcelJS); s.onerror = () => ko(new Error("ExcelJS unavailable"));
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
    const H = wb.addWorksheet("Assumptions");
    style(H); H.getColumn(3).width = 70;
    H.getCell("A1").value = `${o.name} (SIREN ${o.siren}) · valuation model`;
    head(H, 2, ["Assumption", "Value", "Source / comment"]);
    const hyp = [
      ["Risk-free rate (French 10y OAT)", w.rf, PCT, `ECB, ${m.rates.oat10.date}`],
      ["Equity risk premium", w.erp, PCT, m.erp.source],
      ["Sector unlevered beta", w.beta_u, "0.00", `${o.sector.industry} · ${m.betas_source.source}`],
      ["Target debt / equity", w.de, PCT, "Sector average structure (Damodaran)"],
      ["Size and illiquidity premium", w.size_premium, PCT, "Assumption by revenue band"],
      ["Euribor 3 months", w.euribor, PCT, `ECB, ${m.rates.euribor3m.date}`],
      ["Credit spread", w.spread, PCT, `Synthetic rating ${w.rating} (Damodaran)`],
      ["Corporate tax rate", p.tax, PCT, "French standard rate"],
      ["Revenue growth, year 1", d.g0, PCT, "Historical annual growth (capped)"],
      ["Terminal growth", p.g_terminal, PCT, "Close to target inflation"],
      ["Projected EBITDA margin", d.margin, PCT, "Average of the last 3 years"],
      ["Depreciation / revenue", d.da_pct, PCT, "Last year"],
      ["Net fixed assets / revenue", d.capital_intensity, "0.00", "Net investment per extra euro of revenue"],
      ["Working capital / revenue", d.bfr_pct, PCT, "Last year"],
      ["Sector EV/EBITDA multiple", v.multiple.multiple, "0.0", m.multiples_source.source],
      ["Private company discount", p.illiquidity, PCT, "Usual assumption for an SME"],
      ["Financial debt (€k)", K(o.c.fin_debt), KEUR, `Reported, accounts to ${o.closing}`],
      ["Cash (€k)", K(o.c.cash), KEUR, `Reported, accounts to ${o.closing}`],
      ["Revenue, last year (€k)", K(o.c.revenue), KEUR, `Reported, accounts to ${o.closing}`],
      ["EBITDA, last year (€k)", K(o.c.ebitda), KEUR, `Reported, accounts to ${o.closing}`],
      ["WACC adjustment", p.wacc_shift || 0, PCT, "0 by default"],
    ];
    hyp.forEach(([l, val, fmt, src], i) => {
      const r = H.getRow(3 + i);
      r.getCell(1).value = l; r.getCell(2).value = val; r.getCell(2).numFmt = fmt; r.getCell(3).value = src;
      r.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4D6" } };
    });
    const h = (n) => `Assumptions!$B$${n}`;  // rows: rf 3, erp 4, bu 5, de 6, size 7, eur 8, spread 9, tax 10, g0 11, gT 12, margin 13, da 14, k 15, bfr 16, mult 17, illiq 18, debt 19, cash 20, rev 21, ebitda 22, shift 23

    /* WACC */
    const Wk = wb.addWorksheet("WACC");
    style(Wk);
    Wk.getCell("A1").value = "Weighted average cost of capital";
    const wr = [
      ["Relevered beta", `${h(5)}*(1+(1-${h(10)})*${h(6)})`, "0.00"],
      ["Cost of equity", `${h(3)}+B3*${h(4)}+${h(7)}`, PCT],
      ["Pre-tax cost of debt", `${h(8)}+${h(9)}`, PCT],
      ["Debt weight", `${h(6)}/(1+${h(6)})`, PCT],
      ["Equity weight", "1-B6", PCT],
      ["WACC", `B7*B4+B6*B5*(1-${h(10)})+${h(23)}`, PCT],
      ["Terminal growth used", `MIN(${h(12)},B8-0.005)`, PCT],
    ];
    wr.forEach(([l, f, fmt], i) => { const r = Wk.getRow(3 + i); r.getCell(1).value = l; r.getCell(2).value = { formula: f }; r.getCell(2).numFmt = fmt; });
    Wk.getRow(8).font = { bold: true };

    /* DCF */
    const D = wb.addWorksheet("DCF");
    style(D);
    D.getCell("A1").value = "Discounted cash flows (€k)";
    head(D, 2, ["", "Actual", "Y+1", "Y+2", "Y+3", "Y+4", "Y+5"]);
    const cols = ["C", "D", "E", "F", "G"];
    const set = (row, label, b, f, fmt) => {
      D.getCell(`A${row}`).value = label;
      if (b !== null) D.getCell(`B${row}`).value = b;
      cols.forEach((c, j) => { const prev = j === 0 ? "B" : cols[j - 1]; D.getCell(`${c}${row}`).value = { formula: f(c, prev) }; D.getCell(`${c}${row}`).numFmt = fmt; });
      D.getCell(`B${row}`).numFmt = fmt;
    };
    D.getCell("A3").value = "Year"; D.getCell("B3").value = 0; cols.forEach((c, j) => (D.getCell(`${c}3`).value = j + 1));
    set(4, "Revenue growth", null, (c) => `${h(11)}+(WACC!$B$9-${h(11)})*(${c}3-1)/4`, PCT);
    set(5, "Revenue", { formula: h(21) }, (c, pv) => `${pv}5*(1+${c}4)`, KEUR);
    set(6, "EBITDA", { formula: h(22) }, (c) => `${h(13)}*${c}5`, KEUR);
    set(7, "Depreciation", null, (c) => `${h(14)}*${c}5`, KEUR);
    set(8, "EBIT", null, (c) => `${c}6-${c}7`, KEUR);
    set(9, "Tax", null, (c) => `MAX(0,${c}8)*${h(10)}`, KEUR);
    set(10, "Operating profit after tax (NOPAT)", null, (c) => `${c}8-${c}9`, KEUR);
    set(11, "Change in revenue", null, (c, pv) => `${c}5-${pv}5`, KEUR);
    set(12, "Capex", null, (c) => `${c}7+${h(15)}*${c}11`, KEUR);
    set(13, "Change in working capital", null, (c) => `${h(16)}*${c}11`, KEUR);
    set(14, "Free cash flow to firm (FCFF)", null, (c) => `${c}10+${c}7-${c}12-${c}13`, KEUR);
    set(15, "Discount factor", null, (c) => `(1+WACC!$B$8)^-${c}3`, "0.000");
    set(16, "Present value", null, (c) => `${c}14*${c}15`, KEUR);
    D.getRow(14).font = { bold: true };
    const tot = [
      [18, "Sum of discounted cash flows", "SUM(C16:G16)"],
      [19, "Terminal value", "IF(G10>0,G10*(1+WACC!B9)*(1-WACC!B9/WACC!B8)/(WACC!B8-WACC!B9),0)"],
      [20, "Discounted terminal value", "B19*G15"],
      [21, "Enterprise value (DCF)", "B18+B20"],
      [22, "Net debt", `${h(19)}-${h(20)}`],
      [23, "Equity value (DCF)", "B21-B22"],
    ];
    tot.forEach(([r, l, f]) => { D.getCell(`A${r}`).value = l; D.getCell(`B${r}`).value = { formula: f }; D.getCell(`B${r}`).numFmt = KEUR; });
    D.getRow(21).font = { bold: true }; D.getRow(23).font = { bold: true };

    /* Multiples */
    const Mu = wb.addWorksheet("Multiples");
    style(Mu);
    Mu.getCell("A1").value = "EBITDA multiple valuation";
    [["EBITDA (€k)", h(22), KEUR], ["Sector EV/EBITDA multiple", h(17), "0.0"], ["Private company discount", h(18), PCT],
      ["Multiple applied", "B4*(1-B5)", "0.0"], ["Enterprise value (€k)", 'IF(B3>0,B3*B6,"n.m.")', KEUR], ["Equity value (€k)", 'IF(ISNUMBER(B7),B7-DCF!B22,"n.m.")', KEUR]]
      .forEach(([l, f, fmt], i) => { const r = Mu.getRow(3 + i); r.getCell(1).value = l; r.getCell(2).value = { formula: f }; r.getCell(2).numFmt = fmt; });

    /* Synthèse */
    const Sy = wb.addWorksheet("Summary");
    style(Sy);
    Sy.getCell("A1").value = `${o.name} · summary (€k)`;
    [["Enterprise value · DCF", "DCF!B21", KEUR], ["Enterprise value · multiple", "Multiples!B7", KEUR],
      ["Central enterprise value", 'IF(AND(DCF!B21>0,ISNUMBER(Multiples!B7)),(DCF!B21+Multiples!B7)/2,IF(DCF!B21>0,DCF!B21,Multiples!B7))', KEUR],
      ["Net debt", "DCF!B22", KEUR], ["Equity value", "B5-B6", KEUR], ["Central EV / EBITDA", `IF(${h(22)}>0,B5/${h(22)},"n.m.")`, X], ["WACC", "WACC!B8", PCT]]
      .forEach(([l, f, fmt], i) => { const r = Sy.getRow(3 + i); r.getCell(1).value = l; r.getCell(2).value = { formula: f }; r.getCell(2).numFmt = fmt; });
    Sy.getRow(5).font = { bold: true }; Sy.getRow(7).font = { bold: true };
    if (v.lbo) {
      Sy.getCell("A11").value = "LBO test (values computed by Atlas)"; Sy.getCell("A11").font = { bold: true };
      [["Entry price (€k)", K(v.lbo.entry_ev), KEUR], ["Acquisition debt (€k)", K(v.lbo.debt0), KEUR], ["Equity invested (€k)", K(v.lbo.equity0), KEUR],
        ["Equity at exit (€k)", K(v.lbo.exit_equity), KEUR], ["Money multiple", v.lbo.moic, X], ["IRR", v.lbo.irr, PCT]]
        .forEach(([l, val, fmt], i) => { const r = Sy.getRow(12 + i); r.getCell(1).value = l; r.getCell(2).value = val; r.getCell(2).numFmt = fmt; });
    }

    /* Historique */
    const Hi = wb.addWorksheet("Reported");
    style(Hi);
    Hi.getCell("A1").value = "Reported accounts as filed with INPI (€k)";
    head(Hi, 2, ["Line"].concat(o.years.map((y) => "Year to " + y.closing)));
    const lab = { revenue: "Revenue", ebitda: "EBITDA (EBE)", da: "Depreciation", ebit: "Operating profit (EBIT)", interest: "Interest paid",
      income_tax: "Income tax", net_income: "Net income", equity: "Shareholders' equity", fin_debt: "Financial debt", cash: "Cash and securities",
      bfr: "Operating working capital", fixed_assets_net: "Net fixed assets", total_assets: "Balance sheet total", wages: "Wages and social charges" };
    o.meta.detail_fields.forEach((f, i) => {
      const r = Hi.getRow(3 + i);
      r.getCell(1).value = lab[f] || f;
      o.years.forEach((y, j) => { r.getCell(2 + j).value = K(y[f]); r.getCell(2 + j).numFmt = KEUR; });
    });

    /* Sources */
    const So = wb.addWorksheet("Sources");
    So.getColumn(1).width = 120;
    [`Atlas M&A · export of ${new Date().toISOString().slice(0, 10)}`,
      `Accounts: tax return filed with INPI, year to ${o.closing}${o.proof && o.proof.filed ? ", filed " + o.proof.filed : ""}. Official filing: https://data.inpi.fr/entreprises/${o.siren}`,
      "Identity and sector: INSEE SIRENE register.",
      `French 10y OAT: ${m.rates.oat10.source}, ${m.rates.oat10.date}. Euribor 3 months: ${m.rates.euribor3m.source}, ${m.rates.euribor3m.date}.`,
      `Betas: ${m.betas_source.source}. Multiples: ${m.multiples_source.source}. Credit spreads: ${m.ratings.source}.`,
      "Yellow cells in the Assumptions sheet can be changed; the whole model recalculates.",
      "Decision-support tool, not investment advice."].forEach((t, i) => (So.getCell(`A${i + 1}`).value = t));
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
      a.download = `atlas-${o.siren}-valuation.xlsx`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    } catch (e) {
      console.error(e);
      const b = document.getElementById("xlsBtn");
      if (b) b.textContent = "Export failed: " + e.message;
    }
  }
  root.AtlasExcel = { export: exportModel, build };
})(typeof self !== "undefined" ? self : this);
