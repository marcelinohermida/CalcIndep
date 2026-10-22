"""Kernels de deposición de energía y discretización en conos.

Los kernels monoenergéticos de punto se generaron con EGSnrc/EDKnrc en agua
(48 conos de 3.75 grados, 24 esferas hasta 60 cm). Para el cálculo se
construye un kernel polienergético con el espectro del modelo de haz, se
agrupan los conos de EDKnrc en bandas cenitales y cada banda se ajusta a una
suma de exponenciales (forma de Ahnesjö 1989):

    k(l) = sum_j A_j exp(-a_j l)          (fracción de energía por cm)
    K(l) = sum_j (A_j / a_j) (1 - exp(-a_j l))   (forma acumulada)

donde l es la distancia radiológica (cm de agua equivalente).
"""
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares

from .physics import mu_rho_water

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DEFAULT_EDK = DATA_DIR / "kernels" / "edknrc_mono" / "edk_water_mono.npz"

# Bandas cenitales (grados, múltiplos de 3.75) y número de direcciones azimutales.
DEFAULT_BAND_EDGES = [0.0, 3.75, 11.25, 18.75, 30.0, 45.0, 60.0, 75.0, 90.0,
                      105.0, 120.0, 135.0, 157.5, 180.0]
DEFAULT_N_PHI = [1, 6, 8, 10, 10, 10, 10, 10, 8, 8, 6, 6, 1]


@dataclass
class EDK:
    energies: np.ndarray       # (nE,) MeV
    angle_edges: np.ndarray    # (49,) grados
    radius_edges: np.ndarray   # (25,) cm
    total: np.ndarray          # (nE, 48, 24) fracción de energía por bin

    @property
    def n_angles(self):
        return self.total.shape[1]


def load_edk(path=DEFAULT_EDK):
    d = np.load(path)
    return EDK(energies=d["energies_MeV"].astype(float),
               angle_edges=d["angle_edges_deg"].astype(float),
               radius_edges=d["radius_edges_cm"].astype(float),
               total=d["total"].astype(float))


def terma_weights(energies, fluence_weights, depth_cm=0.0):
    """Peso de cada energía en el TERMA a una profundidad dada en agua."""
    e = np.asarray(energies, float)
    w = np.asarray(fluence_weights, float)
    mu = mu_rho_water(e)
    t = w * e * mu * np.exp(-mu * depth_cm)
    s = t.sum()
    return t / s if s > 0 else t


def polyenergetic_kernel(edk, energies, fluence_weights, depth_cm=10.0):
    """Kernel polienergético (48 x 24) ponderado por TERMA.

    `energies` deben coincidir con las energías de la tabla EDK.
    """
    idx = [int(np.argmin(np.abs(edk.energies - e))) for e in energies]
    tw = terma_weights(energies, fluence_weights, depth_cm)
    k = np.zeros(edk.total.shape[1:])
    for i, w in zip(idx, tw):
        k += w * edk.total[i]
    return k


def fit_exponentials(r_edges, k_cum, n_comp=2):
    """Ajusta K(r) = sum c_j (1 - exp(-a_j r)) a un kernel acumulado.

    Devuelve (A, a) con A_j = c_j a_j (cm^-1) y a_j (cm^-1).
    """
    r = np.asarray(r_edges[1:], float)
    k = np.asarray(k_cum, float)
    kmax = max(k.max(), 1e-30)
    if kmax <= 1e-12:
        return np.zeros(n_comp), np.ones(n_comp)
    # Valores iniciales: exponentes repartidos en escala logarítmica.
    a0 = np.geomspace(8.0, 0.08, n_comp)
    c0 = np.full(n_comp, kmax / n_comp)
    p0 = np.log(np.concatenate([c0, a0]))
    wts = 1.0 / (k + 0.02 * kmax)

    def model(p):
        c = np.exp(p[:n_comp])
        a = np.exp(p[n_comp:])
        return (c[None, :] * (1.0 - np.exp(-np.outer(r, a)))).sum(axis=1)

    def resid(p):
        return (model(p) - k) * wts

    sol = least_squares(resid, p0, method="trf", max_nfev=4000)
    c = np.exp(sol.x[:n_comp])
    a = np.exp(sol.x[n_comp:])
    order = np.argsort(-a)
    a = a[order]
    c = c[order]
    return c * a, a


@dataclass
class ConeSet:
    """Conjunto de direcciones de transporte en el sistema del haz.

    directions: (n, 3) vectores unitarios con componentes (u, v, w), donde w
                es la dirección de propagación del fotón primario.
    A, a:       (n, n_comp) parámetros exponenciales de cada dirección
                (la amplitud ya está dividida entre las direcciones de su banda).
    """
    directions: np.ndarray
    A: np.ndarray
    a: np.ndarray
    band: np.ndarray
    band_edges: np.ndarray
    band_fraction: np.ndarray   # fracción de energía de cada banda (hasta 60 cm)
    fit_rel_error: np.ndarray   # error relativo máximo del ajuste por banda

    @property
    def n(self):
        return self.directions.shape[0]


def build_cone_set(kernel, angle_edges, radius_edges, band_edges=None,
                   n_phi=None, n_comp=2):
    """Agrupa el kernel en bandas cenitales y ajusta exponenciales."""
    band_edges = np.asarray(DEFAULT_BAND_EDGES if band_edges is None else band_edges, float)
    n_phi = list(DEFAULT_N_PHI if n_phi is None else n_phi)
    if len(n_phi) != len(band_edges) - 1:
        raise ValueError("n_phi debe tener una entrada por banda")
    ang_lo = angle_edges[:-1]
    ang_hi = angle_edges[1:]
    dirs, As, as_, bands, fracs, errs = [], [], [], [], [], []
    phase = 0.0
    for b in range(len(band_edges) - 1):
        lo, hi = band_edges[b], band_edges[b + 1]
        sel = (ang_lo >= lo - 1e-6) & (ang_hi <= hi + 1e-6)
        if not np.any(sel):
            raise ValueError(f"La banda {lo}-{hi} no contiene conos EDK")
        kb = kernel[sel].sum(axis=0)
        kcum = np.cumsum(kb)
        A, a = fit_exponentials(radius_edges, kcum, n_comp)
        r = radius_edges[1:]
        kfit = ((A / a)[None, :] * (1 - np.exp(-np.outer(r, a)))).sum(axis=1)
        rel = np.abs(kfit - kcum) / max(kcum[-1], 1e-30)
        errs.append(rel.max())
        fracs.append(kcum[-1])
        # Ángulo cenital representativo: centroide energético de la banda.
        centers = 0.5 * (ang_lo[sel] + ang_hi[sel])
        wsum = kernel[sel].sum(axis=1)
        if lo == 0.0:
            theta = 0.0
        elif hi >= 180.0 - 1e-6:
            theta = 180.0
        else:
            theta = float((centers * wsum).sum() / max(wsum.sum(), 1e-30))
        np_b = n_phi[b]
        if theta in (0.0, 180.0):
            np_b = 1
        th = np.deg2rad(theta)
        for j in range(np_b):
            ph = 2 * np.pi * (j + phase) / np_b
            dirs.append([np.sin(th) * np.cos(ph), np.sin(th) * np.sin(ph), np.cos(th)])
            As.append(A / np_b)
            as_.append(a)
            bands.append(b)
        phase = 0.5 - phase  # alterna el desfase azimutal entre bandas
    return ConeSet(directions=np.array(dirs), A=np.array(As), a=np.array(as_),
                   band=np.array(bands), band_edges=band_edges,
                   band_fraction=np.array(fracs), fit_rel_error=np.array(errs))
