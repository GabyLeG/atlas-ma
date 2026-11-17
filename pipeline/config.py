"""Central settings for the Atlas pipeline. Every assumption the valuation relies on lives here,
with the reason it was chosen, so the team (and the jury) can find and challenge it in one place."""
import datetime as dt
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
WEB = ROOT / "web"
SITE = ROOT / "site"
CACHE = Path(os.environ.get("ATLAS_CACHE", ROOT / ".cache"))

# ---- Inclusion rule: an M&A buyer will ask for the latest accounts, so a company is shown only if
# the latest accounts that are legally due have been filed and are public, complete and consistent.
# French law: accounts approved within 6 months of closing, filed within 1 month of approval (2 if filed
# online). So the accounts of a year closing on date D are due by D + 8 months, and a company whose last
# closing is older than 12 + 8 = 20 months is missing accounts it should have filed.
MONTHS_UNTIL_NEXT_ACCOUNTS_DUE = 20
ACCEPTED_BILAN_TYPES = ("C",)          # C = régime réel normal (full liasse 2050-2053)
ACCEPTED_CONFIDENTIALITY = ("Public",)
MIN_REVENUE_EUR = 2_000_000            # M&A universe floor; smaller firms are rarely acquisition targets
CANDIDATE_MIN_REVENUE = 1_500_000      # lower bar on the previous year, to catch firms that grew past 2 M€
HISTORY_YEARS = 4                      # past closings kept for growth and charts
REQUIRE_INPI_API = True                # when INPI credentials are set, the latest accounts must come from the API

# ---- Valuation assumptions (all editable in the app; these are the defaults) ----
TAX_RATE = 0.25                        # French corporate income tax (IS), standard rate
TERMINAL_GROWTH = 0.02                 # long-run nominal growth, in line with the ECB inflation target
FORECAST_YEARS = 5
ILLIQUIDITY_DISCOUNT = 0.20            # discount applied to listed-peer multiples for a private company
# Size / illiquidity premium added to the cost of equity, by revenue band (EUR). Common practice for
# private SMEs; the figures are analyst assumptions shown and editable in the app, not market data.
SIZE_PREMIUM_BANDS = [(10e6, 0.04), (50e6, 0.03), (250e6, 0.02), (float("inf"), 0.01)]
GROWTH_FLOOR, GROWTH_CAP = -0.05, 0.20  # clamp on the historical revenue CAGR used as year-1 growth
DEFAULT_GROWTH = 0.03                   # used when only one year of history exists

# LBO screen
LBO_LEVERAGE = 4.0                     # senior debt / EBITDA at entry
LBO_MARGIN = 0.045                     # spread over Euribor 3M on acquisition debt
LBO_FEES = 0.03                        # transaction fees, % of entry EV
LBO_YEARS = 5

TODAY = dt.date.fromisoformat(os.environ["ATLAS_TODAY"]) if os.environ.get("ATLAS_TODAY") else dt.date.today()


def cutoff_date(today: dt.date | None = None) -> dt.date:
    """Oldest accepted closing date: today minus MONTHS_UNTIL_NEXT_ACCOUNTS_DUE (same day of month, clamped)."""
    t = today or TODAY
    m = t.month - MONTHS_UNTIL_NEXT_ACCOUNTS_DUE
    y = t.year + (m - 1) // 12
    m = (m - 1) % 12 + 1
    for d in (t.day, 28):
        try:
            return dt.date(y, m, d)
        except ValueError:
            continue
    raise ValueError


# ---- Public sources (all free; no key needed except where stated) ----
DETAIL_PARQUET = "https://www.data.gouv.fr/api/1/datasets/r/c4ac8f98-2c97-4417-9070-0cbb9de03875"  # Signaux Faibles, INPI liasses
SIRENE_DATASET = "https://www.data.gouv.fr/api/1/datasets/base-sirene-des-entreprises-et-de-leurs-etablissements-siren-siret/"
ECB = "https://data-api.ecb.europa.eu/service/data/{flow}/{key}?format=csvdata&lastNObservations=24"
ECB_SERIES = {
    "euribor3m": ("FM", "M.U2.EUR.RT.MM.EURIBOR3MD_.HSTA"),  # Euribor 3 months, monthly average
    "oat10": ("IRS", "M.FR.L.L40.CI.0000.EUR.N.Z"),          # French 10y benchmark yield (Banque de France), monthly
}
DAMODARAN = {
    "betas": "https://pages.stern.nyu.edu/~adamodar/pc/datasets/betaEurope.xls",
    "multiples": "https://pages.stern.nyu.edu/~adamodar/pc/datasets/vebitdaEurope.xls",
}
