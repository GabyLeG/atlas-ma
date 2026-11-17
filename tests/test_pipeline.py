import datetime as dt
import math

import pytest

from pipeline import config as K
from pipeline import valuation as V
from pipeline.liasse import derive, usable, checks
from pipeline.build import percentile_ranks, classify, sectors
from pipeline.market import parse_ecb_csv, sector_inputs

# A consistent régime-normal filing (euros). Income statement: FR = FL+FM+...; GF = sum of charges; GG = FR-GF.
LIASSE = {
    "FL": 10_000_000, "FM": 0, "FN": 0, "FO": 50_000, "FP": 20_000, "FQ": 30_000, "FR": 10_100_000,
    "FS": 2_000_000, "FT": 0, "FU": 1_000_000, "FV": 0, "FW": 2_500_000, "FX": 150_000, "FY": 2_400_000, "FZ": 900_000,
    "GA": 300_000, "GB": 0, "GC": 50_000, "GD": 0, "GE": 20_000, "GF": 9_320_000, "GG": 780_000,
    "GR": 60_000, "HK": 150_000, "HN": 500_000, "DI": 500_000, "DL": 3_000_000,
    "DU": 1_200_000, "DV": 300_000, "DX": 900_000, "DY": 700_000, "EE": 7_000_000,
    "BJ": 4_000_000, "BK": 1_500_000, "BT": 800_000, "BU": 0, "BX": 1_600_000, "BY": 100_000,
    "CF": 1_000_000, "CG": 0, "CD": 200_000, "CE": 0, "CO": 8_000_000, "1A": 1_000_000,
}


def test_derive_hand_checked():
    s = derive(LIASSE)
    assert s.revenue == 10_000_000
    # EBITDA = CA + subsidies - purchases - external - taxes - wages - social = 10.05M - 8.95M
    assert s.ebitda == 1_100_000
    assert s.ebit == 780_000 and s.da == 300_000
    assert s.fin_debt == 1_500_000 and s.cash == 1_200_000
    # BFR = stocks 0.8M + receivables 1.5M - suppliers 0.9M - tax/social 0.7M
    assert s.bfr == 700_000
    assert s.fixed_assets_net == 2_500_000
    assert s.checks_failed == [] and usable(s)


def test_checks_catch_inconsistent_filing():
    bad = dict(LIASSE, GG=900_000)
    assert "operating_result" in checks(bad)
    assert not usable(derive(bad))
    assert "balance_sheet" in checks(dict(LIASSE, EE=9_000_000))
    assert "revenue_missing" in checks({k: v for k, v in LIASSE.items() if k != "FL"})


def test_cutoff_is_18_months():
    assert K.cutoff_date(dt.date(2026, 11, 17)) == dt.date(2025, 5, 17)
    assert K.cutoff_date(dt.date(2026, 8, 31)) == dt.date(2025, 2, 28)


def test_ecb_csv():
    txt = "KEY,TIME_PERIOD,OBS_VALUE\nX,2026-09,3.10\nX,2026-10,3.25\n"
    assert parse_ecb_csv(txt) == ("2026-10", pytest.approx(0.0325))


def test_classify_excludes_holdings_and_finance():
    sec = sectors()
    assert classify("62.01Z", sec)[2] == "Software (System & Application)"
    assert classify("43.21A", sec)[2] == "Engineering/Construction"
    assert classify("70.10Z", sec)[2] is None
    assert classify("64.19Z", sec)[2] is None


def test_percentiles():
    assert percentile_ranks([3, None, 1, 2]) == [1.0, None, 0.0, 0.5]


MARKET = {"rf": 0.04, "euribor": 0.025, "erp": 0.05,
          "ratings": {"spreads": {"AAA": 0.004, "AA": 0.0055, "A+": 0.007, "A": 0.0078, "A-": 0.0089, "BBB": 0.0111,
                                  "BB+": 0.0138, "BB": 0.0184, "B+": 0.0275, "B": 0.0321, "B-": 0.0509, "CCC": 0.0885,
                                  "CC": 0.1261, "C": 0.16, "D": 0.19},
                      "small_firm_thresholds": [[-1e9, 0.5, "D"], [0.5, 0.8, "C"], [0.8, 1.25, "CC"], [1.25, 1.5, "CCC"],
                                                [1.5, 2.0, "B-"], [2.0, 2.5, "B"], [2.5, 3.0, "B+"], [3.0, 3.5, "BB"],
                                                [3.5, 4.0, "BB+"], [4.0, 4.5, "BBB"], [4.5, 6.0, "A-"], [6.0, 7.5, "A"],
                                                [7.5, 9.5, "A+"], [9.5, 12.5, "AA"], [12.5, 1e9, "AAA"]]}}
