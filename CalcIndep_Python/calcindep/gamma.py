"""Índice gamma 3D según Low et al. (Med Phys 1998;25:656-661).

Para cada punto r_r de la distribución de referencia:

    Gamma(r_r) = min_{r_e} sqrt( |r_e - r_r|^2 / DTA^2 + (D_e(r_e) - D_r(r_r))^2 / dD^2 )

La distribución evaluada se interpola trilinealmente en una red de
desplazamientos de paso DTA/`interp_fraction` dentro de una esfera de radio
`max_gamma` x DTA. La búsqueda recorre los desplazamientos ordenados por
distancia y termina cuando el término de distancia ya supera el mínimo
encontrado, por lo que el resultado es el mínimo exacto sobre esa red.
"""
from dataclasses import dataclass, field

import numpy as np
from numba import njit, prange


@njit(cache=True, fastmath=True)
def _tri(D, fz, fy, fx):
    nz, ny, nx = D.shape
    if fx < 0 or fy < 0 or fz < 0 or fx > nx - 1 or fy > ny - 1 or fz > nz - 1:
        return np.nan
    i0 = min(int(fx), nx - 2) if nx > 1 else 0
    j0 = min(int(fy), ny - 2) if ny > 1 else 0
    k0 = min(int(fz), nz - 2) if nz > 1 else 0
    tx = fx - i0
    ty = fy - j0
    tz = fz - k0
    i1 = i0 + 1 if nx > 1 else 0
    j1 = j0 + 1 if ny > 1 else 0
    k1 = k0 + 1 if nz > 1 else 0
    return ((1 - tz) * ((1 - ty) * ((1 - tx) * D[k0, j0, i0] + tx * D[k0, j0, i1])
                        + ty * ((1 - tx) * D[k0, j1, i0] + tx * D[k0, j1, i1]))
            + tz * ((1 - ty) * ((1 - tx) * D[k1, j0, i0] + tx * D[k1, j0, i1])
                    + ty * ((1 - tx) * D[k1, j1, i0] + tx * D[k1, j1, i1])))


@njit(parallel=True, cache=True, fastmath=True)
def _gamma_points(pts, dref, D_e, e_org, e_sp, offs, d2, dta, dd_abs, local, dd_frac, gcap2, out):
    n = pts.shape[0]
    m = offs.shape[0]
    for p in prange(n):
        x = pts[p, 0]
        y = pts[p, 1]
        z = pts[p, 2]
        dr = dref[p]
        if local:
            ddv = dd_frac * dr
            if ddv <= 0:
                ddv = 1e-12
        else:
            ddv = dd_abs
        inv_dd2 = 1.0 / (ddv * ddv)
        inv_dta2 = 1.0 / (dta * dta)
        best = gcap2
        for q in range(m):
            dist2 = d2[q] * inv_dta2
            if dist2 >= best:
                break
            fx = (x + offs[q, 0] - e_org[0]) / e_sp[0]
            fy = (y + offs[q, 1] - e_org[1]) / e_sp[1]
            fz = (z + offs[q, 2] - e_org[2]) / e_sp[2]
            de = _tri(D_e, fz, fy, fx)
            if np.isnan(de):
                continue
            g2 = dist2 + (de - dr) * (de - dr) * inv_dd2
            if g2 < best:
                best = g2
        out[p] = np.sqrt(best)


def _offsets(dta_mm, max_gamma, step_mm):
    R = dta_mm * max_gamma
    n = int(np.ceil(R / step_mm))
    r = np.arange(-n, n + 1) * step_mm
    X, Y, Z = np.meshgrid(r, r, r, indexing="ij")
    d2 = X ** 2 + Y ** 2 + Z ** 2
    sel = d2 <= R * R + 1e-9
    o = np.column_stack([X[sel], Y[sel], Z[sel]])
    d2 = d2[sel]
    order = np.argsort(d2, kind="stable")
    return np.ascontiguousarray(o[order]), np.ascontiguousarray(d2[order])


@dataclass
class GammaSettings:
    dose_pct: float = 3.0
    dta_mm: float = 2.0
    local: bool = False
    threshold_pct: float = 10.0          # umbral de dosis (% de la dosis de normalización)
    normalization: str = "max"           # "max", "prescription" o "value"
    normalization_gy: float = None
    max_gamma: float = 2.0               # radio de búsqueda = max_gamma x DTA
    interp_fraction: int = 10            # paso = DTA / interp_fraction
    reference: str = "tps"               # distribución de referencia: "tps" o "calc"

    def describe(self):
        tipo = "local" if self.local else "global"
        return (f"{self.dose_pct:g}%/{self.dta_mm:g} mm, {tipo}, umbral {self.threshold_pct:g}%, "
                f"referencia: {'TPS' if self.reference == 'tps' else 'cálculo independiente'}")


@dataclass
class GammaResult:
    gamma: np.ndarray            # (nz, ny, nx) en la rejilla de referencia, NaN si no evaluado
    evaluated: np.ndarray        # máscara de puntos evaluados
    norm_gy: float
    settings: GammaSettings
    stats: dict = field(default_factory=dict)


def gamma_3d(ref, ref_grid, ev, ev_grid, settings: GammaSettings, mask=None, prescription_gy=None):
    """Gamma 3D. `ref` y `ev` en Gy. Devuelve GammaResult."""
    s = settings
    if s.normalization == "max":
        norm = float(np.nanmax(ref if mask is None else np.where(mask, ref, -np.inf)))
    elif s.normalization == "prescription":
        if not prescription_gy:
            raise ValueError("No hay dosis de prescripción para normalizar la gamma")
        norm = float(prescription_gy)
    else:
        norm = float(s.normalization_gy)
    thr = s.threshold_pct / 100.0 * norm
    sel = ref >= thr
    if mask is not None:
        sel &= mask
    k, j, i = np.nonzero(sel)
    x, y, z = ref_grid.axes()
    pts = np.column_stack([x[i], y[j], z[k]]).astype(np.float64)
    dref = ref[k, j, i].astype(np.float64)
    offs, d2 = _offsets(s.dta_mm, s.max_gamma, s.dta_mm / s.interp_fraction)
    out = np.empty(pts.shape[0])
    _gamma_points(pts, dref, np.ascontiguousarray(ev, dtype=np.float64),
                  np.asarray(ev_grid.origin, float), np.asarray(ev_grid.spacing, float),
                  offs, d2, float(s.dta_mm), float(s.dose_pct / 100.0 * norm), bool(s.local),
                  float(s.dose_pct / 100.0), float(s.max_gamma ** 2), out)
    g = np.full(ref.shape, np.nan)
    g[k, j, i] = out
    res = GammaResult(g, sel, norm, s)
    res.stats = gamma_stats(g, sel)
    return res


def gamma_stats(g, mask):
    v = g[mask & np.isfinite(g)]
    if v.size == 0:
        return {"n": 0, "pass_pct": np.nan, "mean": np.nan, "median": np.nan,
                "p95": np.nan, "max": np.nan}
    return {"n": int(v.size), "pass_pct": float(100.0 * np.mean(v <= 1.0)),
            "mean": float(v.mean()), "median": float(np.median(v)),
            "p95": float(np.percentile(v, 95)), "max": float(v.max())}


def gamma_by_structure(result, masks):
    """Estadísticos gamma por estructura. masks: dict nombre -> máscara (rejilla de referencia)."""
    out = {}
    for name, m in masks.items():
        out[name] = gamma_stats(result.gamma, result.evaluated & m)
        out[name]["n_voxels"] = int(m.sum())
    return out
