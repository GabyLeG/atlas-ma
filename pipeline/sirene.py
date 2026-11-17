"""Identity, sector and location of each company from the INSEE SIRENE stock files (parquet on data.gouv).

Privacy: only legal entities (sociétés) are kept, never sole traders (catégorie juridique 1xxx), and only
units whose data INSEE marks as fully public (statutDiffusionUniteLegale = 'O'). No officer names are used.
"""
import json

from . import config as K
from .market import fetch


def resolve_urls(log=print):
    meta = json.loads(fetch(K.SIRENE_DATASET))
    ul = et = None
    for r in meta.get("resources", []):
        title = (r.get("title") or "").lower()
        fmt = (r.get("format") or "").lower()
        url = r.get("url") or ""
        if "parquet" not in fmt and not url.endswith(".parquet"):
            continue
        if "historique" in title or "lienssuccession" in title.replace(" ", ""):
            continue
        if "stockunitelegale" in title.replace(" ", "") and ul is None:
            ul = url
        elif "stocketablissement" in title.replace(" ", "") and et is None:
            et = url
    log(f"[sirene] unités légales: {ul}\n[sirene] établissements: {et}")
    if not ul or not et:
        raise RuntimeError("Fichiers SIRENE parquet introuvables dans le jeu de données data.gouv")
    return ul, et


GEO_COMMUNES = "https://geo.api.gouv.fr/communes?fields=code,centre&type=commune-actuelle,arrondissement-municipal&format=json"


def commune_centres(log=print):
    """{code INSEE: (lon, lat)} from the official geo API; used when INSEE gives no coordinates for a head office."""
    try:
        data = json.loads(fetch(GEO_COMMUNES, timeout=120))
        out = {c["code"]: tuple(c["centre"]["coordinates"]) for c in data if c.get("centre")}
        log(f"[sirene] {len(out)} centres de communes (geo.api.gouv.fr)")
        return out
    except Exception as e:  # noqa: BLE001
        log(f"[sirene] WARNING centres de communes indisponibles ({e})")
        return {}


def lambert93_to_wgs84(xs, ys):
    from pyproj import Transformer
    tr = Transformer.from_crs("EPSG:2154", "EPSG:4326", always_xy=True)
    return tr.transform(xs, ys)


def load(con, sirens, ul_url=None, et_url=None, log=print):
    """Return {siren: {name, naf, created, size, cat, legal, commune, cp, dep, lat, lon}}."""
    import pandas as pd
    ul_url, et_url = (ul_url, et_url) if ul_url else resolve_urls(log)
    con.register("wanted", pd.DataFrame({"siren": list(sirens)}))
    ul = con.execute(f"""
      SELECT u.siren, u.denominationUniteLegale AS name, u.sigleUniteLegale AS sigle,
             u.activitePrincipaleUniteLegale AS naf, u.dateCreationUniteLegale AS created,
             u.trancheEffectifsUniteLegale AS size, u.categorieEntreprise AS cat,
             u.categorieJuridiqueUniteLegale AS legal, u.nicSiegeUniteLegale AS nic,
             u.etatAdministratifUniteLegale AS state, u.statutDiffusionUniteLegale AS diff
      FROM read_parquet('{ul_url}') u JOIN wanted w ON w.siren = CAST(u.siren AS VARCHAR)
    """).df()
    log(f"[sirene] {len(ul)} unités légales trouvées")
    ul = ul[(ul["state"] == "A") & (ul["diff"] == "O") & (~ul["legal"].astype(str).str.startswith("1"))]
    ul["siret"] = ul["siren"].astype(str) + ul["nic"].astype(str).str.zfill(5)
    con.register("sieges", ul[["siret"]])
    et_cols = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{et_url}')").fetchall()}
    has_xy = {"coordonneeLambertAbscisseEtablissement", "coordonneeLambertOrdonneeEtablissement"} <= et_cols
    if not has_xy:
        log("[sirene] pas de coordonnées Lambert dans le fichier établissements : centres de communes utilisés")
    xy = ("e.coordonneeLambertAbscisseEtablissement AS x, e.coordonneeLambertOrdonneeEtablissement AS y" if has_xy
          else "NULL AS x, NULL AS y")
    et = con.execute(f"""
      SELECT CAST(e.siret AS VARCHAR) AS siret, e.codeCommuneEtablissement AS commune_code,
             e.libelleCommuneEtablissement AS commune, e.codePostalEtablissement AS cp, {xy}
      FROM read_parquet('{et_url}') e JOIN sieges s ON s.siret = CAST(e.siret AS VARCHAR)
    """).df()
    log(f"[sirene] {len(et)} sièges géolocalisables")
    df = ul.merge(et, on="siret", how="left")
    df["x"] = pd.to_numeric(df["x"], errors="coerce")
    df["y"] = pd.to_numeric(df["y"], errors="coerce")
    metro = df["x"].between(50_000, 1_300_000) & df["y"].between(6_000_000, 7_200_000)
    lon, lat = lambert93_to_wgs84(df.loc[metro, "x"].tolist(), df.loc[metro, "y"].tolist())
    df.loc[metro, "lon"] = lon
    df.loc[metro, "lat"] = lat
    missing = df["lat"].isna() if "lat" in df else pd.Series(True, index=df.index)
    if missing.any():
        centres = commune_centres(log)
        for ix in df.index[missing]:
            c = centres.get(str(df.at[ix, "commune_code"] or ""))
            if c:
                df.at[ix, "lon"], df.at[ix, "lat"] = c
        log(f"[sirene] {int(missing.sum())} sièges placés au centre de leur commune")
    df = df.astype(object).where(df.notna(), None)   # pandas NaN -> None
    out = {}
    for r in df.itertuples(index=False):
        cc = str(r.commune_code or "")
        dep = cc[:3] if cc.startswith("97") else cc[:2]
        out[str(r.siren).zfill(9)] = {
            "name": (r.name or r.sigle or "").strip() or None, "naf": r.naf, "created": str(r.created or "")[:10],
            "size": r.size, "cat": r.cat, "legal": str(r.legal), "commune": r.commune, "cp": r.cp, "dep": dep,
            "lat": None if getattr(r, "lat", None) is None else round(float(r.lat), 5),
            "lon": None if getattr(r, "lon", None) is None else round(float(r.lon), 5),
        }
    return out
