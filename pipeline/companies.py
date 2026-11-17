"""Which companies make it into Atlas, and from which filing their numbers come.

1. Candidates: every company whose last public full-regime filing in the open-data parquet
   ("Données financières détaillées des entreprises", data.gouv, INPI liasses) shows revenue above
   CANDIDATE_MIN_REVENUE. The parquet also gives the older years used for growth.
2. Latest accounts: the official INPI API, queried for those candidates (pipeline/inpi.py). It is
   updated daily, so this year's filings are there, with their filing date and INPI quality code.
3. Inclusion (an M&A buyer will ask for the latest accounts, so we only show a company if we have them):
   - the latest accounts that are legally due must be filed: last closing on or after cutoff_date();
   - the latest filing is public, full regime, 12 months, in euros, keyed in by INPI without anomaly;
   - the numbers pass the accounting checks of liasse.py;
   - revenue of at least MIN_REVENUE_EUR.
"""
import datetime as dt

from . import config as K
from .liasse import all_codes, derive, usable


def connect():
    import duckdb
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    return con


def _map_get(con):
    """map access returning a scalar, across DuckDB versions."""
    try:
        v = con.execute("SELECT map_extract_value(MAP {'a': 1}, 'a')").fetchone()[0]
        if v == 1:
            return "map_extract_value({m}, '{k}')"
    except Exception:  # noqa: BLE001
        pass
    return "map_extract({m}, '{k}')[1]"


def describe(con, src):
    return con.execute(f"DESCRIBE SELECT * FROM read_parquet('{src}')").fetchall()


def load_parquet(src=K.DETAIL_PARQUET, today=None, con=None, log=print):
    """{siren: [(closing, liasse, meta), ...]} for candidate companies (open-data history)."""
    con = con or connect()
    today = today or K.TODAY
    oldest = dt.date(today.year - K.HISTORY_YEARS - 1, today.month, 1)
    cols = {name: typ for name, typ, *_ in describe(con, src)}
    log(f"[parquet] schema: {cols}")
    missing = {"siren", "date_cloture_exercice", "type_bilan", "liasse"} - set(cols)
    if missing:
        raise RuntimeError(f"Colonnes absentes du parquet: {missing}. Schéma reçu: {cols}")
    conf = "confidentiality" if "confidentiality" in cols else None
    types = ",".join(f"'{t}'" for t in K.ACCEPTED_BILAN_TYPES)
    confs = ",".join(f"'{c}'" for c in K.ACCEPTED_CONFIDENTIALITY)
    where = [f"type_bilan IN ({types})", f"CAST(date_cloture_exercice AS DATE) BETWEEN DATE '{oldest}' AND DATE '{today}'"]
    if conf:
        where.append(f"{conf} IN ({confs})")
    get = _map_get(con)
    codes = all_codes()
    codes_sql = ", ".join(f'{get.format(m="f.liasse", k=c)} AS "c_{c}"' for c in codes)
    rev = get.format(m="ll", k="FL")
    try:
        hist = con.execute(f"""SELECT strftime(CAST(date_cloture_exercice AS DATE), '%Y-%m') m, count(*) n
            FROM read_parquet('{src}') WHERE {' AND '.join(where)}
              AND CAST(date_cloture_exercice AS DATE) >= DATE '{dt.date(today.year - 2, today.month, 1)}'
            GROUP BY 1 ORDER BY 1""").fetchall()
        log("[parquet] dépôts par mois de clôture (fraîcheur de la source open data): " + ", ".join(f"{m}:{n}" for m, n in hist))
    except Exception as e:  # noqa: BLE001
        log(f"[parquet] diagnostic de fraîcheur impossible ({e})")
    sql = f"""
      WITH f AS (SELECT siren, CAST(date_cloture_exercice AS DATE) AS d, liasse
                 FROM read_parquet('{src}') WHERE {' AND '.join(where)}),
      latest AS (SELECT siren, arg_max(liasse, d) AS ll FROM f GROUP BY siren),
      keep AS (SELECT siren FROM latest WHERE coalesce({rev}, 0) >= {K.CANDIDATE_MIN_REVENUE})
      SELECT f.siren, f.d, {codes_sql} FROM f JOIN keep USING (siren) ORDER BY f.siren, f.d
    """
    import pandas as pd
    df = con.execute(sql).df()
    out = {}
    for row in df.itertuples(index=False):
        l = {code: float(v) for code, v in zip(codes, row[2:]) if not pd.isna(v)}
        d = row[1].date() if hasattr(row[1], "hour") else row[1]
        out.setdefault(str(row[0]).zfill(9), []).append((d, l, {"source": "open_data"}))
    log(f"[parquet] {len(out)} candidates (last public full-regime revenue ≥ {K.CANDIDATE_MIN_REVENUE:,.0f} €)")
    return out


def _load_cache(path):
    import gzip
    import json
    try:
        with gzip.open(path, "rt") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_cache(path, cache):
    import gzip
    import json
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt") as f:
        json.dump(cache, f, separators=(",", ":"))
    tmp.replace(path)


