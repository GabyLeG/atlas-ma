"""Build the static site data: python -m pipeline.build [--sample] [--offline]

  (default)  real build: INPI filings + SIRENE + market data, run nightly on GitHub Actions
  --sample   fictional companies for local design work, clearly flagged in the app
  --offline  do not call market sources (uses data/fallback_market.json)
"""
import argparse
import datetime as dt
import json
import math
import random
import shutil
import sys
import time

from . import config as K
from . import market as M
from . import valuation as V

SIZE_LABELS = {"00": "0", "01": "1-2", "02": "3-5", "03": "6-9", "11": "10-19", "12": "20-49", "21": "50-99",
               "22": "100-199", "31": "200-249", "32": "250-499", "41": "500-999", "42": "1 000-1 999",
               "51": "2 000-4 999", "52": "5 000-9 999", "53": "10 000+", "NN": "n.c."}


def sectors():
    return json.loads((K.DATA / "sectors.json").read_text())


def classify(naf, sec):
    """'62.01Z' -> (division '62', class '6201', industry or None if excluded)."""
    if not naf:
        return None, None, None
    code = naf.replace(".", "")
    div, cls = code[:2], code[:4]
    if cls in sec["excluded_classes"]:
        return div, cls, None
    d = sec["divisions"].get(div)
    if not d or d["industry"] is None:
        return div, cls, None
    return div, cls, sec["class_overrides"].get(cls, d["industry"])


def percentile_ranks(values):
    """Rank in [0,1] (ties averaged); None stays None."""
    idx = [i for i, v in enumerate(values) if v is not None and not (isinstance(v, float) and math.isnan(v))]
    idx.sort(key=lambda i: values[i])
    out = [None] * len(values)
    n = len(idx)
    i = 0
    while i < n:
        j = i
        while j + 1 < n and values[idx[j + 1]] == values[idx[i]]:
            j += 1
        r = ((i + j) / 2) / (n - 1) if n > 1 else 0.5
        for k in range(i, j + 1):
            out[idx[k]] = r
        i = j + 1
    return out


# per-company history is stored as [closing, *fields] rows in k€ (integers) to keep the files small
DETAIL_FIELDS = ["revenue", "ebitda", "da", "ebit", "interest", "income_tax", "net_income", "equity", "fin_debt",
                 "cash", "bfr", "fixed_assets_net", "total_assets", "wages"]

SCORE_WEIGHTS = {"growth": 0.25, "margin_vs_sector": 0.25, "cash_conversion": 0.15, "low_leverage": 0.15, "lbo_irr": 0.20}


def score(rows):
    """Attractiveness 0-100: weighted percentile of growth, margin vs sector median, cash conversion,
    low leverage and LBO return. Missing factors are skipped and the weights renormalised."""
    f = {k: percentile_ranks([r["_f"][k] for r in rows]) for k in SCORE_WEIGHTS}
    for i, r in enumerate(rows):
        num = den = 0.0
        for k, w in SCORE_WEIGHTS.items():
            if f[k][i] is not None:
                num += w * f[k][i]
                den += w
        r["score"] = round(100 * num / den) if den else None