SECTOR = {"beta_u": 1.0, "de": 0.25, "ev_ebitda": 10.0}


def company():
    s = derive(LIASSE).to_dict()
    return s, {"revenue": [9_000_000, 9_500_000, 10_000_000], "ebitda": [900_000, 1_000_000, 1_100_000]}


def test_wacc_hand_checked():
    c, _ = company()
    w = V.wacc(c, MARKET, SECTOR, V.defaults())
    # beta_l = 1 * (1 + 0.75*0.25) = 1.1875 ; size premium (revenue 10M -> band <50M) = 3%
    assert w["beta_l"] == pytest.approx(1.1875)
    assert w["size_premium"] == 0.03
    assert w["ke"] == pytest.approx(0.04 + 1.1875 * 0.05 + 0.03)
    # coverage 780k/60k = 13 -> AAA small-firm band -> 0.40%
    assert w["rating"] == "AAA" and w["kd"] == pytest.approx(0.029)
    assert w["wacc"] == pytest.approx(0.8 * 0.129375 + 0.2 * 0.029 * 0.75)


def test_dcf_and_multiple():
    c, h = company()
    v = V.value(c, h, MARKET, SECTOR)
    d = v["dcf"]
    assert d["g0"] == pytest.approx((10 / 9) ** 0.5 - 1)
    assert d["margin"] == pytest.approx((0.1 + 1 / 9.5 + 0.11) / 3)
    r1 = d["rows"][0]
    assert r1["revenue"] == pytest.approx(10_000_000 * (1 + d["g0"]))
    # FCFF = NOPAT + DA - capex - dBFR, capex = DA + intensity * dR
    dR = r1["revenue"] - 10_000_000
    assert r1["fcff"] == pytest.approx(r1["nopat"] - 0.25 * dR - 0.07 * dR)
    assert d["rows"][-1]["growth"] == pytest.approx(0.02)
    assert v["ev_mult"] == pytest.approx(1_100_000 * 10 * 0.8)
    assert v["ev"] == pytest.approx((v["ev_dcf"] + v["ev_mult"]) / 2)
    assert v["equity"] == pytest.approx(v["ev"] - 300_000)
    assert 0.03 < v["wacc"]["wacc"] < 0.2 and v["ev_dcf"] > 0


def test_lbo_consistency():
    c, h = company()
    v = V.value(c, h, MARKET, SECTOR)
    lb = v["lbo"]
    assert lb["debt0"] == pytest.approx(min(4 * 1_100_000, 0.7 * lb["entry_ev"] * 1.03))
    assert lb["equity0"] == pytest.approx(lb["entry_ev"] * 1.03 - lb["debt0"])
    assert lb["moic"] == pytest.approx(lb["exit_equity"] / lb["equity0"])
    assert (1 + lb["irr"]) ** 5 == pytest.approx(lb["moic"])


def test_negative_ebitda_has_no_multiple_or_lbo():
    c, h = company()
    c = dict(c, ebitda=-100_000, ebit=-400_000)
    v = V.value(c, h, MARKET, SECTOR)
    assert v["ev_mult"] is None and v["lbo"] is None


def test_sector_inputs_fallback():
    from pipeline import market
    m = market.load(online=False)
    s = sector_inputs(m, "Machinery")
    assert s["beta_u"] == 1.33 and s["de"] == pytest.approx(0.1356) and s["ev_ebitda"] == 16.22


