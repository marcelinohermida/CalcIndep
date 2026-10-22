"""Fluencia de energía en el plano del isocentro a partir de los puntos de control.

Entre dos puntos de control consecutivos las mandíbulas y las láminas se
mueven linealmente con las UM. Para cada píxel del mapa se calcula de forma
analítica la fracción de UM durante la que el píxel está descubierto, sin
submuestreo temporal. Esto trata del mismo modo campos estáticos,
step-and-shoot, ventana deslizante y VMAT.

Para los arcos, cada segmento se divide en subsegmentos de como máximo
`max_gantry_step` grados; cada subsegmento es una incidencia con su propio
ángulo de gantry.

MLC: la DLG desplaza cada punta DLG/2 hacia fuera. En una franja de ancho
tg_width centrada en cada límite entre láminas (lengüeta-ranura) el punto solo
está descubierto cuando lo están las dos láminas vecinas. La transmisión es
T_MLC bajo las láminas, T_jaw bajo las mandíbulas y T_jaw·T_MLC donde se
superponen. Los parámetros son los del MLC del haz (calcindep.mlc).
"""
from dataclasses import dataclass

import numpy as np
from numba import njit, prange
from scipy.ndimage import gaussian_filter, map_coordinates
from scipy.special import erfc

from .geometry import BeamGeometry
from .mlc import tg_rows


@dataclass
class SubBeam:
    geom: BeamGeometry
    fluence: np.ndarray       # (ny, nx) energía relativa por UM integrada
    efluence: np.ndarray      # mapa para la contaminación electrónica
    axes: tuple               # (x0, dx, y0, dy) mm
    mu: float
    beam_number: int
    gantry: float


def _interval_gt(c0, c1, t0, t1):
    """Intervalo de t en [t0, t1] donde c0 + c1 t > 0 (arrays)."""
    c0 = np.asarray(c0, float)
    c1 = np.broadcast_to(np.asarray(c1, float), c0.shape)
    lo = np.full(c0.shape, t0)
    hi = np.full(c0.shape, t1)
    with np.errstate(divide="ignore", invalid="ignore"):
        tc = -c0 / c1
    pos = c1 > 0
    neg = c1 < 0
    zero = ~(pos | neg)
    lo = np.where(pos, np.maximum(lo, tc), lo)
    hi = np.where(neg, np.minimum(hi, tc), hi)
    # c1 == 0: abierto todo el intervalo si c0 > 0, cerrado si no.
    hi = np.where(zero & (c0 <= 0), lo, hi)
    return lo, hi


def leaf_fractions(cpa, cpb, t0, t1, xg, yg, leaf_rows, dlg, tg=None):
    """Fracciones de tiempo en [t0, t1] (normalizadas al segmento).

    Devuelve (f_open, f_jaw, f_mlc), arrays (ny, nx):
      f_open: mandíbulas y MLC abiertos a la vez;
      f_jaw:  mandíbulas abiertas;
      f_mlc:  MLC abierto (con independencia de las mandíbulas).
    Fuera del MLC, f_mlc = t1 - t0 y f_open = f_jaw.

    tg: (vecina, fracción) por fila, de calcindep.mlc.tg_rows. En la fracción
    de cada fila que cae en la franja lengüeta-ranura, el MLC está abierto
    solo cuando lo están la lámina propia y la vecina.
    """
    X = xg[None, :]
    Y = yg[:, None]
    dt = t1 - t0
    # Mandíbulas X:  x > x1(t),  x < x2(t)
    lo1, hi1 = _interval_gt(X - cpa.x1, -(cpb.x1 - cpa.x1), t0, t1)
    lo2, hi2 = _interval_gt(cpa.x2 - X, (cpb.x2 - cpa.x2), t0, t1)
    # Mandíbulas Y
    lo3, hi3 = _interval_gt(Y - cpa.y1, -(cpb.y1 - cpa.y1), t0, t1)
    lo4, hi4 = _interval_gt(cpa.y2 - Y, (cpb.y2 - cpa.y2), t0, t1)
    lo_j = np.maximum(np.maximum(lo1, lo2), np.maximum(lo3, lo4))
    hi_j = np.minimum(np.minimum(hi1, hi2), np.minimum(hi3, hi4))
    f_jaw = np.clip(hi_j - lo_j, 0, None)
    if cpa.mlc_a is None or leaf_rows is None:
        return f_jaw, f_jaw, np.full(f_jaw.shape, dt)
    valid = leaf_rows >= 0

    def leaf_interval(idx):
        r = np.where(idx >= 0, idx, 0)
        a0 = cpa.mlc_a[r][:, None] - 0.5 * dlg
        a1 = cpb.mlc_a[r][:, None] - 0.5 * dlg
        b0 = cpa.mlc_b[r][:, None] + 0.5 * dlg
        b1 = cpb.mlc_b[r][:, None] + 0.5 * dlg
        lo5, hi5 = _interval_gt(X - a0, -(a1 - a0), t0, t1)
        lo6, hi6 = _interval_gt(b0 - X, (b1 - b0), t0, t1)
        return np.maximum(lo5, lo6), np.minimum(hi5, hi6)

    def fracs(lo_m, hi_m):
        f_m = np.clip(hi_m - lo_m, 0, None)
        f_o = np.clip(np.minimum(hi_m, hi_j) - np.maximum(lo_m, lo_j), 0, None)
        return f_o, f_m

    lo_m, hi_m = leaf_interval(leaf_rows)
    f_open, f_mlc = fracs(lo_m, hi_m)
    if tg is not None:
        nbr, frac = tg
        sel = valid & (nbr >= 0) & (frac > 0)
        if np.any(sel):
            lo_n, hi_n = leaf_interval(np.where(sel, nbr, leaf_rows))
            fo2, fm2 = fracs(np.maximum(lo_m, lo_n), np.minimum(hi_m, hi_n))
            w = np.where(sel, frac, 0.0)[:, None]
            f_open = (1.0 - w) * f_open + w * fo2
            f_mlc = (1.0 - w) * f_mlc + w * fm2
    f_open = np.where(valid[:, None], f_open, f_jaw)
    f_mlc = np.where(valid[:, None], f_mlc, dt)
    return f_open, f_jaw, f_mlc


