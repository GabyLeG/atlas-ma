"""Select companies with up-to-date, complete public accounts and rebuild their statements.

Source: "Données financières détaillées des entreprises" (Signaux Faibles, data.gouv), a parquet file
of every INPI filing with the raw liasse as a map {code: amount}. Read with DuckDB over HTTP, so
only the needed columns travel.
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


def load_filings(src=K.DETAIL_PARQUET, today=None, con=None, log=print):
    """Return {siren: [ (closing_date, liasse_dict), ...oldest→latest ]} for companies whose latest
    accepted filing closed after the cutoff. src may be a URL or a local parquet path."""
    con = con or connect()
    today = today or K.TODAY
    cutoff = K.cutoff_date(today)
    oldest = dt.date(cutoff.year - K.HISTORY_YEARS, cutoff.month, 1)
    cols = {name: typ for name, typ, *_ in describe(con, src)}
    log(f"[filings] schema: {cols}")
    need = {"siren", "date_cloture_exercice", "type_bilan", "liasse"}
    missing = need - set(cols)
    if missing:
        raise RuntimeError(f"Colonnes absentes du parquet: {missing}. Schéma reçu: {cols}")
    conf = "confidentiality" if "confidentiality" in cols else None
    types = ",".join(f"'{t}'" for t in K.ACCEPTED_BILAN_TYPES)
    confs = ",".join(f"'{c}'" for c in K.ACCEPTED_CONFIDENTIALITY)
    where = [f"type_bilan IN ({types})",
             f"CAST(date_cloture_exercice AS DATE) BETWEEN DATE '{oldest}' AND DATE '{today}'"]
    if conf:
        where.append(f"{conf} IN ({confs})")
    get = _map_get(con)
    rev = get.format(m="liasse", k="FL")
    codes = all_codes()
    codes_sql = ", ".join(f'{get.format(m="f.liasse", k=c)} AS "c_{c}"' for c in codes)
    sql = f"""
      WITH f AS (
        SELECT siren, CAST(date_cloture_exercice AS DATE) AS d, liasse
        FROM read_parquet('{src}') WHERE {' AND '.join(where)}
      ),
      latest AS (SELECT siren, max(d) AS dl, arg_max(liasse, d) AS ll FROM f GROUP BY siren),
      keep AS (SELECT siren FROM latest
               WHERE dl >= DATE '{cutoff}' AND coalesce({rev.replace('liasse', 'll')}, 0) >= {K.MIN_REVENUE_EUR})
      SELECT f.siren, f.d, {codes_sql}
      FROM f JOIN keep USING (siren)
      ORDER BY f.siren, f.d
    """
    log(f"[filings] cutoff {cutoff}, history from {oldest}")
    import pandas as pd
    df = con.execute(sql).df()
    out = {}
    names = list(codes)
    for row in df.itertuples(index=False):
        l = {}
        for code, v in zip(names, row[2:]):
            if not pd.isna(v):                    # NULL: the line is blank in the filing
                l[code] = float(v)
        d = row[1].date() if hasattr(row[1], "hour") else row[1]
        out.setdefault(str(row[0]).zfill(9), []).append((d, l))
    log(f"[filings] {len(out)} companies with a closing on or after {cutoff} and revenue ≥ {K.MIN_REVENUE_EUR:,} €")
    return out


def build_statements(filings, log=print):
    """Derive statements, keep companies whose latest filing passes the accounting checks.
    Returns ({siren: {"history": [...], "latest": {...}}}, stats)."""
    stats = {"companies_in": len(filings), "kept": 0, "rejected_latest": 0, "check_failures": {}}
    out = {}
    for siren, rows in filings.items():
        hist = []
        seen = set()
        for d, l in rows:
            if d in seen:
                continue
            seen.add(d)
            s = derive(l)
            for c in s.checks_failed:
                stats["check_failures"][c] = stats["check_failures"].get(c, 0) + 1
            hist.append((d, s))
        d_last, s_last = hist[-1]
        if not usable(s_last):
            stats["rejected_latest"] += 1
            continue
        clean = [(d, s) for d, s in hist if usable(s)]
        out[siren] = {"closing": d_last.isoformat(),
                      "history": [{"closing": d.isoformat(), **s.to_dict()} for d, s in clean],
                      "latest": s_last.to_dict()}
    stats["kept"] = len(out)
    log(f"[filings] kept {stats['kept']} / {stats['companies_in']} (latest filing failing checks: {stats['rejected_latest']})")
    log(f"[filings] check failures over all filings: {stats['check_failures']}")
    return out, stats
