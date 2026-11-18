"""INPI API format (documentation technique API comptes annuels v5): amounts are 15-digit strings,
assets carry gross (m1) / depreciation (m2) / net (m3), the income statement total N is m3,
liabilities and the 2053 page use m1 for year N."""
from pipeline import inpi
from pipeline.liasse import derive
from tests.test_pipeline import LIASSE


def z(v):
    return ("-" if v < 0 else "") + str(abs(int(v))).zfill(15)


def record(liasse=LIASSE, prev=None, **ident):
    """prev: last year's {FL, HN, DL, EE} as printed in this filing's N-1 column."""
    l = liasse
    pv = prev or {}
    assets = [("BJ", "BK"), ("BL", "BM"), ("BN", "BO"), ("BP", "BQ"), ("BR", "BS"), ("BT", "BU"), ("BX", "BY"), ("CD", "CE"), ("CF", "CG"), ("CO", "1A")]
    p1 = [{"code": g, "m1": z(l.get(g, 0)), "m2": z(l.get(a, 0)), "m3": z(l.get(g, 0) - l.get(a, 0)), "m4": ""} for g, a in assets if g in l]
    p2 = [{"code": c, "m1": z(v), "m2": z(pv[c]) if c in pv else "", "m3": "", "m4": ""} for c, v in l.items() if c[0] in "DE"]
    p3 = [{"code": "FJ", "m1": z(l["FL"] - 1_000_000), "m2": z(1_000_000), "m3": z(l["FL"]), "m4": z(pv["FL"]) if "FL" in pv else ""}]
    p3 += [{"code": c, "m1": "", "m2": "", "m3": z(v), "m4": ""} for c, v in l.items() if c[0] in "FG" and c != "FL"]
    p4 = [{"code": c, "m1": z(v), "m2": z(pv[c]) if c in pv else "", "m3": "", "m4": ""} for c, v in l.items() if c[0] == "H"]
    idn = {"siren": "123456789", "dateClotureExercice": "2025-12-31", "dureeExerciceN": "12", "codeSaisie": "0",
           "codeConfidentialite": "0", "codeDevise": "EUR", "codeTypeBilan": "C", "dateDepot": "2026-06-30"}
    idn.update(ident)
    return {"siren": "123456789", "dateDepot": idn["dateDepot"], "confidentiality": "Public", "deleted": False, "id": "abc",
            "updatedAt": "2026-07-01T10:00:00+02:00", "dateCloture": idn["dateClotureExercice"], "typeBilan": idn["codeTypeBilan"],
            "bilanSaisi": {"bilan": {"identite": idn, "detail": {"pages": [{"numero": 1, "liasses": p1}, {"numero": 2, "liasses": p2},
                                                                            {"numero": 3, "liasses": p3}, {"numero": 4, "liasses": p4}]}}}}


def test_amount_format():
    assert inpi.amount("000000000001220") == 1220
    assert inpi.amount("-000000001127414") == -1127414
    assert inpi.amount("") is None


def test_inpi_record_gives_same_statement_as_paper_form():
    l = inpi.to_liasse(record())
    assert l["FJ"] == 9_000_000 and l["FK"] == 1_000_000 and l["FL"] == 10_000_000
    assert l["BK"] == 1_500_000 and l["CG"] == 0 and l["1A"] == 1_000_000
    assert derive(l).to_dict() == derive(LIASSE).to_dict()
    assert derive(l).checks_failed == []


def test_reliability_rules():
    ok = inpi.identity(record())
    assert ok["filed"] == "2026-06-30" and inpi.reliability(ok) == []
    assert inpi.reliability(inpi.identity(record(codeSaisie="1"))) == ["inpi_entry_anomaly"]
    assert inpi.reliability(inpi.identity(record(codeSaisie="1A"))) == ["inpi_entry_anomaly"]
    assert inpi.reliability(inpi.identity(record(codeSaisie="12"))) == ["inpi_entry_anomaly"]   # not keyed in
    assert inpi.reliability(inpi.identity(record(codeSaisie=""))) == []                        # field absent: rely on the accounting checks
    # real API values are zero-padded (seen in the first live run): '00' ok, '01' inconsistencies, '13' not keyed in
    assert inpi.identity(record(codeSaisie="00"))["entry_code"] == "0" and inpi.reliability(inpi.identity(record(codeSaisie="00"))) == []
    assert inpi.reliability(inpi.identity(record(codeSaisie="01"))) == ["inpi_entry_anomaly"]
    assert inpi.reliability(inpi.identity(record(codeSaisie="13"))) == ["inpi_entry_anomaly"]
    assert inpi.reliability(inpi.identity(record(dureeExerciceN="18"))) == ["not_12_months"]
    assert "confidential" in inpi.reliability(inpi.identity(record(codeConfidentialite="2")))
    assert "not_full_regime" in inpi.reliability(inpi.identity(record(codeTypeBilan="S")))


