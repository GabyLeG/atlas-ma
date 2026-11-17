/* Atlas M&A — map, sortable list and company valuation. Data: data/meta.json, data/universe.json, data/co/<prefix>.json */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf = (d) => new Intl.NumberFormat("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d });
  const NF0 = nf(0), NF1 = nf(1), NF2 = nf(2);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /* ---------- formatting (universe amounts are €k, analysis amounts are €) ---------- */
  function money(k) {
    if (k === null || k === undefined || Number.isNaN(k)) return "–";
    const a = Math.abs(k), s = k < 0 ? "−" : "";
    if (a >= 1e6) return s + "€" + NF1.format(a / 1e6) + "bn";
    if (a >= 1e4) return s + "€" + NF0.format(a / 1e3) + "m";
    if (a >= 1e3) return s + "€" + NF1.format(a / 1e3) + "m";
    return s + "€" + NF0.format(a) + "k";
  }
  const eur = (e) => (e === null || e === undefined ? "–" : money(e / 1000));
  const pct = (x, d = 1, sign = false) => (x === null || x === undefined || Number.isNaN(x) ? "–" : (sign && x > 0 ? "+" : x < 0 ? "−" : "") + nf(d).format(Math.abs(x) * 100) + "%");
  const mult = (x) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : NF1.format(x) + "x");
  const date = (s) => (s ? `${+s.slice(8, 10)} ${MONTHS[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}` : "–");
  const addMonths = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
  const cls = (x) => (x === null || x === undefined ? "mut" : x >= 0 ? "pos" : "neg");
  const k0 = (e) => NF0.format(e / 1000);

  const REGIONS = {
    "Auvergne-Rhône-Alpes": "01 03 07 15 26 38 42 43 63 69 73 74", "Bourgogne-Franche-Comté": "21 25 39 58 70 71 89 90",
    "Brittany": "22 29 35 56", "Centre-Val de Loire": "18 28 36 37 41 45", "Corsica": "2A 2B",
    "Grand Est": "08 10 51 52 54 55 57 67 68 88", "Hauts-de-France": "02 59 60 62 80", "Île-de-France": "75 77 78 91 92 93 94 95",
    "Normandy": "14 27 50 61 76", "Nouvelle-Aquitaine": "16 17 19 23 24 33 40 47 64 79 86 87",
    "Occitanie": "09 11 12 30 31 32 34 46 48 65 66 81 82", "Pays de la Loire": "44 49 53 72 85",
    "Provence-Alpes-Côte d'Azur": "04 05 06 13 83 84", "Overseas": "971 972 973 974 976",
  };
  const DEP2REG = {};
  for (const [r, ds] of Object.entries(REGIONS)) ds.split(" ").forEach((d) => (DEP2REG[d] = r));

  let META, U, N, GEO, DEPNAME = {};
  let F = new Int32Array(0);
  const S = { q: "", macros: new Set(), div: "", reg: "", dep: "", rmin: null, rmax: null, margin: -20, growth: -5, mult: 25, score: 0,
    pos: false, color: "sc", fill: "none", sort: { key: "sc", dir: -1 }, selected: -1 };

  /* ---------- boot ---------- */
  Promise.all(["data/meta.json", "data/universe.json", "data/departements.json"].map((u) => fetch(u, { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error(u + " " + r.status);
    return r.json();
  }))).then(([m, u, g]) => {
    META = m; U = u; GEO = g; N = U.s.length;
    g.features.forEach((f) => (DEPNAME[f.properties.code] = f.properties.nom));
    U.mac = U.d.map((d) => (META.sectors[d] ? META.sectors[d].macro : ""));
    U.lc = U.n.map((n) => (n || "").toLowerCase());
    U.reg = U.dep.map((d) => DEP2REG[d] || "");
    initChrome(); initFilters(); initMap(); initList();
    applyFilters();
    window.addEventListener("hashchange", route);
    route();
  }).catch((e) => {
    document.querySelector(".shell").innerHTML = `<div class="empty"><h2>Data unavailable</h2><p>${esc(e.message)}. Run <code>python -m pipeline.build --sample</code>, then reload.</p></div>`;
  });

  /* ---------- header: data freshness ---------- */
  function initChrome() {
    const r = META.market.rates;
    const chip = (label, v, live) => `<span class="chip"><i class="dot ${live === false ? "off" : ""}"></i>${label} <b>${v}</b></span>`;
    $("fresh").innerHTML =
      chip("Accounts closed after", date(META.cutoff), META.verification !== "open_data") +
      chip("French 10y OAT", pct(r.oat10.value, 2) + " · " + r.oat10.date, r.oat10.live) +
      chip("Euribor 3M", pct(r.euribor3m.value, 2) + " · " + r.euribor3m.date, r.euribor3m.live) +
      chip("Updated", date(META.built_at.slice(0, 10)));
    $("sampleBanner").hidden = !META.sample;
    if (META.verification === "open_data" && !META.sample) {
      $("sampleBanner").hidden = false;
      $("sampleBanner").textContent = "Latest accounts come from the open-data file only (INPI API not connected): coverage of this year's filings is partial.";
    }
    $("methodBtn").onclick = () => { $("methodBody").innerHTML = methodHtml(); $("method").showModal(); };
  }

  /* ---------- filters ---------- */
  function initFilters() {
    const mac = $("fMacro");
    const counts = {};
    U.mac.forEach((m) => (counts[m] = (counts[m] || 0) + 1));
    Object.entries(META.macros).filter(([k]) => counts[k]).sort((a, b) => counts[b[0]] - counts[a[0]]).forEach(([k, v]) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = v.en; b.dataset.k = k;
      b.onclick = () => { S.macros.has(k) ? S.macros.delete(k) : S.macros.add(k); b.classList.toggle("on"); fillDivs(); S.div = ""; applyFilters(); };
      mac.appendChild(b);
    });
    fillDivs();
    const reg = $("fReg");
    Object.keys(REGIONS).forEach((r) => reg.add(new Option(r, r)));
    reg.onchange = () => { S.reg = reg.value; S.dep = ""; fillDeps(); applyFilters(); };
    fillDeps();
    $("fDep").onchange = (e) => { S.dep = e.target.value; applyFilters(); };
    $("fDiv").onchange = (e) => { S.div = e.target.value; applyFilters(); };
    let t;
    $("fSearch").oninput = (e) => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value.trim(); applyFilters(); }, 120); };
    const num = (id, key) => ($(id).oninput = (e) => { S[key] = e.target.value === "" ? null : +e.target.value; applyFilters(); });
    num("fRmin", "rmin"); num("fRmax", "rmax");
    [["€2–10m", 2, 10], ["€10–50m", 10, 50], ["€50–250m", 50, 250], ["€250m+", 250, null]].forEach(([l, a, b]) => {
      const bt = document.createElement("button"); bt.type = "button"; bt.textContent = l;
      bt.onclick = () => { S.rmin = a; S.rmax = b; $("fRmin").value = a; $("fRmax").value = b ?? ""; applyFilters(); };
      $("fRpre").appendChild(bt);
    });
    const slider = (id, out, key, fmt) => {
      const el = $(id), o = $(out);
      const upd = () => { S[key] = +el.value; o.textContent = fmt(+el.value); };
      el.oninput = () => { upd(); applyFilters(); }; upd();
    };
    slider("fMargin", "oMargin", "margin", (v) => (v <= -20 ? "any" : v + "%"));
    slider("fGrowth", "oGrowth", "growth", (v) => (v <= -5 ? "any" : v + "%"));
    slider("fMult", "oMult", "mult", (v) => (v >= 25 ? "any" : NF1.format(v) + "x"));
    slider("fScore", "oScore", "score", (v) => (v <= 0 ? "any" : v));
    $("fPos").onchange = (e) => { S.pos = e.target.checked; applyFilters(); };
    $("resetBtn").onclick = reset;
  }
  function fillDivs() {
    const sel = $("fDiv");
    sel.length = 1;
    Object.entries(META.sectors).filter(([, v]) => !S.macros.size || S.macros.has(v.macro))
      .sort((a, b) => b[1].count - a[1].count)
      .forEach(([d, v]) => sel.add(new Option(`${v.en} (${v.count})`, d)));
  }
  function fillDeps() {
    const sel = $("fDep");
    sel.length = 1;
    const deps = S.reg ? REGIONS[S.reg].split(" ") : Object.keys(DEPNAME).sort();
    deps.forEach((d) => sel.add(new Option(`${d} ${DEPNAME[d] || ""}`, d)));
  }
  function reset() {
    Object.assign(S, { q: "", div: "", reg: "", dep: "", rmin: null, rmax: null, margin: -20, growth: -5, mult: 25, score: 0, pos: false });
    S.macros.clear();
    document.querySelectorAll("#fMacro button").forEach((b) => b.classList.remove("on"));
    ["fSearch", "fRmin", "fRmax"].forEach((id) => ($(id).value = ""));
    $("fMargin").value = -20; $("fGrowth").value = -5; $("fMult").value = 25; $("fScore").value = 0; $("fPos").checked = false; $("fReg").value = "";
    ["fMargin", "fGrowth", "fMult", "fScore"].forEach((id) => $(id).dispatchEvent(new Event("input")));
    fillDivs(); fillDeps();
    applyFilters();
  }

  function applyFilters() {
    const q = S.q.toLowerCase(), qd = S.q.replace(/\s/g, "");
    const isNum = /^\d{3,9}$/.test(qd);
    const out = [];
    const mMin = S.margin <= -20 ? -Infinity : S.margin / 100, gMin = S.growth <= -5 ? -Infinity : S.growth / 100;
    const xMax = S.mult >= 25 ? Infinity : S.mult, rMin = S.rmin === null ? -Infinity : S.rmin * 1000, rMax = S.rmax === null ? Infinity : S.rmax * 1000;
    for (let i = 0; i < N; i++) {
      if (q && !(isNum ? U.s[i].startsWith(qd) : U.lc[i].includes(q))) continue;
      if (S.macros.size && !S.macros.has(U.mac[i])) continue;
      if (S.div && U.d[i] !== S.div) continue;
      if (S.reg && U.reg[i] !== S.reg) continue;
      if (S.dep && U.dep[i] !== S.dep) continue;
      if (U.r[i] < rMin || U.r[i] > rMax) continue;
      if (U.m[i] < mMin || U.g[i] < gMin) continue;
      if (xMax < Infinity && !(U.x[i] !== null && U.x[i] <= xMax)) continue;
      if (S.score && !(U.sc[i] >= S.score)) continue;
      if (S.pos && !(U.e[i] > 0)) continue;
      out.push(i);
    }
    F = Int32Array.from(out);
    $("count").textContent = NF0.format(F.length);
    $("countSub").textContent = F.length === N ? "in the universe" : `of ${NF0.format(N)}`;
    buildTree(); drawMap(); renderList();
  }

  /* ---------- map ---------- */
  let canvas, ctx, proj, path, transform = d3.zoomIdentity, PX, PY, tree, zoom, W = 0, H = 0, metro;
  // perceptual ramp (plasma) from deep violet (weak) to gold (strong): readable on light and dark backgrounds
  const ramp = (t) => d3.interpolatePlasma(0.08 + 0.84 * t);
  function initMap() {
    canvas = $("map"); ctx = canvas.getContext("2d");
    metro = { type: "FeatureCollection", features: GEO.features.filter((f) => f.properties.code.length === 2) };
    proj = d3.geoConicConformal().parallels([44, 49]).rotate([-3, 0]);
    path = d3.geoPath(proj, ctx);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawMap);
    zoom = d3.zoom().scaleExtent([1, 60]).on("zoom", (e) => { transform = e.transform; drawMap(); })
      .on("start", () => canvas.classList.add("drag")).on("end", () => canvas.classList.remove("drag"));
    d3.select(canvas).call(zoom).on("dblclick.zoom", null);
    $("zin").onclick = () => d3.select(canvas).transition().duration(250).call(zoom.scaleBy, 1.8);
    $("zout").onclick = () => d3.select(canvas).transition().duration(250).call(zoom.scaleBy, 1 / 1.8);
    $("zreset").onclick = () => d3.select(canvas).transition().duration(300).call(zoom.transform, d3.zoomIdentity);
    canvas.addEventListener("mousemove", hover);
    canvas.addEventListener("mouseleave", () => ($("tip").hidden = true));
    canvas.addEventListener("click", (e) => select(nearest(e)));
    document.querySelectorAll("[data-color]").forEach((b) => (b.onclick = () => {
      document.querySelectorAll("[data-color]").forEach((x) => x.classList.toggle("on", x === b)); S.color = b.dataset.color; drawMap();
    }));
    document.querySelectorAll("[data-fill]").forEach((b) => (b.onclick = () => {
      document.querySelectorAll("[data-fill]").forEach((x) => x.classList.toggle("on", x === b)); S.fill = b.dataset.fill; drawMap();
    }));
    new ResizeObserver(resize).observe($("mapwrap"));
  }
  function resize() {
    const r = $("mapwrap").getBoundingClientRect();
    if (!r.width || !r.height) return;
    W = r.width; H = r.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    proj.fitExtent([[20, 20], [W - 20, H - 20]], metro);
    PX = new Float32Array(N); PY = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (U.la[i] === null || U.lo[i] === null) { PX[i] = NaN; PY[i] = NaN; continue; }
      const p = proj([U.lo[i], U.la[i]]);
      PX[i] = p ? p[0] : NaN; PY[i] = p ? p[1] : NaN;
    }
    buildTree(); drawMap();
  }
  function buildTree() {
    if (!PX) return;
    const pts = [];
    for (const i of F) if (!Number.isNaN(PX[i])) pts.push(i);
    tree = d3.quadtree().x((i) => PX[i]).y((i) => PY[i]).addAll(pts);
  }
  function metricScale() {
    const key = S.color, vals = [];
    for (const i of F) { const v = U[key][i]; if (v !== null && v !== undefined) vals.push(v); }
    vals.sort((a, b) => a - b);
    let lo, hi;
    if (key === "sc") { lo = 0; hi = 100; } else { lo = d3.quantileSorted(vals, 0.05) ?? 0; hi = d3.quantileSorted(vals, 0.95) ?? 1; }
    const rev = key === "x";        // a lower EV/EBITDA is the more interesting target
    const t = (v) => { if (v === null || v === undefined) return null; let u = (v - lo) / (hi - lo || 1); u = Math.max(0, Math.min(1, u)); return rev ? 1 - u : u; };
    return { t, lo, hi, rev };
  }
  function drawMap() {
    if (!ctx || !W || !PX) return;
    const cs = getComputedStyle(document.documentElement);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(transform.x, transform.y); ctx.scale(transform.k, transform.k);
    let counts = null, cmax = 1;
    if (S.fill === "count") {
      counts = {};
      for (const i of F) counts[U.dep[i]] = (counts[U.dep[i]] || 0) + 1;
      cmax = Math.max(1, ...Object.values(counts));
    }
    const land = cs.getPropertyValue("--map-land").trim(), edge = cs.getPropertyValue("--map-edge").trim(), acc = cs.getPropertyValue("--accent").trim();
    for (const f of metro.features) {
      ctx.beginPath(); path(f);
      ctx.fillStyle = land; ctx.fill();
      if (counts) {
        const c = counts[f.properties.code] || 0;
        if (c) { ctx.globalAlpha = 0.12 + 0.78 * Math.sqrt(c / cmax); ctx.fillStyle = acc; ctx.fill(); ctx.globalAlpha = 1; }
      }
      if (S.dep === f.properties.code || (S.reg && DEP2REG[f.properties.code] === S.reg)) { ctx.lineWidth = 2 / transform.k; ctx.strokeStyle = acc; }
      else { ctx.lineWidth = 0.7 / transform.k; ctx.strokeStyle = edge; }
      ctx.stroke();
    }
    ctx.restore();
    const sc = metricScale();
    const order = Array.from(F).filter((i) => !Number.isNaN(PX[i]));
    order.sort((a, b) => (sc.t(U[S.color][a]) ?? -1) - (sc.t(U[S.color][b]) ?? -1));
    const grow = Math.min(2.2, Math.sqrt(transform.k));
    const alpha = counts ? 0.55 : 0.82;
    const none = cs.getPropertyValue("--muted").trim();
    for (const i of order) {
      const x = transform.applyX(PX[i]), y = transform.applyY(PY[i]);
      if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
      const r = Math.max(1.5, Math.min(7, 1.2 + Math.sqrt(Math.max(U.r[i], 0) / 1000) * 0.33)) * grow;
      const t = sc.t(U[S.color][i]);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = t === null ? none : ramp(t);
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (S.selected >= 0 && !Number.isNaN(PX[S.selected])) {
      const x = transform.applyX(PX[S.selected]), y = transform.applyY(PY[S.selected]);
      ctx.lineWidth = 2.5; ctx.strokeStyle = cs.getPropertyValue("--ink").trim();
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 6.2832); ctx.stroke();
    }
    legend(sc, counts, cmax);
  }
  const LEG = { sc: ["Attractiveness score", (v) => NF0.format(v)], m: ["EBITDA margin", (v) => pct(v, 0)], g: ["Annual revenue growth", (v) => pct(v, 0)], x: ["EV / EBITDA (low = cheaper)", (v) => mult(v)] };
  function legend(sc, counts, cmax) {
    const [title, f] = LEG[S.color];
    const stops = d3.range(0, 1.01, 0.1).map((t) => ramp(t)).join(",");
    const a = f(sc.rev ? sc.hi : sc.lo), b = f(sc.rev ? sc.lo : sc.hi);
    $("legend").innerHTML = `<div>${title}</div><div class="ramp" style="background:linear-gradient(90deg,${stops})"></div><div class="ends"><span>${a}</span><span>${b}</span></div>` +
      (counts ? `<div style="margin-top:6px">Density: up to <b class="num">${NF0.format(cmax)}</b> companies per département</div>` : "") +
      `<div style="margin-top:4px">Dot size: revenue</div>`;
  }
  function nearest(e) {
    if (!tree) return -1;
    const r = canvas.getBoundingClientRect();
    const [x, y] = transform.invert([e.clientX - r.left, e.clientY - r.top]);
    const i = tree.find(x, y, 10 / transform.k);
    return i === undefined ? -1 : i;
  }
  function hover(e) {
    const i = nearest(e), tip = $("tip");
    if (i < 0) { tip.hidden = true; canvas.style.cursor = ""; return; }
    canvas.style.cursor = "pointer";
    const r = canvas.getBoundingClientRect();
    tip.innerHTML = `<b>${esc(U.n[i])}</b>${esc(sectorName(U.d[i]))} · ${esc(U.c[i] || "")}<br><span class="num">Revenue ${money(U.r[i])} · margin ${pct(U.m[i], 0)} · score ${U.sc[i] ?? "–"}</span>`;
    tip.hidden = false;
    const x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
    tip.style.left = Math.min(x, W - 270) + "px"; tip.style.top = Math.min(y, H - 80) + "px";
  }
  function select(i) {
    S.selected = i;
    const card = $("pick");
    if (i < 0) { card.hidden = true; drawMap(); return; }
    card.innerHTML = `<button class="x" aria-label="Close">×</button><h3>${esc(U.n[i])}</h3>
      <div class="meta">${esc(sectorName(U.d[i]))} · ${esc(U.c[i] || "")} (${esc(U.dep[i] || "")}) · accounts to ${date(U.cl[i])}${U.fd && U.fd[i] ? ", filed " + date(U.fd[i]) : ""}</div>
      <div class="row">${mini("Revenue", money(U.r[i]))}${mini("EBITDA", money(U.e[i]))}${mini("Margin", pct(U.m[i]))}
      ${mini("Growth", pct(U.g[i], 1, true))}${mini("Estimated EV", money(U.ev[i]))}${mini("EV / EBITDA", mult(U.x[i]))}</div>
      <div class="actions"><a class="primary" href="#analyse-${U.s[i]}" style="text-decoration:none">Analyse this company</a>${scorePill(U.sc[i])}</div>`;
    card.querySelector(".x").onclick = () => select(-1);
    card.hidden = false;
    drawMap();
  }
  const mini = (l, v) => `<div class="mini"><span>${l}</span><b>${v}</b></div>`;
  function scorePill(s) {
    if (s === null || s === undefined) return "";
    const t = s / 100;
    return `<span class="pill" style="background:${ramp(t)};color:${t > 0.55 ? "#0d1b2a" : "#ffffff"}" title="Attractiveness score out of 100">${s}</span>`;
  }
  const sectorName = (d) => (META.sectors[d] ? META.sectors[d].en : d);

  /* ---------- list ---------- */
  const COLS = [
    { k: "n", l: "Company", w: "270px", name: true },
    { k: "r", l: "Revenue", w: "92px", f: money }, { k: "e", l: "EBITDA", w: "92px", f: money },
    { k: "m", l: "Margin", w: "76px", f: (v) => pct(v) }, { k: "g", l: "Growth", w: "84px", f: (v) => pct(v, 1, true), c: true },
    { k: "nd", l: "Net debt", w: "92px", f: money }, { k: "evd", l: "EV · DCF", w: "92px", f: money },
    { k: "evm", l: "EV · multiple", w: "104px", f: money }, { k: "ev", l: "EV · central", w: "100px", f: money },
    { k: "x", l: "EV / EBITDA", w: "92px", f: mult }, { k: "gap", l: "DCF vs mult.", w: "96px", f: (v) => (v === null ? "–" : Math.abs(v) > 3 ? "n.m." : pct(v, 0, true)), c: true },
    { k: "irr", l: "LBO IRR", w: "80px", f: (v) => (v === null ? "–" : v <= -1 ? "loss" : pct(v, 0)), c: true },
    { k: "sc", l: "Score", w: "70px", pill: true }, { k: "cl", l: "Accounts to", w: "104px", f: date }, { k: "fd", l: "Filed", w: "104px", f: date },
  ];
  let ORDER = [];
  const ROW = 40;
  function initList() {
    const th = $("thead");
    document.documentElement.style.setProperty("--cols", COLS.map((c) => c.w).join(" "));
    th.innerHTML = COLS.map((c) => `<div class="th ${c.name ? "" : "r"}" role="columnheader" data-k="${c.k}">${c.l}</div>`).join("");
    th.querySelectorAll(".th").forEach((el) => (el.onclick = () => {
      const k = el.dataset.k;
      S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: k === "n" || k === "x" ? 1 : -1 };
      renderList();
    }));
    $("table").addEventListener("scroll", paintRows);
    $("tbody").addEventListener("click", (e) => { const r = e.target.closest(".tr"); if (r) location.hash = "#analyse-" + r.dataset.s; });
    $("csvBtn").onclick = csv;
  }
  function renderList() {
    const { key, dir } = S.sort;
    const col = U[key] || [];
    ORDER = Array.from(F);
    if (key === "n") ORDER.sort((a, b) => dir * U.lc[a].localeCompare(U.lc[b]));
    else if (key === "cl" || key === "fd") ORDER.sort((a, b) => dir * String(col[a] || "").localeCompare(String(col[b] || "")));
    else ORDER.sort((a, b) => {
      const x = col[a], y = col[b];
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return dir * (x - y);
    });
    document.querySelectorAll(".th").forEach((el) => {
      const on = el.dataset.k === key;
      el.classList.toggle("on", on);
      if (on) el.dataset.dir = dir > 0 ? "↑" : "↓"; else delete el.dataset.dir;
    });
    $("tbody").style.height = ORDER.length * ROW + "px";
    $("sortNote").textContent = `Sorted by ${COLS.find((c) => c.k === key).l}, ${dir > 0 ? "ascending" : "descending"} · click a header to sort`;
    summary();
    paintRows();
  }
  function paintRows() {
    const box = $("table"), body = $("tbody");
    if ($("v-list").hidden) return;
    const head = $("thead").offsetHeight;
    const start = Math.max(0, Math.floor((box.scrollTop - head) / ROW) - 8);
    const end = Math.min(ORDER.length, start + Math.ceil(box.clientHeight / ROW) + 16);
    let h = "";
    for (let j = start; j < end; j++) {
      const i = ORDER[j];
      h += `<div class="tr" role="row" data-s="${U.s[i]}" style="top:${j * ROW}px">` + COLS.map((c) => {
        if (c.name) return `<div class="td name"><b>${esc(U.n[i])}</b><span class="sub">${esc(sectorName(U.d[i]))} · ${esc(U.dep[i] || "")} ${esc(U.c[i] || "")}</span></div>`;
        if (c.pill) return `<div class="td r">${scorePill(U.sc[i])}</div>`;
        const v = (U[c.k] || [])[i];
        return `<div class="td num r ${c.c ? cls(v) : ""}">${c.f(v)}</div>`;
      }).join("") + "</div>";
    }
    body.innerHTML = h || `<div class="empty">No company matches these filters.</div>`;
  }
  function summary() {
    let rev = 0; const ms = [], xs = [];
    for (const i of F) { rev += U.r[i] || 0; ms.push(U.m[i]); if (U.x[i] !== null) xs.push(U.x[i]); }
    const med = (a) => (a.length ? d3.median(a) : null);
    $("summary").innerHTML = [["Companies", NF0.format(F.length)], ["Combined revenue", money(rev)],
      ["Median EBITDA margin", pct(med(ms))], ["Median EV / EBITDA", mult(med(xs))]]
      .map(([l, v]) => `<div class="tile"><span>${l}</span><b>${v}</b></div>`).join("");
  }
  function csv() {
    const head = ["siren", "company", "sector", "departement", "town", "revenue_keur", "ebitda_keur", "ebitda_margin", "growth", "net_debt_keur",
      "ev_dcf_keur", "ev_multiple_keur", "ev_central_keur", "ev_ebitda", "lbo_irr", "score", "accounts_to", "filed"];
    const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const lines = [head.join(",")].concat(ORDER.map((i) => [U.s[i], q(U.n[i]), q(sectorName(U.d[i])), U.dep[i], q(U.c[i]), U.r[i], U.e[i], U.m[i], U.g[i], U.nd[i],
      U.evd[i], U.evm[i], U.ev[i], U.x[i], U.irr[i], U.sc[i], U.cl[i], U.fd ? U.fd[i] : ""].map((v) => (v === null || v === undefined ? "" : v)).join(",")));
    download(new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" }), "atlas-companies.csv");
  }
  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------- routing ---------- */
  function route() {
    const h = location.hash.slice(1);
    let view = "map";
    if (h === "liste") view = "list";
    else if (h.startsWith("analyse")) view = "co";
    $("v-map").hidden = view !== "map"; $("v-list").hidden = view !== "list"; $("v-co").hidden = view !== "co";
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.view === view));
    document.body.classList.toggle("wide", view === "co");
    if (view === "map") requestAnimationFrame(resize);
    if (view === "list") requestAnimationFrame(paintRows);
    if (view === "co") openCompany(h.slice(8));
  }

  /* ---------- company analysis ---------- */
  const SHARDS = {};
  let CO = null;
  function openCompany(siren) {
    const box = $("co");
    if (!siren) {
      const best = Array.from(F).sort((a, b) => (U.sc[b] ?? 0) - (U.sc[a] ?? 0)).slice(0, 12);
      box.innerHTML = `<div class="panel"><h2>Pick a company</h2><p class="hint">Click a dot on the map or a row in the list. Here are the best-scored companies for the current filters.</p>
        <table class="fin peers"><tr><th>Company</th><th>Revenue</th><th>Margin</th><th>EV / EBITDA</th><th>Score</th></tr>
        ${best.map((i) => `<tr data-s="${U.s[i]}"><td>${esc(U.n[i])}</td><td>${money(U.r[i])}</td><td>${pct(U.m[i])}</td><td>${mult(U.x[i])}</td><td>${U.sc[i] ?? "–"}</td></tr>`).join("")}</table></div>`;
      box.querySelectorAll("tr[data-s]").forEach((tr) => (tr.onclick = () => (location.hash = "#analyse-" + tr.dataset.s)));
      return;
    }
    const i = U.s.indexOf(siren);
    if (i < 0) { box.innerHTML = `<div class="empty">Company ${esc(siren)} is not in the universe: its latest due accounts are missing, confidential or failed the checks.</div>`; return; }
    box.innerHTML = `<div class="empty">Loading accounts…</div>`;
    const pre = siren.slice(0, 3);
    (SHARDS[pre] ? Promise.resolve(SHARDS[pre]) : fetch(`data/co/${pre}.json`, { cache: "no-cache" }).then((r) => r.json()).then((d) => (SHARDS[pre] = d)))
      .then((d) => buildCompany(i, d[siren]))
      .catch((e) => (box.innerHTML = `<div class="empty">Accounts unavailable: ${esc(e.message)}</div>`));
  }
  function buildCompany(i, rec) {
    const rows = Array.isArray(rec) ? rec : rec.h, proof = Array.isArray(rec) ? {} : rec.p || {};
    const F_ = META.detail_fields, unit = META.detail_unit;
    const years = rows.map((r) => { const o = { closing: r[0] }; F_.forEach((f, j) => (o[f] = r[j + 1] * unit)); return o; });
    const c = Object.assign({}, years[years.length - 1]); delete c.closing;
    const hist = { revenue: years.map((y) => y.revenue), ebitda: years.map((y) => y.ebitda) };
    const sec = META.sectors[U.d[i]];
    CO = { i, siren: U.s[i], c, hist, years, proof, s: { beta_u: sec.beta_u, de: sec.de, ev_ebitda: sec.ev_ebitda }, P: {} };
    renderCompany();
  }
  const MKT = () => ({ rf: META.market.rates.oat10.value, euribor: META.market.rates.euribor3m.value, erp: META.market.erp.value, ratings: META.market.ratings });
  const CFG = () => Object.assign({ defaults: META.defaults, size_premium_bands: META.size_premium_bands }, META.model);
  const compute = (extra) => Valuation.value(CO.c, CO.hist, MKT(), CO.s, Object.assign({}, CO.P, extra || {}), CFG());

  const PARAMS = [
    ["rf", "Risk-free rate (French 10y OAT)", 0, 0.08, 0.0005, "p", (v) => v.wacc.rf, () => `ECB · ${META.market.rates.oat10.date}`],
    ["erp", "Equity risk premium", 0.02, 0.09, 0.0005, "p", (v) => v.wacc.erp, () => "Damodaran · " + META.market.erp.date],
    ["beta_u", "Sector unlevered beta", 0.2, 2.5, 0.01, "n", (v) => v.wacc.beta_u, () => `Damodaran · ${META.sectors[U.d[CO.i]].industry}`],
    ["de", "Target debt / equity", 0, 2, 0.01, "p", (v) => v.wacc.de, () => "Sector average structure"],
    ["size_premium", "Size and illiquidity premium", 0, 0.08, 0.0025, "p", (v) => v.wacc.size_premium, () => "Assumption by revenue band"],
    ["euribor", "Euribor 3 months", 0, 0.06, 0.0005, "p", (v) => v.wacc.euribor, () => `ECB · ${META.market.rates.euribor3m.date}`],
    ["spread", "Credit spread", 0, 0.2, 0.0005, "p", (v) => v.wacc.spread, (v) => `Synthetic rating ${v.wacc.rating}${v.wacc.coverage !== null ? " · coverage " + NF1.format(v.wacc.coverage) + "x" : ""}`],
    ["g0", "Revenue growth, year 1", -0.1, 0.3, 0.0025, "p", (v) => v.dcf.g0, () => "Historical annual growth"],
    ["margin", "Projected EBITDA margin", -0.2, 0.6, 0.0025, "p", (v) => v.dcf.margin, () => "Average of the last 3 years"],
    ["g_terminal", "Terminal growth", 0, 0.04, 0.0025, "p", (v) => v.dcf.g_terminal, () => "Close to target inflation"],
    ["ev_ebitda", "Sector EV/EBITDA multiple", 2, 30, 0.1, "x", (v) => v.multiple.multiple, () => "Listed peers · Damodaran"],
    ["illiquidity", "Private company discount", 0, 0.5, 0.01, "p", (v) => v.params.illiquidity, () => "Usual assumption for an SME"],
  ];
  const fmtParam = (kind, v) => (v === null || v === undefined ? "–" : kind === "p" ? pct(v, 2) : kind === "x" ? mult(v) : NF2.format(v));

  function renderCompany() {
    const { i } = CO;
    const sec = META.sectors[U.d[i]];
    const size = META.size_labels[U.sz[i]] || "n/a";
    const fy = U.cl[i] ? "FY" + U.cl[i].slice(0, 4) : "";
    $("co").innerHTML = `
      <div class="cohead"><div><h1>${esc(U.n[i])}</h1>
        <div class="tags"><span class="chip">SIREN <b>${U.s[i].replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3")}</b></span>
        <span class="chip">${esc(sec.en)} <b>${esc(U.naf[i] || "")}</b></span><span class="chip">${esc(U.c[i] || "")} <b>${esc(U.dep[i] || "")}</b></span>
        <span class="chip">Headcount <b>${esc(size)}</b></span>${U.cr[i] ? `<span class="chip">Founded <b>${U.cr[i]}</b></span>` : ""}
        <span class="chip"><i class="dot"></i>Accounts to <b>${date(U.cl[i])}</b></span></div></div>
        <div class="actions"><button class="ghost" id="resetP">Reset assumptions</button><button class="primary" id="xlsBtn">Download the Excel model</button></div></div>
      <div class="kpis" id="kpis"></div>
      <div class="grid2">
        <div class="stack">
          <div class="panel"><h2>Valuation range</h2><p class="hint">Enterprise value by method. DCF shown with the cost of capital ±1 point, multiples ±2x.</p><div id="ff"></div></div>
          <div class="panel"><h2>Reported history</h2><p class="hint">Revenue and EBITDA as filed with INPI; margin as a line.</p><div id="hist"></div></div>
          <div class="panel"><h2>Discounted cash flows</h2><p class="hint">${META.defaults.years}-year projection, €k. FCFF = operating profit after tax + depreciation − capex − change in working capital.</p><div class="scroll" id="dcfT"></div></div>
        </div>
        <div class="stack">
          <div class="panel"><h2>Source and verification</h2><div id="proof"></div></div>
          <div class="panel"><h2>Assumptions</h2><p class="hint">Today's values by default. Move a slider and everything recalculates.</p><div class="params" id="params"></div></div>
          <div class="panel"><h2>Cost of capital (WACC)</h2><div id="waccT"></div></div>
          <div class="panel"><h2>LBO test</h2><p class="hint">Bought at the multiple value, debt of ${NF1.format(META.defaults.lbo_leverage)}x EBITDA at Euribor + ${pct(META.defaults.lbo_margin, 1)}, exit after ${META.defaults.lbo_years} years at the same multiple.</p><div id="lboT"></div></div>
          <div class="panel"><h2>Comparable companies</h2><p class="hint">Same NAF division, closest size.</p><div id="peers"></div></div>
          <div class="panel"><h2>Market data</h2><ul class="src" id="srcs"></ul></div>
        </div>
      </div>`;
    $("resetP").onclick = () => { CO.P = {}; renderParams(); update(); };
    $("xlsBtn").onclick = () => AtlasExcel.export({ name: U.n[i], siren: U.s[i], naf: U.naf[i], sector: sec, closing: U.cl[i], proof: CO.proof, years: CO.years, c: CO.c, hist: CO.hist, v: compute(), meta: META });
    renderProof(fy); renderParams(); update(); renderHistory(); renderPeers(); renderSources();
  }
  function renderProof(fy) {
    const p = CO.proof || {}, cl = U.cl[CO.i];
    const due = addMonths(cl, META.rule.months_until_next_accounts_due);
    const ok = (t, sub) => `<li><span class="okc">✓</span><div>${t}${sub ? `<small>${sub}</small>` : ""}</div></li>`;
    const items = [
      ok(`Latest due accounts on file: ${fy}, closed ${date(cl)}`, `The next accounts are not due before ${date(due)} (approval within 6 months, filing within 2).`),
      p.filed ? ok(`Filed with INPI on ${date(p.filed)}`, p.source === "inpi_api" ? "Read from the official INPI API (Registre national des entreprises)." : p.source === "sample" ? "Fictional sample data." : "Read from the INPI open-data file on data.gouv.fr.") : "",
      p.entry_code === "0" ? ok("Keyed in by INPI with no anomaly", "INPI quality code 0: no inconsistency or missing data flagged.") : "",
      p.months === "12" ? ok("12-month financial year", "No short or long year distorting the figures.") : "",
      ok("Public accounts, full regime", "Complete tax return (forms 2050 to 2053), no confidentiality option."),
      ok("Accounting checks passed", "Operating income and charges add up, operating profit = income − charges, assets = liabilities, net income matches the balance sheet."),
    ].join("");
    const link = `https://data.inpi.fr/entreprises/${CO.siren}`;
    $("proof").innerHTML = `<ul class="checks">${items}</ul>
      <p class="hint" style="margin:10px 0 0">Reported figures (revenue, EBITDA, debt, cash) come straight from the filing. EV, equity value and IRR are model estimates.</p>
      <div class="actions"><a class="ghost" href="${link}" target="_blank" rel="noopener">View the official filing (data.inpi.fr)</a>
      <a class="ghost" href="https://annuaire-entreprises.data.gouv.fr/entreprise/${CO.siren}" target="_blank" rel="noopener">Company register</a></div>`;
  }
  function renderParams() {
    const v = compute();
    $("params").innerHTML = PARAMS.map(([k, l, lo, hi, st, kind, get, src]) => {
      const val = get(v);
      return `<div class="param ${k in CO.P ? "changed" : ""}" data-k="${k}"><label for="p_${k}">${l}<output id="o_${k}">${fmtParam(kind, val)}</output></label>
        <input id="p_${k}" type="range" min="${lo}" max="${hi}" step="${st}" value="${val ?? lo}" ${val === null ? "disabled" : ""}><small id="s_${k}">${esc(src(v))}</small></div>`;
    }).join("");
    PARAMS.forEach(([k, , , , , kind]) => {
      const el = $("p_" + k);
      el.oninput = () => {
        CO.P[k] = +el.value;
        el.parentElement.classList.add("changed");
        $("o_" + k).textContent = fmtParam(kind, +el.value);
        const v = update();
        PARAMS.forEach(([k2, , , , , , , src2]) => { const s = $("s_" + k2); if (s) s.textContent = src2(v); });
      };
    });
  }
  function update() {
    const v = compute(), c = CO.c;
    const lo = compute({ wacc_shift: 0.01 }), hi = compute({ wacc_shift: -0.01 });
    const nd = v.net_debt, fy = "FY" + U.cl[CO.i].slice(0, 4);
    $("kpis").innerHTML = [
      ["Revenue", eur(c.revenue), "reported · " + fy],
      ["EBITDA", eur(c.ebitda), "reported · margin " + pct(c.ebitda / c.revenue)],
      ["Revenue growth", pct(v.dcf.g0, 1, true), "per year, reported history"],
      ["Net debt", eur(nd), "reported" + (c.ebitda > 0 ? " · " + mult(nd / c.ebitda) + " EBITDA" : "")],
      ["Enterprise value", eur(v.ev), "estimate" + (v.ev && c.ebitda > 0 ? " · " + mult(v.ev / c.ebitda) + " EBITDA" : ""), true],
      ["Equity value", eur(v.equity), "estimate · EV − net debt"],
    ].map(([l, b, s, hero]) => `<div class="kpi ${hero ? "hero" : ""}"><span>${l}</span><b>${b}</b><small>${s}</small></div>`).join("");
    football(v, lo, hi); dcfTable(v); waccTable(v); lboTable(v);
    return v;
  }
  function football(v, lo, hi) {
    const bars = [];
    if (v.ev_dcf !== null) bars.push({ l: "DCF", a: lo.ev_dcf, b: hi.ev_dcf, m: v.ev_dcf, sub: "WACC " + pct(v.wacc.wacc) + " ±1 pt" });
    if (v.ev_mult !== null) {
      const ap = v.multiple.applied, e = CO.c.ebitda;
      bars.push({ l: "Multiple", a: Math.max(0, ap - 2) * e, b: (ap + 2) * e, m: v.ev_mult, sub: mult(ap) + " ±2x (" + mult(v.multiple.multiple) + " − " + pct(v.params.illiquidity, 0) + ")" });
    }
    if (v.lbo) bars.push({ l: "LBO price", a: v.lbo.entry_ev, b: v.lbo.entry_ev, m: v.lbo.entry_ev, sub: "IRR " + (v.lbo.irr <= -1 ? "negative" : pct(v.lbo.irr, 0)) });
    if (!bars.length) { $("ff").innerHTML = `<p class="hint">No valuation: EBITDA and projected cash flows are negative.</p>`; return; }
    const W_ = 640, rowH = 46, left = 112, right = 24, H_ = bars.length * rowH + 34;
    const vals = bars.flatMap((b) => [b.a, b.b, b.m]).concat(v.ev ? [v.ev] : []);
    const x = d3.scaleLinear().domain([Math.min(0, d3.min(vals)), d3.max(vals) * 1.08]).nice().range([left, W_ - right]);
    let s = `<svg class="chart" viewBox="0 0 ${W_} ${H_}" role="img" aria-label="Valuation range">`;
    x.ticks(5).forEach((t) => (s += `<line x1="${x(t)}" x2="${x(t)}" y1="6" y2="${H_ - 22}" stroke="var(--line)"/><text x="${x(t)}" y="${H_ - 6}" text-anchor="middle">${money(t / 1000)}</text>`));
    bars.forEach((b, j) => {
      const y = 10 + j * rowH, a = Math.min(b.a, b.b), z = Math.max(b.a, b.b);
      s += `<text class="lbl" x="0" y="${y + 15}">${b.l}</text><text x="0" y="${y + 30}" style="font-size:10px">${esc(b.sub)}</text>`;
      s += `<rect x="${x(a)}" y="${y + 4}" width="${Math.max(3, x(z) - x(a))}" height="22" rx="5" fill="${j === 2 ? "var(--gold)" : "var(--accent)"}" opacity="${j === 2 ? 0.9 : 0.22 + 0.2 * j}"/>`;
      s += `<line x1="${x(b.m)}" x2="${x(b.m)}" y1="${y}" y2="${y + 30}" stroke="var(--ink)" stroke-width="2"/>`;
      s += `<text x="${Math.min(x(z) + 8, W_ - right - 50)}" y="${y + 20}" style="fill:var(--ink)">${money(b.m / 1000)}</text>`;
    });
    if (v.ev) s += `<line x1="${x(v.ev)}" x2="${x(v.ev)}" y1="2" y2="${H_ - 22}" stroke="var(--gold)" stroke-dasharray="4 3" stroke-width="1.5"/>`;
    $("ff").innerHTML = s + "</svg>" + (v.ev ? `<p class="hint" style="margin:6px 0 0">Central value (average of DCF and multiple, dashed line): <b class="num">${eur(v.ev)}</b>.${v.gap === null ? "" : ` The DCF is ${pct(Math.abs(v.gap), 0)} ${v.gap >= 0 ? "above" : "below"} the multiple.`}</p>` : "");
  }
  function dcfTable(v) {
    const d = v.dcf, c = CO.c, yrs = d.rows;
    const head = `<tr><th></th><th>FY${CO.years[CO.years.length - 1].closing.slice(0, 4)} actual</th>${yrs.map((r) => `<th>Y+${r.year}</th>`).join("")}</tr>`;
    const tl = (l, val, note = "", cl = "") => `<tr class="${cl}"><td>${l}</td><td>${val}</td><td colspan="${yrs.length}" class="note">${note}</td></tr>`;
    const line = (l, f0, f, cl = "") => `<tr class="${cl}"><td>${l}</td><td>${f0}</td>${yrs.map((r) => `<td>${f(r)}</td>`).join("")}</tr>`;
    $("dcfT").innerHTML = `<table class="fin">${head}
      ${line("Revenue", k0(c.revenue), (r) => k0(r.revenue))}
      ${line("Growth", "", (r) => pct(r.growth))}
      ${line("EBITDA", k0(c.ebitda), (r) => k0(r.ebitda))}
      ${line("Depreciation", k0(c.da), (r) => k0(-r.da))}
      ${line("EBIT", k0(c.ebit), (r) => k0(r.ebit))}
      ${line("Tax (" + pct(v.params.tax, 0) + ")", "", (r) => k0(-r.tax))}
      ${line("Capex", "", (r) => k0(-r.capex))}
      ${line("Change in working capital", "", (r) => k0(-r.dbfr))}
      ${line("FCFF", "", (r) => k0(r.fcff), "tot")}
      ${line("Discount factor", "", (r) => NF2.format(r.df))}
      ${line("Present value", "", (r) => k0(r.pv))}
      ${tl("Sum of discounted cash flows", k0(d.pv_fcff))}
      ${tl("Discounted terminal value (g = " + pct(d.g_terminal) + ")", k0(d.pv_tv), d.tv_share !== null ? pct(d.tv_share, 0) + " of enterprise value" : "")}
      ${tl("Enterprise value (DCF)", k0(d.ev), "", "tot")}
      ${tl("− Net debt", k0(v.net_debt))}
      ${tl("Equity value (DCF)", k0(v.equity_dcf), "", "tot")}</table>`;
  }
  function waccTable(v) {
    const w = v.wacc;
    const r = (l, val, note = "") => `<tr><td>${l}</td><td>${val}</td><td class="note">${note}</td></tr>`;
    $("waccT").innerHTML = `<table class="fin">
      ${r("Risk-free rate", pct(w.rf, 2), "French 10y OAT")}
      ${r("Relevered beta", NF2.format(w.beta_l), `${NF2.format(w.beta_u)} × (1 + (1 − ${pct(v.params.tax, 0)}) × ${pct(w.de, 0)})`)}
      ${r("Equity risk premium", pct(w.erp, 2), "")}
      ${r("Size premium", pct(w.size_premium, 2), "")}
      ${r("Cost of equity", pct(w.ke, 2), "rf + β × ERP + size")}
      ${r("Pre-tax cost of debt", pct(w.kd, 2), `Euribor ${pct(w.euribor, 2)} + ${pct(w.spread, 2)} (${w.rating})`)}
      ${r("Equity / debt weights", pct(w.we, 0) + " / " + pct(w.wd, 0), "")}
      <tr class="tot"><td>WACC</td><td>${pct(w.wacc, 2)}</td><td></td></tr></table>`;
  }
  function lboTable(v) {
    const L = v.lbo;
    if (!L) { $("lboT").innerHTML = `<p class="hint">No LBO test: EBITDA is negative or no sector multiple is available.</p>`; return; }
    const e = CO.c.ebitda;
    $("lboT").innerHTML = `<div class="lbo">${mini("Entry price", eur(L.entry_ev))}${mini("Debt", eur(L.debt0) + " · " + mult(L.debt0 / e))}
      ${mini("Sponsor IRR", L.irr <= -1 ? "total loss" : pct(L.irr, 1))}${mini("Money multiple", mult(L.moic))}</div>
      <table class="fin"><tr><th>Year</th>${L.path.map((p) => `<th>Y+${p.year}</th>`).join("")}</tr>
      <tr><td>Interest</td>${L.path.map((p) => `<td>${k0(p.interest)}</td>`).join("")}</tr>
      <tr><td>Debt outstanding</td>${L.path.map((p) => `<td>${k0(p.debt)}</td>`).join("")}</tr>
      <tr><td>Cash</td>${L.path.map((p) => `<td>${k0(p.cash)}</td>`).join("")}</tr></table>`;
  }
  function renderHistory() {
    const ys = CO.years;
    const W_ = 640, H_ = 220, l = 58, r = 44, t = 12, b = 28;
    const x = d3.scaleBand().domain(ys.map((y) => y.closing)).range([l, W_ - r]).padding(0.28);
    const y = d3.scaleLinear().domain([Math.min(0, d3.min(ys, (d) => d.ebitda)), d3.max(ys, (d) => d.revenue) * 1.1]).nice().range([H_ - b, t]);
    const ms = ys.map((d) => d.ebitda / d.revenue);
    const y2 = d3.scaleLinear().domain([Math.min(0, d3.min(ms)), Math.max(0.05, d3.max(ms) * 1.25)]).nice().range([H_ - b, t]);
    let s = `<svg class="chart" viewBox="0 0 ${W_} ${H_}" role="img" aria-label="Reported history">`;
    y.ticks(4).forEach((v) => (s += `<line x1="${l}" x2="${W_ - r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${l - 6}" y="${y(v) + 4}" text-anchor="end">${money(v / 1000)}</text>`));
    y2.ticks(4).forEach((v) => (s += `<text x="${W_ - r + 6}" y="${y2(v) + 4}" style="fill:var(--gold)">${pct(v, 0)}</text>`));
    const bw = x.bandwidth() / 2;
    ys.forEach((d) => {
      const x0 = x(d.closing);
      s += `<rect x="${x0}" y="${y(d.revenue)}" width="${bw - 2}" height="${y(0) - y(d.revenue)}" rx="3" fill="var(--map-edge)"/>`;
      s += `<rect x="${x0 + bw}" y="${d.ebitda >= 0 ? y(d.ebitda) : y(0)}" width="${bw - 2}" height="${Math.abs(y(d.ebitda) - y(0))}" rx="3" fill="var(--accent)"/>`;
      s += `<text x="${x0 + x.bandwidth() / 2}" y="${H_ - 8}" text-anchor="middle">FY${d.closing.slice(0, 4)}</text>`;
    });
    const line = d3.line().x((d) => x(d.closing) + x.bandwidth() / 2).y((d) => y2(d.ebitda / d.revenue));
    s += `<path d="${line(ys)}" fill="none" stroke="var(--gold)" stroke-width="2.5"/>`;
    ys.forEach((d) => (s += `<circle cx="${x(d.closing) + x.bandwidth() / 2}" cy="${y2(d.ebitda / d.revenue)}" r="4" fill="var(--gold)"/>`));
    s += `<g transform="translate(${l},${t})"><rect width="10" height="10" rx="2" fill="var(--map-edge)"/><text x="14" y="9">Revenue</text><rect x="74" width="10" height="10" rx="2" fill="var(--accent)"/><text x="88" y="9">EBITDA</text><circle cx="150" cy="5" r="4" fill="var(--gold)"/><text x="158" y="9">Margin</text></g>`;
    $("hist").innerHTML = s + "</svg>";
  }
  function renderPeers() {
    const { i } = CO;
    const lr = Math.log(Math.max(U.r[i], 1));
    const cand = [];
    for (let j = 0; j < N; j++) if (j !== i && U.d[j] === U.d[i]) cand.push([Math.abs(Math.log(Math.max(U.r[j], 1)) - lr), j]);
    cand.sort((a, b) => a[0] - b[0]);
    const rows = cand.slice(0, 8).map(([, j]) => j);
    if (!rows.length) { $("peers").innerHTML = `<p class="hint">No other company of this division in the universe.</p>`; return; }
    $("peers").innerHTML = `<table class="fin peers"><tr><th>Company</th><th>Revenue</th><th>Margin</th><th>EV/EBITDA</th><th>Score</th></tr>
      ${rows.map((j) => `<tr data-s="${U.s[j]}"><td>${esc(U.n[j])}</td><td>${money(U.r[j])}</td><td>${pct(U.m[j])}</td><td>${mult(U.x[j])}</td><td>${U.sc[j] ?? "–"}</td></tr>`).join("")}</table>`;
    $("peers").querySelectorAll("tr[data-s]").forEach((tr) => (tr.onclick = () => (location.hash = "#analyse-" + tr.dataset.s)));
  }
  function renderSources() {
    const m = META.market, r = m.rates;
    const items = [
      `French 10y OAT: ${pct(r.oat10.value, 2)}, ${r.oat10.date} (${esc(r.oat10.source)}).`,
      `Euribor 3 months: ${pct(r.euribor3m.value, 2)}, ${r.euribor3m.date} (${esc(r.euribor3m.source)}).`,
      `Betas: ${esc(m.betas_source.source)}. Multiples: ${esc(m.multiples_source.source)}.`,
      `Equity risk premium: ${pct(m.erp.value, 2)} (${esc(m.erp.source)}). Credit spreads: ${esc(m.ratings.source)}.`,
      `Company identity, sector (NAF) and head office: INSEE SIRENE register.`,
    ];
    $("srcs").innerHTML = items.map((x) => `<li>${x}</li>`).join("") + (m.warnings.length ? `<li style="color:var(--neg)">Fallback values used: ${esc(m.warnings.join("; "))}</li>` : "");
  }

  /* ---------- method ---------- */
  function methodHtml() {
    const w = META.score_weights;
    return `<h2>Method and sources</h2>
      <h3>Which companies appear</h3><p>Only companies for which a buyer could ask for, and get, the <b>latest accounts</b>: the accounts that are legally due have been filed (last year-end after ${date(META.cutoff)}: the next accounts fall due ${META.rule.months_until_next_accounts_due} months after a year-end), they are public and complete (full tax return, no confidentiality option), cover 12 months in euros, were keyed in by INPI without anomaly, pass the accounting checks (income and charges add up, balance sheet balances), and show revenue of at least ${money(META.rule.min_revenue / 1000)}. Holding companies, finance, insurance and sole traders are excluded. ${NF0.format(META.count)} companies qualify today.</p>
      <h3>Valuation</h3><p><b>DCF</b> over ${META.defaults.years} years: historical growth converging to ${pct(META.defaults.g_terminal)}, EBITDA margin averaged over the last 3 years, capex and working capital in proportion to growth, ${pct(META.defaults.tax, 0)} corporate tax. Discounted at the WACC: French 10y OAT + relevered sector beta × equity risk premium + size premium; cost of debt = Euribor 3M + spread from a synthetic rating (interest coverage).</p>
      <p><b>Multiple</b>: EV/EBITDA of listed European peers in the sector (Damodaran), with a ${pct(META.defaults.illiquidity, 0)} discount for a private company. The <b>central value</b> is the average of both methods.</p>
      <p><b>LBO test</b>: bought at the multiple value, ${NF1.format(META.defaults.lbo_leverage)}x EBITDA of debt, cash flows repay debt, exit after ${META.defaults.lbo_years} years at the same multiple.</p>
      <h3>Attractiveness score (0 to 100)</h3><p>Weighted percentile rank: growth ${pct(w.growth, 0)}, margin versus sector median ${pct(w.margin_vs_sector, 0)}, EBITDA-to-cash conversion ${pct(w.cash_conversion, 0)}, low leverage ${pct(w.low_leverage, 0)}, LBO test IRR ${pct(w.lbo_irr, 0)}.</p>
      <h3>Limits</h3><ul><li>Filed accounts always lag actual trading by a few months.</li><li>No automatic adjustments (owner pay, one-offs, leases): adjust the margin on the company page.</li><li>Multiples come from listed companies; an SME usually trades lower, hence the discount.</li><li>Decision-support tool, not investment advice.</li></ul>
      <h3>Updates</h3><p>Every night: new filings (INPI), Euribor and OAT (ECB). Last update ${date(META.built_at.slice(0, 10))}.</p>`;
  }
})();