def segment_fractions(cpa, cpb, t0, t1, xg, yg, leaf_rows, dlg, tg=None):
    """(f_open, f_jaw) de leaf_fractions (compatibilidad)."""
    fo, fj, _ = leaf_fractions(cpa, cpb, t0, t1, xg, yg, leaf_rows, dlg, tg)
    return fo, fj


def aperture_from_fractions(fo, fj, fm, dt, t_mlc, t_jaw):
    """Apertura relativa: 1 abierto, T_MLC bajo láminas, T_jaw bajo mandíbulas y
    T_jaw·T_MLC bajo ambas."""
    both = np.clip(dt - fj - fm + fo, 0, None)     # mandíbulas y MLC cerrados
    jaw_only = np.clip(fm - fo, 0, None)           # mandíbulas cerradas, MLC abierto
    mlc_only = np.clip(fj - fo, 0, None)           # mandíbulas abiertas, MLC cerrado
    return fo + t_mlc * mlc_only + t_jaw * jaw_only + t_jaw * t_mlc * both


@njit(cache=True)
def _igt(c0, c1, t0, t1):
    """Versión escalar de _interval_gt (mismas operaciones)."""
    lo = t0
    hi = t1
    if c1 > 0:
        tc = -c0 / c1
        lo = max(lo, tc)
    elif c1 < 0:
        tc = -c0 / c1
        hi = min(hi, tc)
    elif c0 <= 0:
        hi = lo
    return lo, hi


