/* Port of pipeline/valuation.py. Keep the two in step: tests/test_parity.py compares them. */
(function (root) {
  "use strict";
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== null && o[k] !== undefined;
  const pick = (p, k, d) => (has(p, k) ? p[k] : d);

  function sizePremium(revenue, bands) {
    for (const [limit, prem] of bands) if (limit === null || revenue < limit) return prem;
    return bands[bands.length - 1][1];
  }

  function syntheticRating(ebit, interest, ratings) {
    const cov = interest <= 0 ? Infinity : ebit / interest;
    for (const [lo, hi, r] of ratings.small_firm_thresholds) {
      if ((lo < cov && cov <= hi) || (cov === Infinity && hi >= 1e8)) return [r, ratings.spreads[r], cov];
    }
    return ["D", ratings.spreads.D, cov];
  }

  function growth0(revenues, cfg) {
    const r = revenues.filter((x) => x && x > 0);
    if (r.length < 2) return cfg.default_growth;
    const n = r.length - 1;
    return clamp(Math.pow(r[r.length - 1] / r[0], 1 / n) - 1, cfg.growth_floor, cfg.growth_cap);
  }

  function avgMargin(revenues, ebitdas) {
    const pairs = [];
    revenues.forEach((r, i) => { if (r && r > 0) pairs.push([r, ebitdas[i]]); });
    const last = pairs.slice(-3);
    if (!last.length) return 0;
    return clamp(last.reduce((a, [r, e]) => a + e / r, 0) / last.length, -0.5, 0.8);
  }

  function wacc(c, m, s, p, cfg) {
    const t = p.tax;
    const de = pick(p, "de", s.de);
    const betaU = pick(p, "beta_u", s.beta_u);
    const betaL = betaU * (1 + (1 - t) * de);
    const sp = pick(p, "size_premium", sizePremium(c.revenue, cfg.size_premium_bands));
    const rf = pick(p, "rf", m.rf), erp = pick(p, "erp", m.erp), euribor = pick(p, "euribor", m.euribor);
    const ke = rf + betaL * erp + sp;
    let [rating, spread, cov] = syntheticRating(c.ebit, c.interest, m.ratings);
    spread = pick(p, "spread", spread);
    const kd = euribor + spread;
    const wd = de / (1 + de), we = 1 - wd;
    return { rf, erp, euribor, beta_u: betaU, de, beta_l: betaL, size_premium: sp, ke, rating,
      coverage: cov === Infinity ? null : cov, spread, kd, we, wd, wacc: we * ke + wd * kd * (1 - t) + pick(p, "wacc_shift", 0) };
  }

  function dcf(c, hist, w, p, cfg) {
    const t = p.tax, N = Math.trunc(p.years), W = w.wacc;
    const gT = Math.min(p.g_terminal, W - 0.005);
    const R0 = c.revenue;
    const g0 = pick(p, "g0", growth0(hist.revenue, cfg));
    const m = pick(p, "margin", avgMargin(hist.revenue, hist.ebitda));
    const d = clamp(c.da / R0, 0, 0.3), k = clamp(c.fixed_assets_net / R0, 0, 3), b = clamp(c.bfr / R0, -0.3, 0.6);
    const rows = [];
    let prev = R0, pv = 0;
    for (let i = 1; i <= N; i++) {
      const g = N > 1 ? g0 + (gT - g0) * (i - 1) / (N - 1) : gT;
      const R = prev * (1 + g), E = m * R, DA = d * R, EBIT = E - DA;
      const tax = Math.max(0, EBIT) * t, nopat = EBIT - tax, dR = R - prev;
      const capex = DA + k * dR, dbfr = b * dR, fcff = nopat + DA - capex - dbfr, df = Math.pow(1 + W, -i);
      pv += fcff * df;
      rows.push({ year: i, growth: g, revenue: R, ebitda: E, da: DA, ebit: EBIT, tax, nopat, capex, dbfr, fcff, df, pv: fcff * df });
      prev = R;
    }
    const last = rows[rows.length - 1];
    let tv = 0;
    if (last.nopat > 0) tv = (last.nopat * (1 + gT) * (1 - gT / W)) / (W - gT);
    const pvTv = tv * last.df, ev = pv + pvTv;
    return { g0, margin: m, da_pct: d, capital_intensity: k, bfr_pct: b, g_terminal: gT, rows, pv_fcff: pv, tv, pv_tv: pvTv, ev,
      tv_share: ev > 0 ? pvTv / ev : null };
  }

  function multipleValue(c, s, p) {
    const mult = pick(p, "ev_ebitda", s.ev_ebitda);
    if (mult === null || mult === undefined || c.ebitda <= 0) return { multiple: mult ?? null, applied: null, ev: null };
    const applied = mult * (1 - p.illiquidity);
    return { multiple: mult, applied, ev: c.ebitda * applied };
  }

  function lbo(c, rows, entryEv, w, p) {
    const E0 = c.ebitda;
    if (entryEv === null || entryEv <= 0 || E0 <= 0) return null;
    const uses = entryEv * (1 + p.lbo_fees);
    let debt = Math.min(p.lbo_leverage * E0, 0.7 * uses);
    const debt0 = debt, equity0 = uses - debt, rate = w.euribor + p.lbo_margin;
    let cash = 0;
    const path = [], n = Math.min(Math.trunc(p.lbo_years), rows.length);
    for (const r of rows.slice(0, n)) {
      const interest = debt * rate, avail = r.fcff - interest * (1 - p.tax);
      if (avail >= 0) { const repay = Math.min(debt, avail); debt -= repay; cash += avail - repay; } else debt -= avail;
      path.push({ year: r.year, interest, debt, cash });
    }
    const exitEv = rows[n - 1].ebitda * (entryEv / E0), exitEq = exitEv - debt + cash;
    const irr = exitEq > 0 ? Math.pow(exitEq / equity0, 1 / n) - 1 : -1;
    return { entry_ev: entryEv, debt0, equity0, rate, path, exit_ev: exitEv, exit_equity: exitEq, moic: exitEq / equity0, irr };
  }

  function value(c, hist, m, s, params, cfg) {
    const p = Object.assign({}, cfg.defaults, params || {});
    const w = wacc(c, m, s, p, cfg), d = dcf(c, hist, w, p, cfg), mv = multipleValue(c, s, p);
    const netDebt = c.fin_debt - c.cash;
    const evs = [d.ev > 0 ? d.ev : null, mv.ev].filter((x) => x !== null);
    const ev = evs.length ? evs.reduce((a, b) => a + b, 0) / evs.length : null;
    return { params: p, wacc: w, dcf: d, multiple: mv, net_debt: netDebt, ev_dcf: d.ev, ev_mult: mv.ev, ev,
      equity_dcf: d.ev - netDebt, equity_mult: mv.ev === null ? null : mv.ev - netDebt, equity: ev === null ? null : ev - netDebt,
      ev_ebitda_dcf: c.ebitda > 0 ? d.ev / c.ebitda : null, gap: mv.ev && mv.ev > 0 ? d.ev / mv.ev - 1 : null,
      lbo: lbo(c, d.rows, mv.ev, w, p) };
  }

  const api = { value, wacc, dcf, growth0, avgMargin, sizePremium, syntheticRating };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Valuation = api;
})(typeof self !== "undefined" ? self : this);