def test_load_filings_sql(tmp_path):
    """Run the real SQL on a small local parquet with the same schema as the data.gouv file."""
    duckdb = pytest.importorskip("duckdb")
    p = tmp_path / "f.parquet"
    con = duckdb.connect()
    con.execute("CREATE TABLE t (siren VARCHAR, date_cloture_exercice DATE, type_bilan VARCHAR, confidentiality VARCHAR, liasse MAP(VARCHAR, INTEGER))")
    rows = [
        ("111111111", "2024-12-31", "C", "Public", {"FL": 9_000_000}),
        ("111111111", "2025-12-31", "C", "Public", {"FL": 10_000_000}),    # recent, big -> kept with history
        ("222222222", "2024-12-31", "C", "Public", {"FL": 50_000_000}),    # too old (before cutoff) -> out
        ("333333333", "2025-12-31", "C", "Partiellement confidentiel", {"FL": 5_000_000}),  # confidential -> out
        ("444444444", "2025-12-31", "S", "Public", {"FL": 5_000_000}),     # simplified regime -> out
        ("555555555", "2025-12-31", "C", "Public", {"FL": 1_000_000}),     # below revenue floor -> out
    ]
    for s, d, tb, cf, l in rows:
        con.execute("INSERT INTO t VALUES (?, ?, ?, ?, MAP(?, ?))", [s, d, tb, cf, list(l.keys()), list(l.values())])
    con.execute(f"COPY t TO '{p}' (FORMAT parquet)")
    from pipeline.companies import load_filings
    out = load_filings(str(p), dt.date(2026, 11, 17), con=duckdb.connect(), log=lambda *_: None)
    assert list(out) == ["111111111"]
    assert [d.isoformat() for d, _ in out["111111111"]] == ["2024-12-31", "2025-12-31"]
    assert out["111111111"][-1][1]["FL"] == 10_000_000


def test_sirene_join_and_privacy(tmp_path, monkeypatch):
    duckdb = pytest.importorskip("duckdb")
    pytest.importorskip("pyproj")
    from pipeline import sirene
    monkeypatch.setattr(sirene, "commune_centres", lambda log=print: {"69123": (4.835, 45.758)})
    con = duckdb.connect()
    ul, et = tmp_path / "ul.parquet", tmp_path / "et.parquet"
    con.execute(f"""COPY (SELECT * FROM (VALUES
        ('111111111','SOCIETE A',NULL,'62.01Z','2001-03-01','21','PME','5710','00012','A','O'),
        ('222222222','SOCIETE B',NULL,'43.21A','1990-01-01','12','PME','5499','00020','A','O'),
        ('333333333','NOM PRENOM',NULL,'62.01Z','2010-01-01','00','PME','1000','00010','A','O'),
        ('444444444','SOCIETE D',NULL,'62.01Z','2010-01-01','00','PME','5710','00010','A','P'),
        ('555555555','SOCIETE E',NULL,'62.01Z','2010-01-01','00','PME','5710','00010','C','O'))
      t(siren, denominationUniteLegale, sigleUniteLegale, activitePrincipaleUniteLegale, dateCreationUniteLegale,
        trancheEffectifsUniteLegale, categorieEntreprise, categorieJuridiqueUniteLegale, nicSiegeUniteLegale,
        etatAdministratifUniteLegale, statutDiffusionUniteLegale)) TO '{ul}' (FORMAT parquet)""")
    con.execute(f"""COPY (SELECT * FROM (VALUES
        ('11111111100012','75108','PARIS 8','75008', 650000.0, 6863000.0),
        ('22222222200020','69123','LYON','69001', NULL, NULL))
      t(siret, codeCommuneEtablissement, libelleCommuneEtablissement, codePostalEtablissement,
        coordonneeLambertAbscisseEtablissement, coordonneeLambertOrdonneeEtablissement)) TO '{et}' (FORMAT parquet)""")
    out = sirene.load(duckdb.connect(), ["111111111", "222222222", "333333333", "444444444", "555555555"], str(ul), str(et), log=lambda *_: None)
    assert set(out) == {"111111111", "222222222"}           # sole trader, partial diffusion and closed company dropped
    a = out["111111111"]
    assert a["dep"] == "75" and 48.8 < a["lat"] < 48.9 and 2.2 < a["lon"] < 2.4   # Lambert 93 → WGS84, Paris 8e
    assert out["222222222"]["lat"] == 45.758                # no coordinates → commune centre
