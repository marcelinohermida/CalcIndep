"""Histogramas dosis-volumen y métricas por estructura (cálculo por vóxeles)."""
import numpy as np


def cumulative_dvh(dose, mask, bin_gy=0.01, dmax=None):
    v = dose[mask]
    if v.size == 0:
        return np.array([0.0]), np.array([0.0])
    top = float(dmax if dmax is not None else v.max()) * 1.02 + bin_gy
    edges = np.arange(0.0, top + bin_gy, bin_gy)
    h, _ = np.histogram(v, bins=edges)
    cum = h[::-1].cumsum()[::-1] / v.size * 100.0
    return edges[:-1], cum


def dose_at_volume_pct(values_sorted_desc, pct):
    n = values_sorted_desc.size
    if n == 0:
        return np.nan
    idx = int(np.clip(np.ceil(pct / 100.0 * n) - 1, 0, n - 1))
    return float(values_sorted_desc[idx])


def dose_at_volume_cc(values_sorted_desc, cc, voxel_cc):
    n = values_sorted_desc.size
    if n == 0:
        return np.nan
    k = int(np.clip(np.ceil(cc / voxel_cc) - 1, 0, n - 1))
    return float(values_sorted_desc[k])


def metrics(dose, mask, voxel_cc):
    v = np.sort(dose[mask])[::-1]
    if v.size == 0:
        return {"volume_cc": 0.0}
    return {
        "volume_cc": float(v.size * voxel_cc),
        "Dmean": float(v.mean()),
        "Dmax_0.03cc": dose_at_volume_cc(v, 0.03, voxel_cc),
        "D2": dose_at_volume_pct(v, 2),
        "D50": dose_at_volume_pct(v, 50),
        "D95": dose_at_volume_pct(v, 95),
        "D98": dose_at_volume_pct(v, 98),
        "Dmin": float(v[-1]),
    }