def median(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def r4(x):
    return None if x is None else round(x, 4)


def k(x):
    return None if x is None else round(x / 1000)


def assemble(companies, ids, mkt, sec, today, stats, sample=False, log=print):
    market_in = {"rf": mkt["rates"]["oat10"]["value"], "euribor": mkt["rates"]["euribor3m"]["value"],
                 "erp": mkt["erp"]["value"], "ratings": mkt["ratings"]}
    rows, details, by_div = [], {}, {}
    for siren, co in companies.items():
        idn = ids.get(siren)
        if not idn or not idn.get("name"):
            continue
        div, cls, industry = classify(idn.get("naf"), sec)
        if industry is None:
            continue
        s_in = M.sector_inputs(mkt, industry)
        # value from the k€-rounded figures that are published, so the list and the company page agree exactly
        co = {**co, "history": [{"closing": h["closing"], **{f: k(h[f]) * 1000 for f in DETAIL_FIELDS}} for h in co["history"]]}
        c = {f: co["history"][-1][f] for f in DETAIL_FIELDS}
        hist = {"revenue": [h["revenue"] for h in co["history"]], "ebitda": [h["ebitda"] for h in co["history"]]}
        v = V.value(c, hist, market_in, s_in)
        y1 = v["dcf"]["rows"][0]
        nd_e = (v["net_debt"] / c["ebitda"]) if c["ebitda"] > 0 else None
        row = {
            "siren": siren, "name": idn["name"], "naf": idn["naf"], "div": div, "industry": industry,
            "dep": idn.get("dep"), "commune": idn.get("commune"), "lat": idn.get("lat"), "lon": idn.get("lon"),
            "closing": co["closing"], "filed": (co.get("proof") or {}).get("filed"), "size": idn.get("size"), "created": (idn.get("created") or "")[:4],
            "revenue": c["revenue"], "ebitda": c["ebitda"], "margin": c["ebitda"] / c["revenue"],
            "growth": v["dcf"]["g0"], "net_debt": v["net_debt"], "ev_dcf": v["ev_dcf"], "ev_mult": v["ev_mult"],
            "ev": v["ev"], "equity": v["equity"], "ev_ebitda": (v["ev"] / c["ebitda"]) if v["ev"] and c["ebitda"] > 0 else None,
            "gap": v["gap"], "irr": v["lbo"]["irr"] if v["lbo"] else None, "wacc": v["wacc"]["wacc"],
            "_f": {"growth": v["dcf"]["g0"], "margin_vs_sector": None,
                   "cash_conversion": (y1["fcff"] / y1["ebitda"]) if y1["ebitda"] > 0 else None,
                   "low_leverage": -nd_e if nd_e is not None else None,
                   "lbo_irr": v["lbo"]["irr"] if v["lbo"] else None},
        }
        rows.append(row)
        by_div.setdefault(div, []).append(row)
        details.setdefault(siren[:3], {})[siren] = {"h": [[h["closing"]] + [k(h[f]) for f in DETAIL_FIELDS] for h in co["history"]],
                                                     "p": co.get("proof") or {}}
    sector_table = {}
    for div, rs in by_div.items():
        med = median([r["margin"] for r in rs])
        for r in rs:
            r["_f"]["margin_vs_sector"] = r["margin"] - med if med is not None else None
        industry = sec["divisions"][div]["industry"]
        s_in = M.sector_inputs(mkt, industry)
        sector_table[div] = {**sec["divisions"][div], "count": len(rs), "median_margin": r4(med),
                             "median_growth": r4(median([r["growth"] for r in rs])),
                             "median_ev_ebitda": r4(median([r["ev_ebitda"] for r in rs])),
                             "beta_u": s_in["beta_u"], "de": s_in["de"], "ev_ebitda": s_in["ev_ebitda"]}
    score(rows)
    rows.sort(key=lambda r: -(r["score"] or 0))
    cols = {
        "s": [r["siren"] for r in rows], "n": [r["name"] for r in rows], "naf": [r["naf"] for r in rows],
        "d": [r["div"] for r in rows], "ind": [r["industry"] for r in rows], "dep": [r["dep"] for r in rows],
        "c": [r["commune"] for r in rows], "la": [r["lat"] for r in rows], "lo": [r["lon"] for r in rows],
        "cl": [r["closing"] for r in rows], "fd": [r["filed"] for r in rows], "sz": [r["size"] for r in rows], "cr": [r["created"] for r in rows],
        "r": [k(r["revenue"]) for r in rows], "e": [k(r["ebitda"]) for r in rows], "m": [r4(r["margin"]) for r in rows],
        "g": [r4(r["growth"]) for r in rows], "nd": [k(r["net_debt"]) for r in rows],
        "evd": [k(r["ev_dcf"]) for r in rows], "evm": [k(r["ev_mult"]) for r in rows], "ev": [k(r["ev"]) for r in rows],
        "eq": [k(r["equity"]) for r in rows], "x": [r4(r["ev_ebitda"]) for r in rows], "gap": [r4(r["gap"]) for r in rows],
        "irr": [r4(r["irr"]) for r in rows], "w": [r4(r["wacc"]) for r in rows], "sc": [r["score"] for r in rows],
    }
    meta = {
        "sample": sample, "built_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "today": today.isoformat(), "cutoff": K.cutoff_date(today).isoformat(),
        "verification": stats.get("verification", "sample"),
        "inpi_coverage": ((stats.get("inpi_api") or {}).get("coverage")),
        "rule": {"months_until_next_accounts_due": K.MONTHS_UNTIL_NEXT_ACCOUNTS_DUE, "bilan_types": list(K.ACCEPTED_BILAN_TYPES),
                 "confidentiality": list(K.ACCEPTED_CONFIDENTIALITY), "min_revenue": K.MIN_REVENUE_EUR},
        "count": len(rows), "stats": stats,
        "market": {"rates": mkt["rates"], "erp": mkt["erp"], "ratings": mkt["ratings"],
                   "betas_source": {k2: mkt["betas"].get(k2) for k2 in ("source", "region", "date", "live")},
                   "multiples_source": {k2: mkt["multiples"].get(k2) for k2 in ("source", "region", "date", "live")},
                   "warnings": mkt["warnings"]},
        "defaults": V.defaults(), "model": {"default_growth": K.DEFAULT_GROWTH, "growth_floor": K.GROWTH_FLOOR, "growth_cap": K.GROWTH_CAP},
        "size_premium_bands": [[b if b != float("inf") else None, p] for b, p in K.SIZE_PREMIUM_BANDS],
        "score_weights": SCORE_WEIGHTS, "detail_fields": DETAIL_FIELDS, "detail_unit": 1000, "sectors": sector_table, "macros": sec["macros"], "size_labels": SIZE_LABELS,
    }
    log(f"[build] {len(rows)} companies in the universe")
    return meta, cols, details


def clean(o):
    """JSON for browsers: NaN/inf (pandas gaps) become null; JSON has no NaN."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k2: clean(v) for k2, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    return o


def write_site(meta, cols, details, log=print):
    out = K.SITE
    if out.exists():
        shutil.rmtree(out)
    (out / "data" / "co").mkdir(parents=True)
    for f in K.WEB.iterdir():
        if f.is_file():
            shutil.copy(f, out / f.name)
    shutil.copy(K.DATA / "departements.geojson", out / "data" / "departements.json")
    dump = lambda p, o: p.write_text(json.dumps(clean(o), ensure_ascii=False, separators=(",", ":"), allow_nan=False))  # noqa: E731
    dump(out / "data" / "meta.json", meta)
    dump(out / "data" / "universe.json", cols)
    for prefix, d in details.items():
        dump(out / "data" / "co" / f"{prefix}.json", d)
    (out / ".nojekyll").write_text("")
    log(f"[build] site written to {out}")


# ---------------- sample (fictional) data for local design work ----------------

def sample_data(n=1600, seed=7):
    rnd = random.Random(seed)
    geo = json.loads((K.DATA / "departements.geojson").read_text())
    deps = []
    for f in geo["features"]:
        pts = [p for poly in f["geometry"]["coordinates"] for p in poly[0]]
        lon = sum(p[0] for p in pts) / len(pts)
        lat = sum(p[1] for p in pts) / len(pts)
        deps.append((f["properties"]["code"], f["properties"]["nom"], lon, lat))
    weights = {"75": 9, "92": 6, "69": 5, "13": 4, "59": 4, "33": 3, "31": 3, "44": 3, "67": 2, "06": 2}
    pool = [d for d in deps for _ in range(weights.get(d[0], 1))]
    sec = sectors()
    divs = [d for d, v in sec["divisions"].items() if v["industry"]]
    dweights = {"62": 6, "46": 6, "43": 5, "28": 3, "10": 4, "71": 4, "25": 3, "49": 3, "47": 3, "70": 3, "56": 2, "86": 2, "52": 2}
    dpool = [d for d in divs for _ in range(dweights.get(d, 1))]
    companies, ids = {}, {}
    for i in range(n):
        siren = f"9{i:08d}"
        div = rnd.choice(dpool)
        dep = rnd.choice(pool)
        rev = math.exp(rnd.uniform(math.log(2.2e6), math.log(400e6)))
        margin = max(-0.15, min(0.45, rnd.gauss(0.10 if div != "62" else 0.16, 0.07)))
        growth = rnd.gauss(0.05, 0.08)
        hist = []
        r = rev / (1 + growth) ** 3
        for y in range(4):
            yr_rev = r * (1 + growth) ** y * rnd.uniform(0.97, 1.03)
            e = yr_rev * (margin + rnd.uniform(-0.02, 0.02))
            da = yr_rev * rnd.uniform(0.015, 0.05)
            debt = yr_rev * rnd.uniform(0, 0.35)
            cash = yr_rev * rnd.uniform(0.02, 0.2)
            hist.append({"closing": f"{2022 + y}-12-31", "revenue": yr_rev, "ebitda": e, "da": da, "ebit": e - da,
                         "interest": debt * 0.045, "income_tax": max(0, (e - da) * 0.25), "net_income": (e - da) * 0.7,
                         "equity": yr_rev * rnd.uniform(0.15, 0.5), "fin_debt": debt, "cash": cash,
                         "bfr": yr_rev * rnd.uniform(0.0, 0.25), "fixed_assets_net": yr_rev * rnd.uniform(0.05, 0.6),
                         "total_assets": yr_rev * rnd.uniform(0.6, 1.2), "wages": yr_rev * rnd.uniform(0.2, 0.45)})
        companies[siren] = {"closing": hist[-1]["closing"], "history": hist,
                            "proof": {"source": "sample", "closing": hist[-1]["closing"], "filed": "2026-06-30", "months": "12", "entry_code": "0",
                                      "checks": ["operating_income_sum", "operating_charges_sum", "operating_result", "balance_sheet", "net_income_bs_vs_pl"]}, "latest": {k2: v for k2, v in hist[-1].items() if k2 != "closing"}}
        code, nom, lon, lat = dep
        ids[siren] = {"name": f"Société fictive {i + 1:04d}", "naf": f"{div}.{rnd.randint(10, 99)}Z", "created": f"{rnd.randint(1960, 2019)}-01-01",
                      "size": rnd.choice(["12", "21", "22", "31", "32", "41"]), "dep": code, "commune": nom,
                      "lat": round(lat + rnd.gauss(0, 0.18), 4), "lon": round(lon + rnd.gauss(0, 0.25), 4)}
    return companies, ids


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", action="store_true")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--detail-parquet", default=K.DETAIL_PARQUET)
    a = ap.parse_args(argv)
    t0 = time.time()
    today = K.TODAY
    mkt = M.load(online=not a.offline)
    for w in mkt["warnings"]:
        print("[market] WARNING", w)
    sec = sectors()
    if a.sample:
        companies, ids = sample_data()
        stats = {"note": "données fictives"}
    else:
        from . import companies as C
        from . import inpi
        from . import sirene as S
        con = C.connect()
        filings = C.load_parquet(a.detail_parquet, today, con)
        client = inpi.Client.from_env()
        if client:
            api_stats = C.add_inpi(filings, client, today)   # any API failure stops the build: the last good site stays online
        else:
            print("[inpi] WARNING: INPI_USERNAME / INPI_PASSWORD not set: latest accounts limited to the open-data file")
            api_stats = None
        companies, stats = C.build_statements(filings, today, require_api=bool(client) and K.REQUIRE_INPI_API)
        stats["inpi_api"] = api_stats
        stats["verification"] = "inpi_api" if client else "open_data"
        if not companies:
            print("[build] ERROR: no company passed the filters; see the rejection counts above", file=sys.stderr)
            return 2
        ids = S.load(con, companies.keys())
    meta, cols, details = assemble(companies, ids, mkt, sec, today, stats, sample=a.sample)
    if meta["count"] == 0:
        print("[build] ERROR: empty universe", file=sys.stderr)
        return 2
    write_site(meta, cols, details)
    print(f"[build] done in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
