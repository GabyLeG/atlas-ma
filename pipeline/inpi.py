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


def identity(record):
    ident = ((((record.get("bilanSaisi") or {}).get("bilan") or {}).get("identite")) or {})
    return {
        "siren": str(record.get("siren") or ident.get("siren") or "").zfill(9),
        "closing": record.get("dateCloture") or ident.get("dateClotureExercice"),
        "filed": record.get("dateDepot") or ident.get("dateDepot"),
        "type": record.get("typeBilan") or ident.get("codeTypeBilan"),
        "confidentiality": record.get("confidentiality"),
        "confidentiality_code": str(ident.get("codeConfidentialite", "")).strip(),
        "entry_code": str(ident.get("codeSaisie", "")).strip(),
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
    if (ident["confidentiality"] and ident["confidentiality"] != "Public") or ident["confidentiality_code"] not in ("", "0"):
        r.append("confidential")
    if ident["entry_code"] not in ("0",):
        r.append("inpi_entry_anomaly")          # INPI flags inconsistencies or missing data (codeSaisie 1, 1A, ...)
    if ident["months"] not in ("12",):
        r.append("not_12_months")
    if ident["currency"] != "EUR":
        r.append("not_eur")
    return r


class Client:
    def __init__(self, username, password, log=print, pause=0.15):
        self.u, self.p, self.log, self.pause = username, password, log, pause
        self.token, self.calls = None, 0

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
        if not self.token:
            self.login()
        url = BASE + path + "?" + urllib.parse.urlencode(params, doseq=True)
        for attempt in range(4):
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token}", "User-Agent": UA, "Accept": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    self.calls += 1
                    time.sleep(self.pause)
                    return json.loads(r.read() or b"[]"), r.headers.get("pagination-search-after")
            except urllib.error.HTTPError as e:
                self.calls += 1
                if e.code == 401 and attempt == 0:
                    self.login()
                    continue
                if e.code == 429:
                    raise RuntimeError("INPI quota reached (10,000 calls or 10,000 MB per day)") from e
                if e.code >= 500 and attempt < 3:
                    time.sleep(3 * (attempt + 1))
                    continue
                raise
        raise RuntimeError("INPI: no answer")

    def bilans_saisis(self, sirens, date_from, max_calls=8000):
        """Yield every keyed-in filing created or modified since date_from, for the given sirens."""
        sirens = list(sirens)
        for i in range(0, len(sirens), 100):
            batch = sirens[i:i + 100]
            after = None
            while True:
                if self.calls >= max_calls:
                    self.log(f"[inpi] stopping at {self.calls} calls to stay under the daily quota")
                    return
                params = {"siren[]": batch, "dateFrom": date_from, "pageSize": 100}
                if after:
                    params["searchAfter"] = after
                data, nxt = self.get("/api/bilans-saisis", params)
                items = data if isinstance(data, list) else (data.get("items") or data.get("results") or [])
                yield from items
                if not nxt or len(items) < 100 or nxt == after:
                    break
                after = nxt
            if (i // 100) % 50 == 0:
                self.log(f"[inpi] {i + len(batch)}/{len(sirens)} sirens, {self.calls} calls")
