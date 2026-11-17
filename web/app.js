/* Atlas M&A — map, sortable list and company valuation. Data: data/meta.json, data/universe.json, data/co/<prefix>.json */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf = (d) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: d, minimumFractionDigits: d });
  const NF0 = nf(0), NF1 = nf(1), NF2 = nf(2);

  /* ---------- formatting (universe amounts are k€, analysis amounts are €) ---------- */
  function money(k) {
    if (k === null || k === undefined || Number.isNaN(k)) return "–";
    const a = Math.abs(k);
    if (a >= 1e6) return NF1.format(k / 1e6) + " Md€";
    if (a >= 1e4) return NF0.format(k / 1e3) + " M€";
    if (a >= 1e3) return NF1.format(k / 1e3) + " M€";
    return NF0.format(k) + " k€";
  }
  const eur = (e) => (e === null || e === undefined ? "–" : money(e / 1000));
  const pct = (x, d = 1, sign = false) => (x === null || x === undefined || Number.isNaN(x) ? "–" : (sign && x > 0 ? "+" : "") + nf(d).format(x * 100) + " %");
  const mult = (x) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : NF1.format(x) + "x");
  const frDate = (s) => (s ? s.slice(8, 10) + "/" + s.slice(5, 7) + "/" + s.slice(0, 4) : "–");
  const cls = (x) => (x === null || x === undefined ? "mut" : x >= 0 ? "pos" : "neg");

  const REGIONS = {
    "Auvergne-Rhône-Alpes": "01 03 07 15 26 38 42 43 63 69 73 74", "Bourgogne-Franche-Comté": "21 25 39 58 70 71 89 90",
    "Bretagne": "22 29 35 56", "Centre-Val de Loire": "18 28 36 37 41 45", "Corse": "2A 2B",
    "Grand Est": "08 10 51 52 54 55 57 67 68 88", "Hauts-de-France": "02 59 60 62 80", "Île-de-France": "75 77 78 91 92 93 94 95",
    "Normandie": "14 27 50 61 76", "Nouvelle-Aquitaine": "16 17 19 23 24 33 40 47 64 79 86 87",
    "Occitanie": "09 11 12 30 31 32 34 46 48 65 66 81 82", "Pays de la Loire": "44 49 53 72 85",
    "Provence-Alpes-Côte d'Azur": "04 05 06 13 83 84", "Outre-mer": "971 972 973 974 976",
  };
  const DEP2REG = {};
  for (const [r, ds] of Object.entries(REGIONS)) ds.split(" ").forEach((d) => (DEP2REG[d] = r));

  let META, U, N, GEO, DEPNAME = {};
  let F = new Int32Array(0);                  // indices of companies passing the filters
  const S = { q: "", macros: new Set(), div: "", reg: "", dep: "", rmin: null, rmax: null, margin: -20, growth: -5, mult: 25, score: 0,
    pos: false, color: "sc", fill: "none", sort: { key: "sc", dir: -1 }, selected: -1 };

  /* ---------- boot ---------- */
  Promise.all(["data/meta.json", "data/universe.json", "data/departements.json"].map((u) => fetch(u).then((r) => {
    if (!r.ok) throw new Error(u + " " + r.status);
    return r.json();
  }))).then(([m, u, g]) => {
    META = m; U = u; GEO = g; N = U.s.length;
    g.features.forEach((f) => (DEPNAME[f.properties.code] = f.properties.nom));
    U.mac = U.d.map((d) => (META.sectors[d] ? META.sectors[d].macro : ""));
    U.lc = U.n.map((n) => (n || "").toLocaleLowerCase("fr"));
    U.reg = U.dep.map((d) => DEP2REG[d] || "");
    initChrome(); initFilters(); initMap(); initList();
    applyFilters();
    window.addEventListener("hashchange", route);
    route();
  }).catch((e) => {
    document.querySelector(".shell").innerHTML = `<div class="empty"><h2>Données indisponibles</h2><p>${esc(e.message)}. Lancez <code>python -m pipeline.build --sample</code> puis rechargez.</p></div>`;
  });

  /* ---------- header: data freshness ---------- */
  function initChrome() {
    const r = META.market.rates;
    const chip = (label, v, live) => `<span class="chip"><i class="dot ${live === false ? "off" : ""}"></i>${label} <b>${v}</b></span>`;
    $("fresh").innerHTML =
      chip("Comptes clos après le", frDate(META.cutoff)) +
      chip("OAT 10 ans", pct(r.oat10.value, 2) + " · " + r.oat10.date, r.oat10.live) +
      chip("Euribor 3M", pct(r.euribor3m.value, 2) + " · " + r.euribor3m.date, r.euribor3m.live) +
      chip("Mise à jour", frDate(META.built_at.slice(0, 10)));
    $("sampleBanner").hidden = !META.sample;
    $("methodBtn").onclick = () => { $("methodBody").innerHTML = methodHtml(); $("method").showModal(); };
  }

  /* ---------- filters ---------- */
  function initFilters() {
    const mac = $("fMacro");
    const counts = {};
    U.mac.forEach((m) => (counts[m] = (counts[m] || 0) + 1));
    Object.entries(META.macros).filter(([k]) => counts[k]).sort((a, b) => counts[b[0]] - counts[a[0]]).forEach(([k, v]) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = v.fr; b.dataset.k = k;
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
    const pre = [["2–10", 2, 10], ["10–50", 10, 50], ["50–250", 50, 250], ["250+", 250, null]];
    pre.forEach(([l, a, b]) => {
      const bt = document.createElement("button"); bt.type = "button"; bt.textContent = l + " M€";
      bt.onclick = () => { S.rmin = a; S.rmax = b; $("fRmin").value = a; $("fRmax").value = b ?? ""; applyFilters(); };
      $("fRpre").appendChild(bt);
    });
    const slider = (id, out, key, fmt) => {
      const el = $(id), o = $(out);
      const upd = () => { S[key] = +el.value; o.textContent = fmt(+el.value); };
      el.oninput = () => { upd(); applyFilters(); }; upd();
    };
    slider("fMargin", "oMargin", "margin", (v) => (v <= -20 ? "toutes" : v + " %"));
    slider("fGrowth", "oGrowth", "growth", (v) => (v <= -5 ? "toutes" : v + " %"));
    slider("fMult", "oMult", "mult", (v) => (v >= 25 ? "tous" : NF1.format(v) + "x"));
    slider("fScore", "oScore", "score", (v) => (v <= 0 ? "tous" : v));
    $("fPos").onchange = (e) => { S.pos = e.target.checked; applyFilters(); };
    $("resetBtn").onclick = reset;
  }
  function fillDivs() {
    const sel = $("fDiv");
    sel.length = 1;
    Object.entries(META.sectors).filter(([, v]) => !S.macros.size || S.macros.has(v.macro))
      .sort((a, b) => b[1].count - a[1].count)
      .forEach(([d, v]) => sel.add(new Option(`${v.fr} (${v.count})`, d)));
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
    const q = S.q.toLocaleLowerCase("fr"), qd = S.q.replace(/\s/g, "");
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
    $("countSub").textContent = F.length === N ? "dans l'univers" : `sur ${NF0.format(N)}`;
    buildTree(); drawMap(); renderList();
  }

  /* ---------- map ---------- */
  let canvas, ctx, proj, path, transform = d3.zoomIdentity, PX, PY, tree, zoom, W = 0, H = 0, metro;
  // perceptual ramp (plasma) from deep violet (weak) to gold (strong): readable on light and dark backgrounds
  const RAMP = () => (t) => d3.interpolatePlasma(0.08 + 0.84 * t);
  let ramp;
  function initMap() {
    canvas = $("map"); ctx = canvas.getContext("2d");
    metro = { type: "FeatureCollection", features: GEO.features.filter((f) => f.properties.code.length === 2) };
    proj = d3.geoConicConformal().parallels([44, 49]).rotate([-3, 0]);
    path = d3.geoPath(proj, ctx);
    ramp = RAMP();
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { ramp = RAMP(); drawMap(); });
    zoom = d3.zoom().scaleExtent([1, 60]).on("zoom", (e) => { transform = e.transform; drawMap(); })
      .on("start", () => canvas.classList.add("drag")).on("end", () => canvas.classList.remove("drag"));
    d3.select(canvas).call(zoom).on("dblclick.zoom", null);
    $("zin").onclick = () => d3.select(canvas).transition().duration(250).call(zoom.scaleBy, 1.8);
    $("zout").onclick = () => d3.select(canvas).transition().duration(250).call(zoom.scaleBy, 1 / 1.8);
    $("zreset").onclick = () => d3.select(canvas).transition().duration(300).call(zoom.transform, d3.zoomIdentity);
    canvas.addEventListener("mousemove", hover);
    canvas.addEventListener("mouseleave", () => ($("tip").hidden = true));
    canvas.addEventListener("click", (e) => { const i = nearest(e); select(i); });
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
  const LEG = { sc: ["Score d'attractivité", (v) => NF0.format(v)], m: ["Marge d'EBITDA", (v) => pct(v, 0)], g: ["Croissance annuelle", (v) => pct(v, 0)], x: ["VE / EBITDA (bas = moins cher)", (v) => mult(v)] };
  function legend(sc, counts, cmax) {
    const [title, f] = LEG[S.color];
    const stops = d3.range(0, 1.01, 0.1).map((t) => ramp(t)).join(",");
    const a = f(sc.rev ? sc.hi : sc.lo), b = f(sc.rev ? sc.lo : sc.hi);
    $("legend").innerHTML = `<div>${title}</div><div class="ramp" style="background:linear-gradient(90deg,${stops})"></div><div class="ends"><span>${a}</span><span>${b}</span></div>` +
      (counts ? `<div style="margin-top:6px">Densité : jusqu'à <b class="num">${NF0.format(cmax)}</b> sociétés par département</div>` : "") +
      `<div style="margin-top:4px">Taille du point : chiffre d'affaires</div>`;
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
    tip.innerHTML = `<b>${esc(U.n[i])}</b>${esc(sectorName(U.d[i]))} · ${esc(U.c[i] || "")}<br><span class="num">CA ${money(U.r[i])} · marge ${pct(U.m[i], 0)} · score ${U.sc[i] ?? "–"}</span>`;
    tip.hidden = false;
    const x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
    tip.style.left = Math.min(x, W - 270) + "px"; tip.style.top = Math.min(y, H - 80) + "px";
  }
  function select(i) {
    S.selected = i;
    const card = $("pick");
    if (i < 0) { card.hidden = true; drawMap(); return; }
    card.innerHTML = `<button class="x" aria-label="Fermer">×</button><h3>${esc(U.n[i])}</h3>
      <div class="meta">${esc(sectorName(U.d[i]))} · ${esc(U.c[i] || "")} (${esc(U.dep[i] || "")}) · comptes au ${frDate(U.cl[i])}</div>
      <div class="row">${mini("Chiffre d'affaires", money(U.r[i]))}${mini("EBITDA", money(U.e[i]))}${mini("Marge", pct(U.m[i]))}
      ${mini("Croissance", pct(U.g[i], 1, true))}${mini("VE estimée", money(U.ev[i]))}${mini("VE / EBITDA", mult(U.x[i]))}</div>
      <div class="actions"><a class="primary" href="#analyse-${U.s[i]}" style="text-decoration:none">Analyser la société</a>${scorePill(U.sc[i])}</div>`;
    card.querySelector(".x").onclick = () => select(-1);
    card.hidden = false;
    drawMap();
  }
  const mini = (l, v) => `<div class="mini"><span>${l}</span><b>${v}</b></div>`;
  function scorePill(s) {
    if (s === null || s === undefined) return "";
    const t = s / 100;
    const bg = ramp ? ramp(t) : "#999";
    const ink = t > 0.55 ? "#0d1b2a" : "#ffffff";
    return `<span class="pill" style="background:${bg};color:${ink}" title="Score d'attractivité sur 100">${s}</span>`;
  }
  const sectorName = (d) => (META.sectors[d] ? META.sectors[d].fr : d);

  /* ---------- list ---------- */
  const COLS = [
    { k: "n", l: "Société", w: "270px", name: true },
    { k: "r", l: "CA", w: "92px", f: money }, { k: "e", l: "EBITDA", w: "92px", f: money },
    { k: "m", l: "Marge", w: "76px", f: (v) => pct(v) }, { k: "g", l: "Croissance", w: "88px", f: (v) => pct(v, 1, true), c: true },
    { k: "nd", l: "Dette nette", w: "96px", f: money }, { k: "evd", l: "VE · DCF", w: "96px", f: money },
    { k: "evm", l: "VE · multiples", w: "104px", f: money }, { k: "ev", l: "VE centrale", w: "100px", f: money },
    { k: "x", l: "VE / EBITDA", w: "88px", f: mult }, { k: "gap", l: "DCF vs mult.", w: "92px", f: (v) => (v === null ? "–" : Math.abs(v) > 3 ? "n.s." : pct(v, 0, true)), c: true },
    { k: "irr", l: "TRI LBO", w: "80px", f: (v) => (v === null ? "–" : v <= -1 ? "perte" : pct(v, 0)), c: true },
    { k: "sc", l: "Score", w: "70px", pill: true }, { k: "cl", l: "Comptes au", w: "96px", f: frDate },
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
    const col = U[key];
    ORDER = Array.from(F);
    if (key === "n") ORDER.sort((a, b) => dir * U.lc[a].localeCompare(U.lc[b], "fr"));
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
    $("sortNote").textContent = `Tri : ${COLS.find((c) => c.k === key).l} ${dir > 0 ? "croissant" : "décroissant"} · cliquez un en-tête pour trier`;
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
        const v = U[c.k][i];
        return `<div class="td num r ${c.c ? cls(v) : ""}">${c.f(v)}</div>`;
      }).join("") + "</div>";
    }
    body.innerHTML = h || `<div class="empty">Aucune société ne correspond à ces filtres.</div>`;
  }
  function summary() {
    let rev = 0; const ms = [], xs = [];
    for (const i of F) { rev += U.r[i] || 0; ms.push(U.m[i]); if (U.x[i] !== null) xs.push(U.x[i]); }
    const med = (a) => (a.length ? d3.median(a) : null);
    $("summary").innerHTML = [["Sociétés", NF0.format(F.length)], ["Chiffre d'affaires cumulé", money(rev)],
      ["Marge d'EBITDA médiane", pct(med(ms))], ["VE / EBITDA médian", mult(med(xs))]]
      .map(([l, v]) => `<div class="tile"><span>${l}</span><b>${v}</b></div>`).join("");
  }
  function csv() {
    const head = ["siren", "societe", "secteur", "departement", "commune", "ca_keur", "ebitda_keur", "marge", "croissance", "dette_nette_keur",
      "ve_dcf_keur", "ve_multiples_keur", "ve_centrale_keur", "ve_ebitda", "tri_lbo", "score", "comptes_au"];
    const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const lines = [head.join(";")].concat(ORDER.map((i) => [U.s[i], q(U.n[i]), q(sectorName(U.d[i])), U.dep[i], q(U.c[i]), U.r[i], U.e[i], U.m[i], U.g[i], U.nd[i],
      U.evd[i], U.evm[i], U.ev[i], U.x[i], U.irr[i], U.sc[i], U.cl[i]].map((v) => (v === null || v === undefined ? "" : v)).join(";")));
    download(new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" }), "atlas-societes.csv");
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
  let CO = null;      // {i, siren, c, hist, years, s, base, P}
  function openCompany(siren) {
    const box = $("co");
    if (!siren) {
      const best = Array.from(F).sort((a, b) => (U.sc[b] ?? 0) - (U.sc[a] ?? 0)).slice(0, 12);
      box.innerHTML = `<div class="panel"><h2>Choisissez une société</h2><p class="hint">Cliquez un point sur la carte ou une ligne de la liste. Voici les mieux notées parmi les filtres actuels.</p>
        <table class="fin peers"><tr><th>Société</th><th>CA</th><th>Marge</th><th>VE / EBITDA</th><th>Score</th></tr>
        ${best.map((i) => `<tr data-s="${U.s[i]}"><td>${esc(U.n[i])}</td><td>${money(U.r[i])}</td><td>${pct(U.m[i])}</td><td>${mult(U.x[i])}</td><td>${U.sc[i] ?? "–"}</td></tr>`).join("")}</table></div>`;
      box.querySelectorAll("tr[data-s]").forEach((tr) => (tr.onclick = () => (location.hash = "#analyse-" + tr.dataset.s)));
      return;
    }
    const i = U.s.indexOf(siren);
    if (i < 0) { box.innerHTML = `<div class="empty">Société ${esc(siren)} absente de l'univers (comptes trop anciens, confidentiels ou incomplets).</div>`; return; }
    box.innerHTML = `<div class="empty">Chargement des comptes…</div>`;
    const pre = siren.slice(0, 3);
    (SHARDS[pre] ? Promise.resolve(SHARDS[pre]) : fetch(`data/co/${pre}.json`).then((r) => r.json()).then((d) => (SHARDS[pre] = d)))
      .then((d) => { buildCompany(i, d[siren]); })
      .catch((e) => (box.innerHTML = `<div class="empty">Comptes indisponibles : ${esc(e.message)}</div>`));
  }
  function buildCompany(i, rows) {
    const F_ = META.detail_fields, unit = META.detail_unit;
    const years = rows.map((r) => { const o = { closing: r[0] }; F_.forEach((f, j) => (o[f] = r[j + 1] * unit)); return o; });
    const c = Object.assign({}, years[years.length - 1]); delete c.closing;
    const hist = { revenue: years.map((y) => y.revenue), ebitda: years.map((y) => y.ebitda) };
    const sec = META.sectors[U.d[i]];
    const s = { beta_u: sec.beta_u, de: sec.de, ev_ebitda: sec.ev_ebitda };
    CO = { i, siren: U.s[i], c, hist, years, s, P: {} };
    renderCompany();
  }
  const MKT = () => ({ rf: META.market.rates.oat10.value, euribor: META.market.rates.euribor3m.value, erp: META.market.erp.value, ratings: META.market.ratings });
  const CFG = () => Object.assign({ defaults: META.defaults, size_premium_bands: META.size_premium_bands }, META.model);
  function compute(extra) { return Valuation.value(CO.c, CO.hist, MKT(), CO.s, Object.assign({}, CO.P, extra || {}), CFG()); }

  const PARAMS = [
    ["rf", "Taux sans risque (OAT 10 ans)", 0, 0.08, 0.0005, "p", (v) => v.wacc.rf, () => `BCE · ${META.market.rates.oat10.date}`],
    ["erp", "Prime de risque du marché", 0.02, 0.09, 0.0005, "p", (v) => v.wacc.erp, () => "Damodaran · " + META.market.erp.date],
    ["beta_u", "Bêta désendetté du secteur", 0.2, 2.5, 0.01, "n", (v) => v.wacc.beta_u, () => `Damodaran · ${CO.s && META.sectors[U.d[CO.i]].industry}`],
    ["de", "Dette / fonds propres cible", 0, 2, 0.01, "p", (v) => v.wacc.de, () => "Structure moyenne du secteur"],
    ["size_premium", "Prime de taille et d'illiquidité", 0, 0.08, 0.0025, "p", (v) => v.wacc.size_premium, () => "Hypothèse selon le CA"],
    ["euribor", "Euribor 3 mois", 0, 0.06, 0.0005, "p", (v) => v.wacc.euribor, () => `BCE · ${META.market.rates.euribor3m.date}`],
    ["spread", "Marge de crédit", 0, 0.2, 0.0005, "p", (v) => v.wacc.spread, (v) => `Notation synthétique ${v.wacc.rating}${v.wacc.coverage !== null ? " · couverture " + NF1.format(v.wacc.coverage) + "x" : ""}`],
    ["g0", "Croissance du CA, année 1", -0.1, 0.3, 0.0025, "p", (v) => v.dcf.g0, () => "Croissance annuelle historique"],
    ["margin", "Marge d'EBITDA projetée", -0.2, 0.6, 0.0025, "p", (v) => v.dcf.margin, () => "Moyenne des 3 derniers exercices"],
    ["g_terminal", "Croissance à l'infini", 0, 0.04, 0.0025, "p", (v) => v.dcf.g_terminal, () => "Proche de l'inflation cible"],
    ["ev_ebitda", "Multiple VE/EBITDA du secteur", 2, 30, 0.1, "x", (v) => v.multiple.multiple, () => "Sociétés cotées · Damodaran"],
    ["illiquidity", "Décote de non-cotation", 0, 0.5, 0.01, "p", (v) => v.params.illiquidity, () => "Hypothèse usuelle pour une PME"],
  ];
  const fmtParam = (kind, v) => (v === null || v === undefined ? "–" : kind === "p" ? pct(v, 2) : kind === "x" ? mult(v) : NF2.format(v));

  function renderCompany() {
    const { i, c } = CO;
    const sec = META.sectors[U.d[i]];
    const size = META.size_labels[U.sz[i]] || "n.c.";
    $("co").innerHTML = `
      <div class="cohead"><div><h1>${esc(U.n[i])}</h1>
        <div class="tags"><span class="chip">SIREN <b>${U.s[i].replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3")}</b></span>
        <span class="chip">${esc(sec.fr)} <b>${esc(U.naf[i] || "")}</b></span><span class="chip">${esc(U.c[i] || "")} <b>${esc(U.dep[i] || "")}</b></span>
        <span class="chip">Effectif <b>${esc(size)}</b></span>${U.cr[i] ? `<span class="chip">Créée en <b>${U.cr[i]}</b></span>` : ""}
        <span class="chip"><i class="dot"></i>Comptes au <b>${frDate(U.cl[i])}</b></span></div></div>
        <div class="actions"><button class="ghost" id="resetP">Hypothèses par défaut</button><button class="primary" id="xlsBtn">Télécharger le modèle Excel</button></div></div>
      <div class="kpis" id="kpis"></div>
      <div class="grid2">
        <div class="stack">
          <div class="panel"><h2>Fourchette de valorisation</h2><p class="hint">Valeur d'entreprise selon chaque méthode. Le DCF varie avec un coût du capital à ±1 point, les multiples à ±2x.</p><div id="ff"></div></div>
          <div class="panel"><h2>Historique publié</h2><p class="hint">Chiffre d'affaires et EBITDA déposés à l'INPI, marge en ligne.</p><div id="hist"></div></div>
          <div class="panel"><h2>Flux de trésorerie actualisés</h2><p class="hint">Projection sur ${META.defaults.years} ans, en k€. FCFF = résultat d'exploitation après impôt + amortissements − investissements − variation du BFR.</p><div class="scroll" id="dcfT"></div></div>
        </div>
        <div class="stack">
          <div class="panel"><h2>Hypothèses</h2><p class="hint">Valeurs du jour par défaut. Déplacez un curseur : tout se recalcule.</p><div class="params" id="params"></div></div>
          <div class="panel"><h2>Coût du capital (WACC)</h2><div id="waccT"></div></div>
          <div class="panel"><h2>Test de LBO</h2><p class="hint">Rachat au prix des multiples, dette de ${NF1.format(META.defaults.lbo_leverage)}x l'EBITDA à Euribor + ${pct(META.defaults.lbo_margin, 1)}, sortie à ${META.defaults.lbo_years} ans au même multiple.</p><div id="lboT"></div></div>
          <div class="panel"><h2>Sociétés comparables</h2><p class="hint">Même division NAF, taille la plus proche.</p><div id="peers"></div></div>
          <div class="panel"><h2>Sources et fraîcheur</h2><ul class="src" id="srcs"></ul></div>
        </div>
      </div>`;
    $("resetP").onclick = () => { CO.P = {}; renderParams(); update(); };
    $("xlsBtn").onclick = () => AtlasExcel.export({ name: U.n[i], siren: U.s[i], naf: U.naf[i], sector: sec, closing: U.cl[i], years: CO.years, c, hist: CO.hist, v: compute(), meta: META });
    renderParams(); update(); renderHistory(); renderPeers(); renderSources();
  }
  function renderParams() {
    const v = compute();
    $("params").innerHTML = PARAMS.map(([k, l, lo, hi, st, kind, get, src]) => {
      const val = get(v);
      return `<div class="param ${k in CO.P ? "changed" : ""}" data-k="${k}"><label for="p_${k}">${l}<output id="o_${k}">${fmtParam(kind, val)}</output></label>
        <input id="p_${k}" type="range" min="${lo}" max="${hi}" step="${st}" value="${val ?? lo}" ${val === null ? "disabled" : ""}><small id="s_${k}">${esc(src(v))}</small></div>`;
    }).join("");
    PARAMS.forEach(([k, , , , , kind, , src]) => {
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
    const v = compute();
    const { c } = CO;
    const lo = compute({ wacc_shift: 0.01 }), hi = compute({ wacc_shift: -0.01 });
    const nd = v.net_debt;
    $("kpis").innerHTML = [
      ["Chiffre d'affaires", eur(c.revenue), "dernier exercice"],
      ["EBITDA", eur(c.ebitda), "marge " + pct(c.ebitda / c.revenue)],
      ["Croissance", pct(v.dcf.g0, 1, true), "par an, historique"],
      ["Dette nette", eur(nd), c.ebitda > 0 ? mult(nd / c.ebitda) + " l'EBITDA" : ""],
      ["Valeur d'entreprise", eur(v.ev), v.ev && c.ebitda > 0 ? mult(v.ev / c.ebitda) + " l'EBITDA" : "", true],
      ["Valeur des fonds propres", eur(v.equity), "VE − dette nette"],
    ].map(([l, b, s, hero]) => `<div class="kpi ${hero ? "hero" : ""}"><span>${l}</span><b>${b}</b><small>${s}</small></div>`).join("");
    football(v, lo, hi);
    dcfTable(v);
    waccTable(v);
    lboTable(v);
    return v;
  }
  function football(v, lo, hi) {
    const bars = [];
    if (v.ev_dcf !== null) bars.push({ l: "DCF", a: lo.ev_dcf, b: hi.ev_dcf, m: v.ev_dcf, sub: "WACC " + pct(v.wacc.wacc) + " ±1 pt" });
    if (v.ev_mult !== null) {
      const ap = v.multiple.applied, e = CO.c.ebitda;
      bars.push({ l: "Multiples", a: Math.max(0, (ap - 2)) * e, b: (ap + 2) * e, m: v.ev_mult, sub: mult(ap) + " ±2x (" + mult(v.multiple.multiple) + " − " + pct(v.params.illiquidity, 0) + ")" });
    }
    if (v.lbo) bars.push({ l: "Prix LBO", a: v.lbo.entry_ev, b: v.lbo.entry_ev, m: v.lbo.entry_ev, sub: "TRI " + (v.lbo.irr <= -1 ? "négatif" : pct(v.lbo.irr, 0)) });
    if (!bars.length) { $("ff").innerHTML = `<p class="hint">Valorisation impossible : EBITDA et flux projetés négatifs.</p>`; return; }
    const W_ = 640, rowH = 46, left = 112, right = 24, H_ = bars.length * rowH + 34;
    const vals = bars.flatMap((b) => [b.a, b.b, b.m]).concat(v.ev ? [v.ev] : []);
    const x = d3.scaleLinear().domain([Math.min(0, d3.min(vals)), d3.max(vals) * 1.08]).nice().range([left, W_ - right]);
    let s = `<svg class="chart" viewBox="0 0 ${W_} ${H_}" role="img" aria-label="Fourchette de valorisation">`;
    x.ticks(5).forEach((t) => (s += `<line x1="${x(t)}" x2="${x(t)}" y1="6" y2="${H_ - 22}" stroke="var(--line)"/><text x="${x(t)}" y="${H_ - 6}" text-anchor="middle">${money(t / 1000)}</text>`));
    bars.forEach((b, j) => {
      const y = 10 + j * rowH;
      const a = Math.min(b.a, b.b), z = Math.max(b.a, b.b);
      s += `<text class="lbl" x="0" y="${y + 15}">${b.l}</text><text x="0" y="${y + 30}" style="font-size:10px">${esc(b.sub)}</text>`;
      s += `<rect x="${x(a)}" y="${y + 4}" width="${Math.max(3, x(z) - x(a))}" height="22" rx="5" fill="${j === 2 ? "var(--gold)" : "var(--accent)"}" opacity="${j === 2 ? 0.9 : 0.22 + 0.2 * j}"/>`;
      s += `<line x1="${x(b.m)}" x2="${x(b.m)}" y1="${y}" y2="${y + 30}" stroke="var(--ink)" stroke-width="2"/>`;
      s += `<text x="${Math.min(x(z) + 6, W_ - right - 60)}" y="${y + 20}" style="fill:var(--ink)">${money(b.m / 1000)}</text>`;
    });
    if (v.ev) s += `<line x1="${x(v.ev)}" x2="${x(v.ev)}" y1="2" y2="${H_ - 22}" stroke="var(--gold)" stroke-dasharray="4 3" stroke-width="1.5"/>`;
    $("ff").innerHTML = s + "</svg>" + (v.ev ? `<p class="hint" style="margin:6px 0 0">Valeur centrale (moyenne DCF et multiples, pointillés) : <b class="num">${eur(v.ev)}</b>. Le DCF est ${v.gap === null ? "seul" : v.gap >= 0 ? pct(v.gap, 0) + " au-dessus" : pct(-v.gap, 0) + " en dessous"}${v.gap === null ? "" : " des multiples"}.</p>` : "");
  }
  function dcfTable(v) {
    const d = v.dcf, c = CO.c, k = (e) => NF0.format(e / 1000);
    const yrs = d.rows;
    const head = `<tr><th></th><th>${frDate(CO.years[CO.years.length - 1].closing).slice(6)} réel</th>${yrs.map((r) => `<th>A+${r.year}</th>`).join("")}</tr>`;
    const tl = (l, val, note = "", cl = "") => `<tr class="${cl}"><td>${l}</td><td>${val}</td><td colspan="${yrs.length}" class="note">${note}</td></tr>`;
    const line = (l, f0, f, cl = "") => `<tr class="${cl}"><td>${l}</td><td>${f0}</td>${yrs.map((r) => `<td>${f(r)}</td>`).join("")}</tr>`;
    $("dcfT").innerHTML = `<table class="fin">${head}
      ${line("Chiffre d'affaires", k(c.revenue), (r) => k(r.revenue))}
      ${line("Croissance", "", (r) => pct(r.growth))}
      ${line("EBITDA", k(c.ebitda), (r) => k(r.ebitda))}
      ${line("Amortissements", k(c.da), (r) => k(-r.da))}
      ${line("EBIT", k(c.ebit), (r) => k(r.ebit))}
      ${line("Impôt (" + pct(v.params.tax, 0) + ")", "", (r) => k(-r.tax))}
      ${line("Investissements", "", (r) => k(-r.capex))}
      ${line("Variation du BFR", "", (r) => k(-r.dbfr))}
      ${line("FCFF", "", (r) => k(r.fcff), "tot")}
      ${line("Facteur d'actualisation", "", (r) => NF2.format(r.df))}
      ${line("Valeur actuelle", "", (r) => k(r.pv))}
      ${tl("Somme des flux actualisés", k(d.pv_fcff))}
      ${tl("Valeur terminale actualisée (g = " + pct(d.g_terminal) + ")", k(d.pv_tv), d.tv_share !== null ? pct(d.tv_share, 0) + " de la valeur d'entreprise" : "")}
      ${tl("Valeur d'entreprise (DCF)", k(d.ev), "", "tot")}
      ${tl("− Dette nette", k(v.net_debt))}
      ${tl("Valeur des fonds propres (DCF)", k(v.equity_dcf), "", "tot")}</table>`;
  }
  function waccTable(v) {
    const w = v.wacc;
    const r = (l, val, note = "") => `<tr><td>${l}</td><td>${val}</td><td class="note">${note}</td></tr>`;
    $("waccT").innerHTML = `<table class="fin">
      ${r("Taux sans risque", pct(w.rf, 2), "OAT 10 ans")}
      ${r("Bêta réendetté", NF2.format(w.beta_l), `${NF2.format(w.beta_u)} × (1 + (1 − ${pct(v.params.tax, 0)}) × ${pct(w.de, 0)})`)}
      ${r("Prime de risque", pct(w.erp, 2), "")}
      ${r("Prime de taille", pct(w.size_premium, 2), "")}
      ${r("Coût des fonds propres", pct(w.ke, 2), "rf + β × prime + taille")}
      ${r("Coût de la dette avant impôt", pct(w.kd, 2), `Euribor ${pct(w.euribor, 2)} + ${pct(w.spread, 2)} (${w.rating})`)}
      ${r("Poids fonds propres / dette", pct(w.we, 0) + " / " + pct(w.wd, 0), "")}
      <tr class="tot"><td>WACC</td><td>${pct(w.wacc, 2)}</td><td></td></tr></table>`;
  }
  function lboTable(v) {
    const L = v.lbo;
    if (!L) { $("lboT").innerHTML = `<p class="hint">Pas de test de LBO : l'EBITDA est négatif ou aucun multiple n'est disponible.</p>`; return; }
    const e = CO.c.ebitda;
    $("lboT").innerHTML = `<div class="lbo">${mini("Prix d'entrée", eur(L.entry_ev))}${mini("Dette", eur(L.debt0) + " · " + mult(L.debt0 / e))}
      ${mini("TRI du fonds", L.irr <= -1 ? "perte totale" : pct(L.irr, 1))}${mini("Multiple de mise", mult(L.moic))}</div>
      <table class="fin"><tr><th>Année</th>${L.path.map((p) => `<th>A+${p.year}</th>`).join("")}</tr>
      <tr><td>Intérêts</td>${L.path.map((p) => `<td>${NF0.format(p.interest / 1000)}</td>`).join("")}</tr>
      <tr><td>Dette restante</td>${L.path.map((p) => `<td>${NF0.format(p.debt / 1000)}</td>`).join("")}</tr>
      <tr><td>Trésorerie</td>${L.path.map((p) => `<td>${NF0.format(p.cash / 1000)}</td>`).join("")}</tr></table>`;
  }
  function renderHistory() {
    const ys = CO.years;
    const W_ = 640, H_ = 220, l = 54, r = 44, t = 12, b = 28;
    const x = d3.scaleBand().domain(ys.map((y) => y.closing)).range([l, W_ - r]).padding(0.28);
    const y = d3.scaleLinear().domain([Math.min(0, d3.min(ys, (d) => d.ebitda)), d3.max(ys, (d) => d.revenue) * 1.1]).nice().range([H_ - b, t]);
    const ms = ys.map((d) => d.ebitda / d.revenue);
    const y2 = d3.scaleLinear().domain([Math.min(0, d3.min(ms)), Math.max(0.05, d3.max(ms) * 1.25)]).nice().range([H_ - b, t]);
    let s = `<svg class="chart" viewBox="0 0 ${W_} ${H_}" role="img" aria-label="Historique">`;
    y.ticks(4).forEach((v) => (s += `<line x1="${l}" x2="${W_ - r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${l - 6}" y="${y(v) + 4}" text-anchor="end">${money(v / 1000)}</text>`));
    y2.ticks(4).forEach((v) => (s += `<text x="${W_ - r + 6}" y="${y2(v) + 4}" style="fill:var(--gold)">${pct(v, 0)}</text>`));
    const bw = x.bandwidth() / 2;
    ys.forEach((d) => {
      const x0 = x(d.closing);
      s += `<rect x="${x0}" y="${y(d.revenue)}" width="${bw - 2}" height="${y(0) - y(d.revenue)}" rx="3" fill="var(--map-edge)"/>`;
      const ye = d.ebitda >= 0 ? y(d.ebitda) : y(0);
      s += `<rect x="${x0 + bw}" y="${ye}" width="${bw - 2}" height="${Math.abs(y(d.ebitda) - y(0))}" rx="3" fill="var(--accent)"/>`;
      s += `<text x="${x0 + x.bandwidth() / 2}" y="${H_ - 8}" text-anchor="middle">${d.closing.slice(0, 4)}</text>`;
    });
    const line = d3.line().x((d) => x(d.closing) + x.bandwidth() / 2).y((d) => y2(d.ebitda / d.revenue));
    s += `<path d="${line(ys)}" fill="none" stroke="var(--gold)" stroke-width="2.5"/>`;
    ys.forEach((d) => (s += `<circle cx="${x(d.closing) + x.bandwidth() / 2}" cy="${y2(d.ebitda / d.revenue)}" r="4" fill="var(--gold)"/>`));
    s += `<g transform="translate(${l},${t})"><rect width="10" height="10" rx="2" fill="var(--map-edge)"/><text x="14" y="9">CA</text><rect x="44" width="10" height="10" rx="2" fill="var(--accent)"/><text x="58" y="9">EBITDA</text><circle cx="120" cy="5" r="4" fill="var(--gold)"/><text x="128" y="9">Marge</text></g>`;
    $("hist").innerHTML = s + "</svg>";
  }
  function renderPeers() {
    const { i } = CO;
    const lr = Math.log(Math.max(U.r[i], 1));
    const cand = [];
    for (let j = 0; j < N; j++) if (j !== i && U.d[j] === U.d[i]) cand.push([Math.abs(Math.log(Math.max(U.r[j], 1)) - lr), j]);
    cand.sort((a, b) => a[0] - b[0]);
    const rows = cand.slice(0, 8).map(([, j]) => j);
    if (!rows.length) { $("peers").innerHTML = `<p class="hint">Aucune autre société de cette division dans l'univers.</p>`; return; }
    $("peers").innerHTML = `<table class="fin peers"><tr><th>Société</th><th>CA</th><th>Marge</th><th>VE/EBITDA</th><th>Score</th></tr>
      ${rows.map((j) => `<tr data-s="${U.s[j]}"><td>${esc(U.n[j])}</td><td>${money(U.r[j])}</td><td>${pct(U.m[j])}</td><td>${mult(U.x[j])}</td><td>${U.sc[j] ?? "–"}</td></tr>`).join("")}</table>`;
    $("peers").querySelectorAll("tr[data-s]").forEach((tr) => (tr.onclick = () => (location.hash = "#analyse-" + tr.dataset.s)));
  }
  function renderSources() {
    const m = META.market, r = m.rates;
    const items = [
      `Comptes annuels déposés à l'INPI (liasse fiscale, régime normal), exercice clos le ${frDate(U.cl[CO.i])}. Source : « Données financières détaillées des entreprises », data.gouv.fr.`,
      `Identité, secteur (NAF) et adresse du siège : base SIRENE de l'INSEE.`,
      `OAT 10 ans : ${pct(r.oat10.value, 2)}, ${r.oat10.date} (${esc(r.oat10.source)}).`,
      `Euribor 3 mois : ${pct(r.euribor3m.value, 2)}, ${r.euribor3m.date} (${esc(r.euribor3m.source)}).`,
      `Bêtas : ${esc(m.betas_source.source)}. Multiples : ${esc(m.multiples_source.source)}.`,
      `Prime de risque : ${pct(m.erp.value, 2)} (${esc(m.erp.source)}). Marges de crédit : ${esc(m.ratings.source)}.`,
      `Règle d'inclusion : comptes publics, complets, clos depuis moins de ${META.rule.max_account_age_months} mois, CA ≥ ${money(META.rule.min_revenue / 1000)}.`,
    ];
    $("srcs").innerHTML = items.map((x) => `<li>${x}</li>`).join("") + (m.warnings.length ? `<li style="color:var(--neg)">Valeurs de repli utilisées : ${esc(m.warnings.join(" ; "))}</li>` : "");
  }

  /* ---------- method ---------- */
  function methodHtml() {
    const w = META.score_weights;
    return `<h2>Méthode et sources</h2>
      <h3>Quelles sociétés apparaissent</h3><p>Seulement celles dont les comptes sont <b>publics, complets et récents</b> : liasse du régime normal déposée à l'INPI, exercice clos il y a moins de ${META.rule.max_account_age_months} mois (après le ${frDate(META.cutoff)}), chiffre d'affaires d'au moins ${money(META.rule.min_revenue / 1000)}, et des comptes qui passent les contrôles comptables (produits et charges qui s'additionnent, bilan équilibré). Les holdings, la finance, l'assurance et les entrepreneurs individuels sont exclus. ${NF0.format(META.count)} sociétés remplissent ces conditions aujourd'hui.</p>
      <h3>Valorisation</h3><p><b>DCF</b> sur ${META.defaults.years} ans : croissance historique qui converge vers ${pct(META.defaults.g_terminal)}, marge d'EBITDA moyenne des 3 derniers exercices, investissements et BFR proportionnels à la croissance, impôt à ${pct(META.defaults.tax, 0)}. Actualisation au WACC : OAT 10 ans + bêta sectoriel réendetté × prime de risque + prime de taille ; coût de la dette = Euribor 3 mois + marge issue d'une notation synthétique (couverture des intérêts).</p>
      <p><b>Multiples</b> : VE/EBITDA des sociétés cotées européennes du secteur (Damodaran), avec une décote de ${pct(META.defaults.illiquidity, 0)} pour une société non cotée. La <b>valeur centrale</b> est la moyenne des deux méthodes.</p>
      <p><b>Test de LBO</b> : rachat au prix des multiples, dette de ${NF1.format(META.defaults.lbo_leverage)}x l'EBITDA, flux affectés au remboursement, sortie à ${META.defaults.lbo_years} ans au même multiple.</p>
      <h3>Score d'attractivité (0 à 100)</h3><p>Rang centile pondéré : croissance ${pct(w.growth, 0)}, marge par rapport à la médiane du secteur ${pct(w.margin_vs_sector, 0)}, conversion de l'EBITDA en cash ${pct(w.cash_conversion, 0)}, faible endettement ${pct(w.low_leverage, 0)}, TRI du test de LBO ${pct(w.lbo_irr, 0)}.</p>
      <h3>Limites</h3><ul><li>Les comptes publiés ont toujours quelques mois de retard sur l'activité réelle.</li><li>Les retraitements (rémunération du dirigeant, éléments exceptionnels, crédit-bail) ne sont pas faits automatiquement : ajustez la marge dans l'analyse.</li><li>Les multiples viennent de sociétés cotées ; une PME se négocie généralement moins cher, d'où la décote.</li><li>Outil d'aide à l'analyse, pas un conseil en investissement.</li></ul>
      <h3>Mise à jour</h3><p>Chaque nuit : nouveaux dépôts de comptes, Euribor et OAT (BCE). Dernière mise à jour le ${frDate(META.built_at.slice(0, 10))}.</p>`;
  }
})();
