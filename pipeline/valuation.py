"""Valuation engine: WACC, 5-year DCF, sector EV/EBITDA multiple, quick LBO test.

This file is the reference. web/valuation.js is a line-by-line port so the app can recompute
live when the user moves a slider; tests/test_parity.py checks both give the same numbers.
"""
import math
from . import config as K


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def size_premium(revenue):
    for limit, prem in K.SIZE_PREMIUM_BANDS:
        if revenue < limit:
            return prem
    return K.SIZE_PREMIUM_BANDS[-1][1]


def synthetic_rating(ebit, interest, ratings):
    """Rating and default spread from the interest coverage ratio (Damodaran, small-firm thresholds)."""
    cov = math.inf if interest <= 0 else ebit / interest
    for lo, hi, r in ratings["small_firm_thresholds"]:
        if lo < cov <= hi or (cov == math.inf and hi >= 1e8):
            return r, ratings["spreads"][r], cov
    return "D", ratings["spreads"]["D"], cov


def growth0(revenues):
    """Year-1 growth = historical revenue CAGR, clamped. revenues: oldest to latest."""
    r = [x for x in revenues if x and x > 0]
    if len(r) < 2:
        return K.DEFAULT_GROWTH
    n = len(r) - 1
    return clamp((r[-1] / r[0]) ** (1 / n) - 1, K.GROWTH_FLOOR, K.GROWTH_CAP)


def avg_margin(revenues, ebitdas):
    pairs = [(r, e) for r, e in zip(revenues, ebitdas) if r and r > 0][-3:]
    if not pairs:
        return 0.0
    return clamp(sum(e / r for r, e in pairs) / len(pairs), -0.5, 0.8)


def defaults():
    return {
        "tax": K.TAX_RATE, "g_terminal": K.TERMINAL_GROWTH, "years": K.FORECAST_YEARS,
        "illiquidity": K.ILLIQUIDITY_DISCOUNT, "lbo_leverage": K.LBO_LEVERAGE, "lbo_margin": K.LBO_MARGIN,
        "lbo_fees": K.LBO_FEES, "lbo_years": K.LBO_YEARS,
    }


def wacc(c, m, s, p):
    """c: latest statement dict, m: market {rf, euribor, erp, ratings}, s: sector {beta_u, de, ev_ebitda}."""
    t = p["tax"]
    de = p.get("de", s["de"])
    beta_u = p.get("beta_u", s["beta_u"])
    beta_l = beta_u * (1 + (1 - t) * de)
    sp = p.get("size_premium", size_premium(c["revenue"]))
    ke = p.get("rf", m["rf"]) + beta_l * p.get("erp", m["erp"]) + sp
    rating, spread, cov = synthetic_rating(c["ebit"], c["interest"], m["ratings"])
    spread = p.get("spread", spread)
    kd = p.get("euribor", m["euribor"]) + spread
    wd = de / (1 + de)
    we = 1 - wd
    w = we * ke + wd * kd * (1 - t) + p.get("wacc_shift", 0.0)
    return {"rf": p.get("rf", m["rf"]), "erp": p.get("erp", m["erp"]), "euribor": p.get("euribor", m["euribor"]),
            "beta_u": beta_u, "de": de, "beta_l": beta_l, "size_premium": sp, "ke": ke,
            "rating": rating, "coverage": None if cov == math.inf else cov, "spread": spread, "kd": kd,
            "we": we, "wd": wd, "wacc": w}