def add_inpi(filings, client, today=None, log=print, cache_path=None):
    """Merge the INPI API filings into `filings`, through a cache kept between runs (GitHub Actions cache).

    The INPI quota is 10,000 calls or 10,000 MB per day, and a full download is ~10 GB. So:
    - backfill: every candidate is fetched once since `window_from`; if the quota runs out the run stops
      cleanly and the next night resumes where it stopped;
    - afterwards, each night only fetches what changed since the last complete pass (a few MB).
    """
    from . import inpi
    from .liasse import all_codes
    today = today or K.TODAY
    cache_path = cache_path or (K.CACHE / "inpi.json.gz")
    cache = _load_cache(cache_path)
    codes = set(all_codes())
    window_from = cache.get("window_from") or K.cutoff_date(today).isoformat()
    cache.setdefault("window_from", window_from)
    recs = cache.setdefault("records", {})          # siren -> {closing: compact record}
    done = set(cache.get("done", []))
    cands = sorted(filings)
    todo = [s for s in cands if s not in done]
    stats = {"records": 0, "used": 0, "problems": {}, "entry_codes": {}, "backfill_todo": len(todo)}

    def take(batch, items):
        for rec in items:
            stats["records"] += 1
            c = inpi.compact(rec, codes)
            idn = c["ident"]
            if not idn["closing"] or idn["type"] != "C":
                continue
            by = recs.setdefault(idn["siren"], {})
            old = by.get(idn["closing"][:10])
            if old is None or old["ident"]["updated"] <= idn["updated"]:
                by[idn["closing"][:10]] = c

    try:
        if todo:
            log(f"[inpi] backfill: {len(todo)} companies not yet fetched since {window_from}")
            cache.setdefault("backfill_started", today.isoformat())
            for batch, items in client.batches(todo, window_from):
                take(batch, items)
                done.update(batch)
            if not client.quota_hit and not [s for s in cands if s not in done]:
                cache["updated_until"] = cache.pop("backfill_started", today.isoformat())
        elif cache.get("updated_until"):
            since = (dt.date.fromisoformat(cache["updated_until"]) - dt.timedelta(days=3)).isoformat()
            log(f"[inpi] incremental: changes since {since}")
            n = 0
            for batch, items in client.batches(cands, since):
                take(batch, items)
                n += 1
            if not client.quota_hit:
                cache["updated_until"] = today.isoformat()
    finally:
        cache["done"] = sorted(done)
        _save_cache(cache_path, cache)
    for siren in cands:
        for closing, c in (recs.get(siren) or {}).items():
            idn = c["ident"]
            ec = idn["entry_code"] or "(absent)"
            stats["entry_codes"][ec] = stats["entry_codes"].get(ec, 0) + 1
            probs = inpi.reliability(idn)
            for p in probs:
                stats["problems"][p] = stats["problems"].get(p, 0) + 1
            d = dt.date.fromisoformat(closing)
            meta = {"source": "inpi_api", "filed": idn["filed"], "inpi_id": idn["id"], "entry_code": inpi.norm_code(idn["entry_code"]),
                    "months": idn["months"], "problems": probs}
            rows = [r for r in filings[siren] if r[0] != d]     # the API version replaces the open-data one
            rows.append((d, c["l"], meta))
            filings[siren] = sorted(rows, key=lambda r: r[0])
            stats["used"] += 1
    stats["calls"] = client.calls
    stats["checked"] = sum(1 for s in cands if s in done)
    stats["coverage"] = stats["checked"] / len(cands) if cands else 1.0
    stats["quota_hit"] = bool(getattr(client, "quota_hit", False))
    log(f"[inpi] {stats['records']} new records this run, {stats['used']} filings merged, {client.calls} calls; "
        f"companies checked {stats['checked']}/{len(cands)}; problems: {stats['problems']}")
    log(f"[inpi] INPI entry codes (codeSaisie): {stats['entry_codes']}")
    return stats


def build_statements(filings, today=None, require_api=False, log=print):
    """Apply the inclusion rule. Returns ({siren: {"closing", "history", "latest", "proof"}}, stats)."""
    today = today or K.TODAY
    cutoff = K.cutoff_date(today)
    stats = {"candidates": len(filings), "kept": 0, "cutoff": cutoff.isoformat(), "rejected": {}, "check_failures": {}}
    rej = stats["rejected"]
    out = {}
    for siren, rows in filings.items():
        hist = []
        for d, l, meta in rows:
            s = derive(l)
            for c in s.checks_failed:
                stats["check_failures"][c] = stats["check_failures"].get(c, 0) + 1
            hist.append((d, s, meta))
        d_last, s_last, m_last = hist[-1]
        reason = None
        if d_last < cutoff:
            reason = "latest_accounts_missing"        # newer accounts are legally due but not filed (or not yet keyed in)
        elif require_api and m_last["source"] != "inpi_api":
            reason = "not_verified_by_inpi_api"
        elif m_last.get("problems"):
            reason = m_last["problems"][0]
        elif not usable(s_last):
            reason = "accounting_checks"
        elif s_last.revenue < K.MIN_REVENUE_EUR:
            reason = "below_revenue_floor"
        if reason:
            rej[reason] = rej.get(reason, 0) + 1
            continue
        clean = [(d, s, m) for d, s, m in hist if usable(s) and not m.get("problems")]
        proof = {"source": m_last["source"], "closing": d_last.isoformat(), "filed": m_last.get("filed"),
                 "inpi_id": m_last.get("inpi_id"), "entry_code": m_last.get("entry_code"), "months": m_last.get("months"),
                 "checks": ["operating_income_sum", "operating_charges_sum", "operating_result", "balance_sheet", "net_income_bs_vs_pl"]}
        out[siren] = {"closing": d_last.isoformat(), "proof": proof,
                      "history": [{"closing": d.isoformat(), **s.to_dict()} for d, s, _ in clean],
                      "latest": s_last.to_dict()}
    stats["kept"] = len(out)
    log(f"[select] cutoff {cutoff}: kept {stats['kept']} / {stats['candidates']}; rejected: {rej}")
    log(f"[select] accounting check failures over all filings: {stats['check_failures']}")
    return out, stats