@njit(parallel=True, cache=True)
def _aperture_nb(xg, yg, jaws, has_mlc, rows, la0, la1, lb0, lb1, dlg,
                 has_tg, tg_nbr, tg_frac, t0, t1, t_mlc, t_jaw, out):
    """leaf_fractions + aperture_from_fractions píxel a píxel, compilado.

    jaws: (x1a, x1b, x2a, x2b, y1a, y1b, y2a, y2b) en los puntos de control a y b.
    la0, la1, lb0, lb1: posiciones de las láminas A y B en a y b (por lámina).
    Mismas fórmulas y orden de operaciones que la versión con NumPy.
    """
    ny = yg.shape[0]
    nx = xg.shape[0]
    dt = t1 - t0
    hd = 0.5 * dlg
    for j in prange(ny):
        Y = yg[j]
        lo3, hi3 = _igt(Y - jaws[4], -(jaws[5] - jaws[4]), t0, t1)
        lo4, hi4 = _igt(jaws[6] - Y, (jaws[7] - jaws[6]), t0, t1)
        r = rows[j] if has_mlc else -1
        valid = r >= 0
        sel = False
        if valid and has_tg:
            sel = tg_nbr[j] >= 0 and tg_frac[j] > 0
        if valid:
            a0 = la0[r] - hd
            a1 = la1[r] - hd
            b0 = lb0[r] + hd
            b1 = lb1[r] + hd
        if sel:
            q = tg_nbr[j]
            na0 = la0[q] - hd
            na1 = la1[q] - hd
            nb0 = lb0[q] + hd
            nb1 = lb1[q] + hd
            w = tg_frac[j]
        for i in range(nx):
            X = xg[i]
            lo1, hi1 = _igt(X - jaws[0], -(jaws[1] - jaws[0]), t0, t1)
            lo2, hi2 = _igt(jaws[2] - X, (jaws[3] - jaws[2]), t0, t1)
            lo_j = max(max(lo1, lo2), max(lo3, lo4))
            hi_j = min(min(hi1, hi2), min(hi3, hi4))
            fj = max(hi_j - lo_j, 0.0)
            if not has_mlc:
                fo = fj
                fm = dt
            elif not valid:
                fo = fj
                fm = dt
            else:
                lo5, hi5 = _igt(X - a0, -(a1 - a0), t0, t1)
                lo6, hi6 = _igt(b0 - X, (b1 - b0), t0, t1)
                lo_m = max(lo5, lo6)
                hi_m = min(hi5, hi6)
                fm = max(hi_m - lo_m, 0.0)
                fo = max(min(hi_m, hi_j) - max(lo_m, lo_j), 0.0)
                if sel:
                    lo7, hi7 = _igt(X - na0, -(na1 - na0), t0, t1)
                    lo8, hi8 = _igt(nb0 - X, (nb1 - nb0), t0, t1)
                    lo_n = max(lo7, lo8)
                    hi_n = min(hi7, hi8)
                    lo2m = max(lo_m, lo_n)
                    hi2m = min(hi_m, hi_n)
                    fm2 = max(hi2m - lo2m, 0.0)
                    fo2 = max(min(hi2m, hi_j) - max(lo2m, lo_j), 0.0)
                    fo = (1.0 - w) * fo + w * fo2
                    fm = (1.0 - w) * fm + w * fm2
            both = max(dt - fj - fm + fo, 0.0)
            jaw_only = max(fm - fo, 0.0)
            mlc_only = max(fj - fo, 0.0)
            out[j, i] = fo + t_mlc * mlc_only + t_jaw * jaw_only + t_jaw * t_mlc * both


def aperture_fast(cpa, cpb, t0, t1, xg, yg, leaf_rows, dlg, tg, t_mlc, t_jaw):
    """Apertura relativa del segmento [t0, t1] (equivale a leaf_fractions +
    aperture_from_fractions, compilada con numba)."""
    jaws = np.array([cpa.x1, cpb.x1, cpa.x2, cpb.x2, cpa.y1, cpb.y1, cpa.y2, cpb.y2], float)
    has_mlc = cpa.mlc_a is not None and leaf_rows is not None
    e = np.zeros(1)
    if has_mlc:
        la0 = np.asarray(cpa.mlc_a, float)
        la1 = np.asarray(cpb.mlc_a, float)
        lb0 = np.asarray(cpa.mlc_b, float)
        lb1 = np.asarray(cpb.mlc_b, float)
        rows = np.asarray(leaf_rows, np.int64)
    else:
        la0 = la1 = lb0 = lb1 = e
        rows = np.full(yg.size, -1, np.int64)
    has_tg = tg is not None
    if has_tg:
        tg_nbr = np.asarray(tg[0], np.int64)
        tg_frac = np.asarray(tg[1], float)
    else:
        tg_nbr = np.full(yg.size, -1, np.int64)
        tg_frac = np.zeros(yg.size)
    out = np.empty((yg.size, xg.size))
    _aperture_nb(np.asarray(xg, float), np.asarray(yg, float), jaws, has_mlc, rows,
                 la0, la1, lb0, lb1, float(dlg), has_tg, tg_nbr, tg_frac,
                 float(t0), float(t1), float(t_mlc), float(t_jaw), out)
    return out


def _beam_extent(beam):
    x1 = min(cp.x1 for cp in beam.cps)
    x2 = max(cp.x2 for cp in beam.cps)
    y1 = min(cp.y1 for cp in beam.cps)
    y2 = max(cp.y2 for cp in beam.cps)
    return max(x1, -200.0), min(x2, 200.0), max(y1, -200.0), min(y2, 200.0)