def dcf(c, hist, w, p):
    t, gT, N = p["tax"], p["g_terminal"], int(p["years"])
    W = w["wacc"]
    gT = min(gT, W - 0.005)
    R0 = c["revenue"]
    g0 = p.get("g0", growth0(hist["revenue"]))
    m = p.get("margin", avg_margin(hist["revenue"], hist["ebitda"]))
    d = clamp(c["da"] / R0, 0, 0.3)
    k = clamp(c["fixed_assets_net"] / R0, 0, 3)
    b = clamp(c["bfr"] / R0, -0.3, 0.6)
    rows, prev, pv = [], R0, 0.0
    for i in range(1, N + 1):
        g = g0 + (gT - g0) * (i - 1) / (N - 1) if N > 1 else gT
        R = prev * (1 + g)
        E = m * R
        DA = d * R
        EBIT = E - DA
        tax = max(0.0, EBIT) * t
        nopat = EBIT - tax
        dR = R - prev
        capex = DA + k * dR
        dbfr = b * dR
        fcff = nopat + DA - capex - dbfr
        df = (1 + W) ** -i
        pv += fcff * df
        rows.append({"year": i, "growth": g, "revenue": R, "ebitda": E, "da": DA, "ebit": EBIT, "tax": tax, "nopat": nopat,
                     "capex": capex, "dbfr": dbfr, "fcff": fcff, "df": df, "pv": fcff * df})
        prev = R
    last = rows[-1]
    if last["nopat"] > 0:
        nopat_next = last["nopat"] * (1 + gT)
        fcff_next = nopat_next * (1 - gT / W)
        tv = fcff_next / (W - gT)
    else:
        tv = 0.0
    pv_tv = tv * last["df"]
    ev = pv + pv_tv
    return {"g0": g0, "margin": m, "da_pct": d, "capital_intensity": k, "bfr_pct": b, "g_terminal": gT,
            "rows": rows, "pv_fcff": pv, "tv": tv, "pv_tv": pv_tv, "ev": ev,
            "tv_share": (pv_tv / ev) if ev > 0 else None}


def multiple_value(c, s, p):
    mult = p.get("ev_ebitda", s.get("ev_ebitda"))
    if mult is None or c["ebitda"] <= 0:
        return {"multiple": mult, "applied": None, "ev": None}
    applied = mult * (1 - p["illiquidity"])
    return {"multiple": mult, "applied": applied, "ev": c["ebitda"] * applied}


def lbo(c, rows, entry_ev, w, p):
    E0 = c["ebitda"]
    if entry_ev is None or entry_ev <= 0 or E0 <= 0:
        return None
    uses = entry_ev * (1 + p["lbo_fees"])
    debt = min(p["lbo_leverage"] * E0, 0.7 * uses)
    equity0 = uses - debt
    rate = w["euribor"] + p["lbo_margin"]
    cash = 0.0
    path = []
    n = min(int(p["lbo_years"]), len(rows))
    for r in rows[:n]:
        interest = debt * rate
        avail = r["fcff"] - interest * (1 - p["tax"])
        if avail >= 0:
            repay = min(debt, avail)
            debt -= repay
            cash += avail - repay
        else:
            debt -= avail
        path.append({"year": r["year"], "interest": interest, "debt": debt, "cash": cash})
    exit_ev = rows[n - 1]["ebitda"] * (entry_ev / E0)
    exit_eq = exit_ev - debt + cash
    irr = (exit_eq / equity0) ** (1 / n) - 1 if exit_eq > 0 else -1.0
    return {"entry_ev": entry_ev, "debt0": min(p["lbo_leverage"] * E0, 0.7 * uses), "equity0": equity0, "rate": rate,
            "path": path, "exit_ev": exit_ev, "exit_equity": exit_eq, "moic": exit_eq / equity0, "irr": irr}


def value(c, hist, m, s, params=None):
    p = defaults()
    p.update(params or {})
    w = wacc(c, m, s, p)
    d = dcf(c, hist, w, p)
    mv = multiple_value(c, s, p)
    net_debt = c["fin_debt"] - c["cash"]
    evs = [x for x in (d["ev"] if d["ev"] > 0 else None, mv["ev"]) if x is not None]
    ev = sum(evs) / len(evs) if evs else None
    lb = lbo(c, d["rows"], mv["ev"], w, p)
    return {
        "params": p, "wacc": w, "dcf": d, "multiple": mv, "net_debt": net_debt,
        "ev_dcf": d["ev"], "ev_mult": mv["ev"], "ev": ev,
        "equity_dcf": d["ev"] - net_debt, "equity_mult": None if mv["ev"] is None else mv["ev"] - net_debt,
        "equity": None if ev is None else ev - net_debt,
        "ev_ebitda_dcf": d["ev"] / c["ebitda"] if c["ebitda"] > 0 else None,
        "gap": (d["ev"] / mv["ev"] - 1) if mv["ev"] and mv["ev"] > 0 else None,
        "lbo": lb,
    }
