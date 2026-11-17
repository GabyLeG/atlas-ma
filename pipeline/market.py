"""Market inputs refreshed on every build: Euribor 3M and the French 10-year OAT yield (ECB data
portal), betas and EV/EBITDA multiples by sector for Europe (Damodaran). If a source does not
answer, the last known value from data/fallback_market.json is used and flagged as such."""
import csv
import io
import json
import urllib.request

from . import config as K

UA = {"User-Agent": "atlas-ma/1.0 (student project; open data)"}


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def parse_ecb_csv(text):
    """Latest (date, value) from an ECB data portal CSV (columns TIME_PERIOD, OBS_VALUE). Values are in %."""
    rows = [r for r in csv.DictReader(io.StringIO(text)) if r.get("OBS_VALUE") not in (None, "", "NaN")]
    if not rows:
        raise ValueError("no observation")
    rows.sort(key=lambda r: r["TIME_PERIOD"])
    last = rows[-1]
    return last["TIME_PERIOD"], float(last["OBS_VALUE"]) / 100


def _norm(s):
    return "".join(ch for ch in str(s).lower() if ch.isalnum())


def parse_damodaran_table(content, wanted):
    """Read a Damodaran .xls: find the header row containing 'Industry Name', then pick columns whose
    normalised header starts with each wanted key. Returns {industry: {key: value}}.
    wanted: {out_name: header_prefix}. The first matching column wins (left block = positive-EBITDA firms)."""
    import pandas as pd
    sheets = pd.read_excel(io.BytesIO(content), sheet_name=None, header=None)
    for df in sheets.values():
        hdr_row = None
        for i in range(min(len(df), 40)):
            if any(_norm(v) == "industryname" for v in df.iloc[i].tolist()):
                hdr_row = i
                break
        if hdr_row is None:
            continue
        hdr = [_norm(v) for v in df.iloc[hdr_row].tolist()]
        cols = {}
        for out, prefix in wanted.items():
            p = _norm(prefix)
            for j, h in enumerate(hdr):
                if h == p or (h.startswith(p) and out not in cols):
                    cols[out] = j
                    if h == p:
                        break
        if len(cols) < len(wanted):
            continue
        name_col = hdr.index("industryname")
        out = {}
        for i in range(hdr_row + 1, len(df)):
            name = df.iat[i, name_col]
            if not isinstance(name, str) or not name.strip():
                continue
            rec = {}
            for k, j in cols.items():
                v = df.iat[i, j]
                try:
                    rec[k] = float(v)
                except (TypeError, ValueError):
                    rec[k] = None
            out[name.strip()] = rec
        if out:
            return out
    raise ValueError("table not found")


def load(online=True):
    fb = json.loads((K.DATA / "fallback_market.json").read_text())
    res = {"rates": {}, "erp": fb["erp"], "ratings": fb["ratings"], "warnings": []}
    for name, (flow, key) in K.ECB_SERIES.items():
        try:
            if not online:
                raise RuntimeError("offline")
            date, v = parse_ecb_csv(fetch(K.ECB.format(flow=flow, key=key)).decode("utf-8"))
            res["rates"][name] = {"value": v, "date": date, "source": f"BCE, série {flow}.{key}", "live": True}
        except Exception as e:  # noqa: BLE001 - any failure falls back, and is reported
            res["rates"][name] = dict(fb["rates"][name], live=False)
            res["warnings"].append(f"{name}: valeur de repli ({e})")
    for name, wanted in (("betas", {"beta": "Beta", "de": "D/E Ratio", "beta_u": "Unlevered beta", "beta_u_cash": "Unlevered beta corrected for cash"}),
                         ("multiples", {"ev_ebitda": "EV/EBITDA"})):
        try:
            if not online:
                raise RuntimeError("offline")
            table = parse_damodaran_table(fetch(K.DAMODARAN[name]), wanted)
            res[name] = {"source": f"Damodaran, {K.DAMODARAN[name].rsplit('/', 1)[-1]} (Europe)", "region": "Europe",
                         "by_industry": table, "live": True}
        except Exception as e:  # noqa: BLE001
            res[name] = dict(fb[name], live=False)
            res["warnings"].append(f"{name}: table de repli {fb[name]['region']} ({e})")
    return res


def sector_inputs(mkt, industry):
    b = mkt["betas"]["by_industry"].get(industry) or {}
    mlt = mkt["multiples"]["by_industry"].get(industry) or {}
    beta_u = b.get("beta_u_cash") or b.get("beta_u") or 1.0
    de = b.get("de")
    return {"industry": industry, "beta_u": beta_u, "de": de if de is not None else 0.3,
            "ev_ebitda": mlt.get("ev_ebitda")}
