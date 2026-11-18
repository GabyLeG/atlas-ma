"""Official INPI API (Registre national des entreprises): the latest annual accounts, as keyed in by INPI.

Why: the open-data parquet on data.gouv lags about a year behind. The API is updated daily, so the
accounts filed this year are available, with the filing date and INPI's own quality code for each.

Credentials come from the environment (GitHub secrets INPI_USERNAME / INPI_PASSWORD), never from the code.
Quota: 10,000 calls per day. Sirens are queried 100 at a time, so a nightly refresh uses ~1-2k calls.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://registre-national-entreprises.inpi.fr"
UA = "atlas-ma/1.0 (student project; open data)"

# Assets (page 1): each line has a gross code; INPI puts gross in m1 and depreciation in m2.
# liasse.py expects the depreciation under its own code, as in the paper form.
AMORT = {"AB": "AC", "CX": "CQ", "AF": "AG", "AH": "AI", "AJ": "AK", "AL": "AM", "AN": "AO", "AP": "AQ", "AR": "AS",
         "AT": "AU", "AV": "AW", "AX": "AY", "CS": "CU", "CV": "CW", "BB": "BC", "BD": "BE", "BF": "BG", "BH": "BI",
         "BJ": "BK", "BL": "BM", "BN": "BO", "BP": "BQ", "BR": "BS", "BT": "BU", "BV": "BW", "BX": "BY", "BZ": "CA",
         "CB": "CC", "CD": "CE", "CF": "CG", "CH": "CI", "CJ": "CK", "CO": "1A"}
# Income statement lines split France / export / total: INPI keys the line by its first code.
TRIPLES = {"FA": ("FA", "FB", "FC"), "FD": ("FD", "FE", "FF"), "FG": ("FG", "FH", "FI"), "FJ": ("FJ", "FK", "FL")}


def amount(s):
    s = (s or "").strip()
    if not s:
        return None
    try:
        return float(int(s))
    except ValueError:
        try:
            return float(s.replace(",", "."))
        except ValueError:
            return None


def to_liasse(record):
    """INPI 'bilan saisi' JSON -> {code: euros}, in the paper-form convention used by liasse.py."""
    out = {}
    detail = (((record.get("bilanSaisi") or {}).get("bilan") or {}).get("detail") or {})
    for page in detail.get("pages") or []:
        for l in page.get("liasses") or []:
            code = (l.get("code") or "").strip()
            m1, m2, m3 = amount(l.get("m1")), amount(l.get("m2")), amount(l.get("m3"))
            if not code:
                continue
            if code in TRIPLES:
                for c, v in zip(TRIPLES[code], (m1, m2, m3)):
                    if v is not None:
                        out[c] = v
            elif code[0] in "ABC" or code == "1A":            # assets: gross / depreciation / net
                if m1 is not None:
                    out[code] = m1
                if code in AMORT and m2 is not None:
                    out[AMORT[code]] = m2
            elif code[0] in "FG":                               # income statement: total N is m3
                v = m3 if m3 is not None else m1
                if v is not None:
                    out[code] = v
            else:                                               # liabilities, 2053: year N is m1
                if m1 is not None:
                    out[code] = m1
    return out


def norm_code(c):
    """INPI codes come zero-padded ('00', '01', '13'); keep '1A' style codes as they are."""
    c = str(c or "").strip().upper()
    return str(int(c)) if c.isdigit() else c


# Figures of the previous year printed in this filing, used to cross-check it against last year's own filing.
# Income statement: total N-1 is m4 (lines split France/export are keyed by their first code, FJ for revenue).
# Liabilities and the 2053 page: N-1 is m2.
PREV = {"revenue": ("FJ", "m4", "FL"), "net_income": ("HN", "m2", None), "equity": ("DL", "m2", None), "total": ("EE", "m2", None)}


def previous_year(record):
    """{revenue, net_income, equity, total} for year N-1 as shown in this filing (None when blank)."""
    out = {k: None for k in PREV}
    detail = (((record.get("bilanSaisi") or {}).get("bilan") or {}).get("detail") or {})
    for page in detail.get("pages") or []:
        for l in page.get("liasses") or []:
            code = (l.get("code") or "").strip()
            for k, (c, col, alt) in PREV.items():
                if code == c or (alt and code == alt and out[k] is None):
                    v = amount(l.get(col))
                    if v is not None:
                        out[k] = v
    return out


def identity(record):
    ident = ((((record.get("bilanSaisi") or {}).get("bilan") or {}).get("identite")) or {})
    return {
        "siren": str(record.get("siren") or ident.get("siren") or "").zfill(9),
        "closing": record.get("dateCloture") or ident.get("dateClotureExercice"),
        "filed": record.get("dateDepot") or ident.get("dateDepot"),
        "type": record.get("typeBilan") or ident.get("codeTypeBilan"),
        "confidentiality": record.get("confidentiality"),
        "confidentiality_code": norm_code(ident.get("codeConfidentialite")),
        "entry_code": norm_code(ident.get("codeSaisie") or record.get("codeSaisie") or (record.get("bilanSaisi") or {}).get("codeSaisie")),
        "months": str(ident.get("dureeExerciceN", "")).strip().lstrip("0"),
        "currency": (ident.get("codeDevise") or "EUR").strip(),
        "deleted": bool(record.get("deleted")),
        "id": (record.get("id") or "").strip(),
        "updated": record.get("updatedAt") or "",
    }


def reliability(ident):
    """Reasons a filing cannot be trusted as-is. Empty list = reliable."""
    r = []
    if ident["deleted"]:
        r.append("deleted")
    if ident["type"] != "C":
        r.append("not_full_regime")
    if (ident["confidentiality"] and ident["confidentiality"] != "Public") or norm_code(ident["confidentiality_code"]) not in ("", "0"):
        r.append("confidential")
    code = norm_code(ident["entry_code"])           # also normalises codes cached before this fix
    if code in ("1", "1A") or (code.isdigit() and 2 <= int(code) <= 24):
        r.append("inpi_entry_anomaly")          # INPI flagged inconsistencies (1), missing data (1A) or did not key in the accounts (2-24)
    if ident["months"] not in ("12",):
        r.append("not_12_months")
    if ident["currency"] != "EUR":
        r.append("not_eur")
    return r


class QuotaReached(RuntimeError):
    """INPI daily quota (10,000 calls or 10,000 MB) used up: stop for today, resume tomorrow."""


def compact(record, codes):
    """What the pipeline keeps from a filing: identity fields and the liasse codes it reads (a few hundred bytes)."""
    l = to_liasse(record)
    return {"ident": identity(record), "l": {c: v for c, v in l.items() if c in codes}, "p": previous_year(record)}


class Client:
    def __init__(self, username, password, log=print, pause=0.05):
        import threading
        self.u, self.p, self.log, self.pause = username, password, log, pause
        self.token, self.calls, self._lock = None, 0, threading.Lock()

    @classmethod
    def from_env(cls, log=print):
        u, p = os.environ.get("INPI_USERNAME"), os.environ.get("INPI_PASSWORD")
        return cls(u, p, log) if u and p else None

    def login(self):
        body = json.dumps({"username": self.u, "password": self.p}).encode()
        req = urllib.request.Request(BASE + "/api/sso/login", data=body, method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            self.token = json.loads(r.read())["token"]
        self.calls += 1

    def get(self, path, params):
        url = BASE + path + "?" + urllib.parse.urlencode(params, doseq=True)
        for attempt in range(4):
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token}", "User-Agent": UA, "Accept": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=90) as r:
                    with self._lock:
                        self.calls += 1
                    time.sleep(self.pause)
                    return json.loads(r.read() or b"[]"), r.headers.get("pagination-search-after")
            except urllib.error.HTTPError as e:
                with self._lock:
                    self.calls += 1
                if e.code == 401 and attempt == 0:
                    with self._lock:
                        self.login()
                    continue
                if e.code == 429:
                    raise QuotaReached("INPI quota reached (10,000 calls or 10,000 MB per day)") from e
                if e.code >= 500 and attempt < 3:
                    time.sleep(3 * (attempt + 1))
                    continue
                raise
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt < 3:
                    time.sleep(3 * (attempt + 1))
                    continue
                raise RuntimeError(f"INPI unreachable: {e}") from e
        raise RuntimeError("INPI: no answer")

    def _batch(self, batch, date_from, max_calls):
        out, after = [], None
        while True:
            if self.calls >= max_calls:
                return out, True
            params = {"siren[]": batch, "dateFrom": date_from, "pageSize": 100}
            if after:
                params["searchAfter"] = after
            data, nxt = self.get("/api/bilans-saisis", params)
            items = data if isinstance(data, list) else (data.get("items") or data.get("results") or [])
            out.extend(items)
            if not nxt or len(items) < 100 or nxt == after:
                return out, False
            after = nxt

    def batches(self, sirens, date_from, max_calls=8000, workers=4):
        """Yield (batch_of_sirens, filings) for every batch of 100 sirens, for filings created or modified since
        date_from. Stops cleanly (QuotaReached is swallowed, self.quota_hit set) when the daily quota is used up."""
        from concurrent.futures import ThreadPoolExecutor, as_completed
        self.quota_hit = False
        if not self.token:
            try:
                self.login()
            except urllib.error.HTTPError as e:
                if e.code != 429:
                    raise
                self.quota_hit = True
                self.log("[inpi] daily quota already used up: nothing fetched this run")
                return
        sirens = list(sirens)
        batches = [sirens[i:i + 100] for i in range(0, len(sirens), 100)]
        t0, done = time.time(), 0
        ex = ThreadPoolExecutor(max_workers=workers)
        try:
            futs = {ex.submit(self._batch, b, date_from, max_calls): b for b in batches}
            for f in as_completed(futs):
                try:
                    items, capped = f.result()
                except QuotaReached:
                    self.quota_hit = True
                    self.log(f"[inpi] daily quota reached after {self.calls} calls: the rest resumes on the next run")
                    break
                done += 1
                if not capped:
                    yield futs[f], items
                if done % 100 == 0 or done == len(batches):
                    self.log(f"[inpi] {done}/{len(batches)} batches, {self.calls} calls, {time.time() - t0:.0f}s")
                if capped:
                    self.quota_hit = True
                    self.log(f"[inpi] stopping at {self.calls} calls to stay under the daily quota")
                    break
        finally:
            ex.shutdown(wait=False, cancel_futures=True)