def _broad_blur(A, sigma_px):
    """Filtro gaussiano (σ escalar o (σ_filas, σ_columnas) en píxeles).

    Para σ grandes se aplica sobre una malla reducida.
    """
    sig = np.broadcast_to(np.asarray(sigma_px, float), (2,))
    if sig.min() < 6.0:
        return gaussian_filter(A, tuple(sig), mode="constant")
    f = max(1, int(sig.min() // 6))
    ny, nx = A.shape
    py, px = (-ny) % f, (-nx) % f
    Ap = np.pad(A, ((0, py), (0, px)))
    c = Ap.reshape(Ap.shape[0] // f, f, Ap.shape[1] // f, f).mean(axis=(1, 3))
    c = gaussian_filter(c, tuple(sig / f), mode="constant")
    jj = (np.arange(ny) + 0.5) / f - 0.5
    ii = (np.arange(nx) + 0.5) / f - 0.5
    out = np.empty((ny, nx))
    _upsample_lin(np.ascontiguousarray(c, dtype=np.float64), jj, ii, out)
    return out


@njit(parallel=True, cache=True)
def _upsample_lin(c, jj, ii, out):
    """Interpolación bilineal de c en la red (jj, ii); fuera del borde, valor del
    borde. Equivale a map_coordinates(order=1, mode="nearest")."""
    ny, nx = c.shape
    for j in prange(jj.shape[0]):
        fy = min(max(jj[j], 0.0), ny - 1.0)
        j0 = int(fy)
        if j0 > ny - 2:
            j0 = max(ny - 2, 0)
        j1 = min(j0 + 1, ny - 1)
        ty = fy - j0
        for i in range(ii.shape[0]):
            fx = min(max(ii[i], 0.0), nx - 1.0)
            i0 = int(fx)
            if i0 > nx - 2:
                i0 = max(nx - 2, 0)
            i1 = min(i0 + 1, nx - 1)
            tx = fx - i0
            out[j, i] = ((1.0 - ty) * ((1.0 - tx) * c[j0, i0] + tx * c[j0, i1])
                         + ty * ((1.0 - tx) * c[j1, i0] + tx * c[j1, i1]))


def _apply_model(A, model, xg, yg, res, cache=None):
    """Convierte la apertura integrada en fluencia de energía.

    cache: dict opcional para guardar el perfil radial y el colimador primario,
    que no cambian entre incidencias del mismo haz (mismo mapa y modelo).
    """
    sp = model.primary_sigma_mm / res
    prim = gaussian_filter(A, sp, mode="constant") if sp > 0.05 else A
    if cache is not None and "oa" in cache:
        oa, pc = cache["oa"], cache["pc"]
    else:
        X, Y = np.meshgrid(xg, yg)
        R = np.hypot(X, Y)
        oa = model.oa(R)
        pc = None
        if model.primary_collimator_radius_mm > 0:
            sg = max(model.primary_collimator_sigma_mm, 0.1)
            pc = erfc((R - model.primary_collimator_radius_mm) / (np.sqrt(2.0) * sg))
        if cache is not None:
            cache["oa"], cache["pc"] = oa, pc
    prim = prim * oa * model.primary_weight
    if pc is not None:
        prim = prim * 0.5 * pc
    psi = prim
    if model.extrafocal_weight > 0:
        sx, sy = model.ef_sigmas
        psi = psi + model.extrafocal_weight * _broad_blur(A, (sy / res, sx / res))
    if model.econt_weight > 0:
        e = model.econt_weight * _broad_blur(A, model.econt_sigma_mm / res)
    else:
        e = np.zeros_like(A)
    return psi, e


def subbeams(beam, model, res_mm=0.5, max_gantry_step=2.0, margin_mm=None):
    """Genera las incidencias (SubBeam) de un haz."""
    if margin_mm is None:
        margin_mm = min(120.0, 3 * max(max(model.ef_sigmas), model.econt_sigma_mm,
                                       model.primary_sigma_mm) + 5)
    x1, x2, y1, y2 = _beam_extent(beam)
    xg = np.arange(np.floor((x1 - margin_mm) / res_mm) * res_mm, x2 + margin_mm + res_mm, res_mm)
    yg = np.arange(np.floor((y1 - margin_mm) / res_mm) * res_mm, y2 + margin_mm + res_mm, res_mm)
    xg = xg + 0.5 * res_mm
    yg = yg + 0.5 * res_mm
    axes = (xg[0], res_mm, yg[0], res_mm)
    rows = None
    tg = None
    tm, dlg = 0.0, 0.0
    tj = model.jaw_transmission
    if beam.leaf_boundaries is not None:
        _, mp = model.mlc_for_beam(beam)
        tm, dlg = mp.transmission, mp.dlg_mm
        lb = beam.leaf_boundaries
        rows = np.searchsorted(lb, yg) - 1
        rows[(yg < lb[0]) | (yg > lb[-1])] = -1
        if mp.tg_width_mm > 0:
            tg = tg_rows(yg, res_mm, lb, rows, mp.tg_width_mm)
    cps = beam.cps
    if len(cps) == 1:
        cps = [cps[0], cps[0]]

    def mbs(cpa, cpb):
        if model.monitor_backscatter_k == 0:
            return 1.0
        sx = 0.5 * ((cpa.x2 - cpa.x1) + (cpb.x2 - cpb.x1))
        sy = 0.5 * ((cpa.y2 - cpa.y1) + (cpb.y2 - cpb.y1))
        return 1.0 / (1.0 + model.monitor_backscatter_k * (np.sqrt(max(sx * sy, 1.0)) / 100.0 - 1.0))

    def aperture(cpa, cpb, t0, t1, dmu):
        return dmu * mbs(cpa, cpb) * aperture_fast(cpa, cpb, t0, t1, xg, yg, rows, dlg, tg, tm, tj)

    radial = {}   # factores que solo dependen de la posición en el mapa (iguales en todas las incidencias)

    pp = beam.patient_position
    if not beam.is_arc:
        A = np.zeros((yg.size, xg.size))
        mu_tot = 0.0
        for i in range(len(cps) - 1):
            dmu = (cps[i + 1].cmw - cps[i].cmw) * beam.mu
            if dmu <= 0:
                continue
            A += aperture(cps[i], cps[i + 1], 0.0, 1.0, dmu)
            mu_tot += dmu
        psi, e = _apply_model(A, model, xg, yg, res_mm, radial)
        cp = cps[0]
        geom = BeamGeometry(cp.iso, beam.sad, cp.gantry, cp.coll, cp.couch, pp)
        yield SubBeam(geom, psi, e, axes, mu_tot, beam.number, cp.gantry)
        return
    for i in range(len(cps) - 1):
        cpa, cpb = cps[i], cps[i + 1]
        dmu = (cpb.cmw - cpa.cmw) * beam.mu
        if dmu <= 0:
            continue
        ga, gb = cpa.gantry, cpb.gantry
        dg = (gb - ga + 180.0) % 360.0 - 180.0
        n = max(1, int(np.ceil(abs(dg) / max_gantry_step)))
        for s in range(n):
            t0, t1 = s / n, (s + 1) / n
            tm_ = 0.5 * (t0 + t1)
            g = (ga + dg * tm_) % 360.0
            A = aperture(cpa, cpb, t0, t1, dmu)
            psi, e = _apply_model(A, model, xg, yg, res_mm, radial)
            coll = cpa.coll + (cpb.coll - cpa.coll) * tm_
            couch = cpa.couch + (cpb.couch - cpa.couch) * tm_
            geom = BeamGeometry(cpa.iso, beam.sad, g, coll, couch, pp)
            yield SubBeam(geom, psi, e, axes, dmu * (t1 - t0), beam.number, g)


def subbeam_angles(beam, max_gantry_step=2.0):
    """(gantry, colimador, mesa) de cada incidencia, sin calcular la fluencia.

    Reproduce la subdivisión de `subbeams` y sirve para estimar el trabajo.
    """
    cps = beam.cps
    if len(cps) == 1:
        cps = [cps[0], cps[0]]
    if not beam.is_arc:
        cp = cps[0]
        return [(cp.gantry, cp.coll, cp.couch)]
    out = []
    for i in range(len(cps) - 1):
        cpa, cpb = cps[i], cps[i + 1]
        if (cpb.cmw - cpa.cmw) * beam.mu <= 0:
            continue
        dg = (cpb.gantry - cpa.gantry + 180.0) % 360.0 - 180.0
        n = max(1, int(np.ceil(abs(dg) / max_gantry_step)))
        for s in range(n):
            tm_ = (s + 0.5) / n
            out.append(((cpa.gantry + dg * tm_) % 360.0,
                        cpa.coll + (cpb.coll - cpa.coll) * tm_,
                        cpa.couch + (cpb.couch - cpa.couch) * tm_))
    return out
