"""Turn a French tax return (liasse fiscale, régime réel normal, CERFA 2050 to 2053) into clean
financial statements, and reject any filing whose numbers do not add up.

Each liasse line has a two-letter code. Assets (2050) carry a gross code and a depreciation code;
net = gross - depreciation. Liabilities (2051) and the income statement (2052, 2053) carry one code
per line. The codes used are listed in CODES so they can be checked against the official forms.
"""
from dataclasses import dataclass, asdict, field

CODES = {
    # 2052 - income statement (operating)
    "revenue": "FL",                 # chiffre d'affaires net
    "production_stored": "FM", "production_capitalised": "FN", "operating_subsidies": "FO",
    "reversals": "FP", "other_income": "FQ", "total_operating_income": "FR",
    "purchases_goods": "FS", "stock_change_goods": "FT", "purchases_materials": "FU", "stock_change_materials": "FV",
    "external_charges": "FW", "taxes": "FX", "wages": "FY", "social_charges": "FZ",
    "depreciation": "GA", "provisions_fixed": "GB", "provisions_current": "GC", "provisions_risks": "GD",
    "other_charges": "GE", "total_operating_charges": "GF", "operating_result": "GG",
    # 2052 - financial
    "interest_paid": "GR", "financial_result": "GV",
    # 2053
    "income_tax": "HK", "net_income": "HN",
    # 2051 - liabilities
    "equity": "DL", "net_income_bs": "DI",
    "bonds_convertible": "DS", "bonds_other": "DT", "bank_debt": "DU", "other_fin_debt": "DV",
    "trade_payables": "DX", "tax_social_payables": "DY", "total_liabilities": "EE",
    # 2050 - assets (gross, depreciation)
    "fixed_assets": ("BJ", "BK"),
    "stock_materials": ("BL", "BM"), "wip_goods": ("BN", "BO"), "wip_services": ("BP", "BQ"),
    "stock_products": ("BR", "BS"), "stock_goods": ("BT", "BU"),
    "receivables": ("BX", "BY"), "securities": ("CD", "CE"), "cash": ("CF", "CG"),
    "total_assets": ("CO", "1A"),
}

def all_codes():
    """Every liasse code read by derive() and checks(): the pipeline extracts only these."""
    out = []
    for v in CODES.values():
        out.extend(v if isinstance(v, tuple) else (v,))
    return sorted(set(out))


# Where each published figure comes from, shown next to the figure in the app (forms 2050 to 2053).
SOURCES = {
    "revenue": {"label": "Revenue", "form": "2052", "formula": "FL"},
    "ebitda": {"label": "EBITDA (EBE)", "form": "2052", "formula": "FL + FM + FN + FO − (FS + FT + FU + FV + FW + FX + FY + FZ)"},
    "da": {"label": "Depreciation", "form": "2052", "formula": "GA"},
    "ebit": {"label": "Operating profit (EBIT)", "form": "2052", "formula": "GG"},
    "interest": {"label": "Interest paid", "form": "2052", "formula": "GR"},
    "income_tax": {"label": "Income tax", "form": "2053", "formula": "HK"},
    "net_income": {"label": "Net income", "form": "2053", "formula": "HN"},
    "equity": {"label": "Shareholders' equity", "form": "2051", "formula": "DL"},
    "fin_debt": {"label": "Financial debt", "form": "2051", "formula": "DS + DT + DU + DV"},
    "cash": {"label": "Cash and securities", "form": "2050", "formula": "(CD − CE) + (CF − CG)"},
    "bfr": {"label": "Operating working capital", "form": "2050 / 2051",
            "formula": "net stocks (BL…BU) + net receivables (BX − BY) − trade payables (DX) − tax and social payables (DY)"},
    "fixed_assets_net": {"label": "Net fixed assets", "form": "2050", "formula": "BJ − BK"},
    "total_assets": {"label": "Balance-sheet total", "form": "2051", "formula": "EE"},
    "wages": {"label": "Wages and social charges", "form": "2052", "formula": "FY + FZ"},
}

