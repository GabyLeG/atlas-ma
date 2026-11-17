"""Python (reference) and JS (in-browser) valuation must agree on every output number."""
import json
import math
import shutil
import subprocess

import pytest

from pipeline import config as K
from pipeline import valuation as V
from pipeline.liasse import derive
from tests.test_pipeline import LIASSE, MARKET, SECTOR

CFG = {"defaults": V.defaults(), "default_growth": K.DEFAULT_GROWTH, "growth_floor": K.GROWTH_FLOOR,
       "growth_cap": K.GROWTH_CAP, "size_premium_bands": [[None if b == float("inf") else b, p] for b, p in K.SIZE_PREMIUM_BANDS]}


def cases():
    base = derive(LIASSE).to_dict()
    h = {"revenue": [9e6, 9.5e6, 1e7], "ebitda": [9e5, 1e6, 1.1e6]}
    out = [
        (base, h, {}),
        (dict(base, revenue=3e8, ebitda=4e7, ebit=3e7, interest=9e6), {"revenue": [2e8, 3e8], "ebitda": [3e7, 4e7]}, {}),
        (dict(base, ebitda=-2e5, ebit=-5e5), h, {}),
        (dict(base, interest=0), {"revenue": [1e7], "ebitda": [1.1e6]}, {"rf": 0.03, "g_terminal": 0.025, "ev_ebitda": 7.5}),
        (base, h, {"g0": 0.12, "margin": 0.2, "illiquidity": 0.3, "beta_u": 1.4, "de": 0.6, "size_premium": 0.05, "years": 7}),
        (dict(base, bfr=-3e6, fixed_assets_net=4e7), h, {"spread": 0.03, "euribor": 0.04}),
        (base, h, {"wacc_shift": 0.01}),
    ]
    return out


def walk(a, b, path=""):
    if isinstance(a, dict):
        for k in a:
            walk(a[k], b.get(k), f"{path}.{k}")
    elif isinstance(a, list):
        assert len(a) == len(b), path
        for i, (x, y) in enumerate(zip(a, b)):
            walk(x, y, f"{path}[{i}]")
    elif isinstance(a, float):
        if math.isinf(a):
            return
        assert b is not None and math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-6), f"{path}: py={a} js={b}"
    else:
        assert a == b, f"{path}: py={a} js={b}"


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_js_matches_python():
    cs = cases()
    payload = [{"c": c, "hist": h, "m": MARKET, "s": SECTOR, "params": p, "cfg": CFG} for c, h, p in cs]
    js = json.loads(subprocess.run(["node", "tests/parity_runner.js"], input=json.dumps(payload), capture_output=True,
                                   text=True, check=True, cwd=K.ROOT).stdout)
    for (c, h, p), j in zip(cs, js):
        py = V.value(c, h, MARKET, SECTOR, p)
        py = json.loads(json.dumps(py, default=lambda x: None))  # inf -> handled; mirrors JSON transport
        walk(py, j)