LAST_YEAR = dict(LIASSE, FL=9_000_000, FR=9_100_000, FS=1_000_000, GF=8_320_000, HN=400_000, DI=400_000, DL=2_600_000)


def run(*recs):
    import datetime as dt, tempfile, pathlib
    from pipeline.companies import add_inpi, build_statements

    class Fake:
        calls, quota_hit = 3, False
        def batches(self, sirens, date_from):
            yield list(sirens), list(recs)
    f = {"123456789": [(dt.date(2023, 12, 31), LAST_YEAR, {"source": "open_data"})]}
    cache = pathlib.Path(tempfile.mkdtemp()) / "inpi.json.gz"
    st = add_inpi(f, Fake(), dt.date(2026, 11, 17), log=lambda *_: None, cache_path=cache)
    out, sel = build_statements(f, dt.date(2026, 11, 17), require_api=True, log=lambda *_: None)
    return st, out, sel["rejected"]


MATCH = {"FL": 9_000_000, "HN": 400_000, "DL": 2_600_000, "EE": 7_000_000}


def test_previous_year_read_from_filing():
    assert inpi.previous_year(record(prev=MATCH)) == {"revenue": 9e6, "net_income": 4e5, "equity": 2.6e6, "total": 7e6}


def test_two_verified_years_that_confirm_each_other_are_kept():
    st, out, rej = run(record(prev=MATCH), record(LAST_YEAR, dateClotureExercice="2024-12-31", dateDepot="2025-06-30"))
    co = out["123456789"]
    assert co["proof"]["prev_closing"] == "2024-12-31" and co["proof"]["filed"] == "2026-06-30"
    assert [h["closing"] for h in co["history"]] == ["2024-12-31", "2025-12-31"]   # open-data 2023 left out: only verified years


def test_years_that_disagree_are_rejected():
    _, out, rej = run(record(prev=dict(MATCH, FL=9_500_000)), record(LAST_YEAR, dateClotureExercice="2024-12-31"))
    assert out == {} and rej == {"years_do_not_match": 1}


def test_previous_year_must_be_verified_too():
    _, out, rej = run(record(prev=MATCH), record(LAST_YEAR, dateClotureExercice="2024-12-31", codeSaisie="1A"))
    assert out == {} and rej == {"previous_year_inpi_entry_anomaly": 1}
    _, out, rej = run(record(prev=MATCH))                       # 2024 only in open data
    assert out == {} and rej == {"previous_year_not_consecutive": 1}


def test_cache_resumes_after_quota(tmp_path):
    import datetime as dt
    from pipeline.companies import add_inpi
    cache = tmp_path / "inpi.json.gz"
    today = dt.date(2026, 11, 17)

    class Quota:
        calls, quota_hit = 1, False
        def batches(self, sirens, date_from):
            yield ["123456789"], [record()]
            self.quota_hit = True                     # second batch never answered

    class Full:
        calls, quota_hit = 1, False
        def __init__(self):
            self.asked = []
        def batches(self, sirens, date_from):
            self.asked.append((list(sirens), date_from))
            yield list(sirens), []

    f = {"123456789": [], "987654321": []}
    st = add_inpi(dict(f), Quota(), today, log=lambda *_: None, cache_path=cache)
    assert st["checked"] == 1 and st["quota_hit"]
    full = Full()
    st2 = add_inpi(dict(f), full, today, log=lambda *_: None, cache_path=cache)
    # window = two years of filings: 1st of the month one year before the cutoff (17 Mar 2025 -> 1 Mar 2024)
    assert full.asked == [(["987654321"], "2024-03-01")]     # only the company not yet fetched
    assert st2["checked"] == 2 and st2["used"] == 1           # the first company's filing came from the cache
    full2 = Full()
    add_inpi(dict(f), full2, dt.date(2026, 11, 18), log=lambda *_: None, cache_path=cache)
    assert full2.asked == [(["123456789", "987654321"], "2026-11-14")]   # incremental, 3 days back