TOL_ABS = 2_000      # EUR: rounding in filings
TOL_REL = 0.01


@dataclass
class Statement:
    revenue: float
    ebitda: float
    da: float
    ebit: float
    interest: float
    income_tax: float
    net_income: float
    equity: float
    fin_debt: float
    cash: float
    bfr: float
    fixed_assets_net: float
    total_assets: float
    wages: float
    checks_failed: list = field(default_factory=list)

    def to_dict(self):
        d = asdict(self)
        d.pop("checks_failed")
        return d


def _v(l, code):
    x = l.get(code)
    return 0.0 if x is None else float(x)


def _net(l, pair):
    return _v(l, pair[0]) - _v(l, pair[1])


def _close(a, b):
    return abs(a - b) <= max(TOL_ABS, TOL_REL * max(abs(a), abs(b)))


def derive(l: dict) -> Statement:
    """l maps liasse codes to euro amounts. Missing codes count as 0 (blank lines are omitted in filings)."""
    C = CODES
    rev = _v(l, C["revenue"])
    ebitda = (rev + _v(l, "FM") + _v(l, "FN") + _v(l, "FO")
              - (_v(l, "FS") + _v(l, "FT") + _v(l, "FU") + _v(l, "FV") + _v(l, "FW") + _v(l, "FX") + _v(l, "FY") + _v(l, "FZ")))
    da = _v(l, "GA")
    ebit = _v(l, "GG")
    stocks = sum(_net(l, C[k]) for k in ("stock_materials", "wip_goods", "wip_services", "stock_products", "stock_goods"))
    bfr = stocks + _net(l, C["receivables"]) - _v(l, "DX") - _v(l, "DY")
    s = Statement(
        revenue=rev, ebitda=ebitda, da=da, ebit=ebit, interest=_v(l, "GR"), income_tax=_v(l, "HK"),
        net_income=_v(l, "HN") if "HN" in l else _v(l, "DI"), equity=_v(l, "DL"),
        fin_debt=_v(l, "DS") + _v(l, "DT") + _v(l, "DU") + _v(l, "DV"),
        cash=_net(l, C["securities"]) + _net(l, C["cash"]), bfr=bfr,
        fixed_assets_net=_net(l, C["fixed_assets"]), total_assets=_v(l, "EE"), wages=_v(l, "FY") + _v(l, "FZ"),
    )
    s.checks_failed = checks(l)
    return s


def checks(l: dict) -> list:
    """Accounting identities a correct filing must satisfy. Returns the names of failed checks.
    If the code mapping were wrong, these would fail on most filings, which the build report shows."""
    f = []
    if "FL" not in l:
        f.append("revenue_missing")
    if "FR" in l:
        parts = sum(_v(l, c) for c in ("FL", "FM", "FN", "FO", "FP", "FQ"))
        if not _close(parts, _v(l, "FR")):
            f.append("operating_income_sum")
    if "GF" in l:
        parts = sum(_v(l, c) for c in ("FS", "FT", "FU", "FV", "FW", "FX", "FY", "FZ", "GA", "GB", "GC", "GD", "GE"))
        if not _close(parts, _v(l, "GF")):
            f.append("operating_charges_sum")
    if "FR" in l and "GF" in l and "GG" in l and not _close(_v(l, "FR") - _v(l, "GF"), _v(l, "GG")):
        f.append("operating_result")
    if "HN" in l and "DI" in l and not _close(_v(l, "HN"), _v(l, "DI")):
        f.append("net_income_bs_vs_pl")
    if "EE" in l and "CO" in l and not _close(_net(l, CODES["total_assets"]), _v(l, "EE")):
        f.append("balance_sheet")
    return f


CRITICAL = {"revenue_missing", "operating_result", "balance_sheet", "operating_charges_sum"}


def usable(s: Statement) -> bool:
    return s.revenue > 0 and not (set(s.checks_failed) & CRITICAL)
