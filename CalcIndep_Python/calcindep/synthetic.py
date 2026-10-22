"""Casos sintéticos de prueba (maniquí de tórax con pulmones, columna y PTV).

Genera CT, RTSTRUCT, RTPLAN y, opcionalmente, un RTDOSE de referencia
calculado con un modelo de haz dado (para probar el flujo completo).
"""
from pathlib import Path

import numpy as np

from .dicom_write import new_patient, write_ct_series, write_rtdose, write_rtplan, write_rtstruct
from .geometry import BeamGeometry, Grid
from .mlc import MLC_TYPES


def thorax_phantom(spacing_mm=2.0, length_mm=200.0):
    nx, ny = int(340 / spacing_mm), int(240 / spacing_mm)
    nz = int(length_mm / spacing_mm)
    grid = Grid([-170 + spacing_mm / 2, -120 + spacing_mm / 2, -length_mm / 2 + spacing_mm / 2],
                [spacing_mm] * 3, (nz, ny, nx))
    Z, Y, X = grid.coords()
    hu = np.full(grid.shape, -1000.0)
    body = (X / 160.0) ** 2 + (Y / 105.0) ** 2 <= 1.0
    hu[body] = 0.0
    lung_r = ((X - 65) / 50.0) ** 2 + ((Y + 5) / 65.0) ** 2 + (Z / 90.0) ** 2 <= 1.0
    lung_l = ((X + 65) / 50.0) ** 2 + ((Y + 5) / 65.0) ** 2 + (Z / 90.0) ** 2 <= 1.0
    hu[lung_r | lung_l] = -750.0
    spine = (X / 15.0) ** 2 + ((Y - 75) / 15.0) ** 2 <= 1.0
    hu[spine & body] = 700.0
    tumor_c = np.array([55.0, -5.0, 0.0])
    tumor = ((X - tumor_c[0]) ** 2 + (Y - tumor_c[1]) ** 2 + (Z - tumor_c[2]) ** 2) <= 20.0 ** 2
    hu[tumor] = 20.0
    ptv = ((X - tumor_c[0]) ** 2 + (Y - tumor_c[1]) ** 2 + (Z - tumor_c[2]) ** 2) <= 27.0 ** 2
    structs = [
        {"name": "BODY", "mask": body, "type": "EXTERNAL", "color": (0, 255, 0)},
        {"name": "PTV", "mask": ptv, "type": "PTV", "color": (255, 0, 0)},
        {"name": "GTV", "mask": tumor, "type": "GTV", "color": (255, 128, 0)},
        {"name": "Pulmon_D", "mask": lung_r & ~tumor, "type": "ORGAN", "color": (0, 128, 255)},
        {"name": "Pulmon_I", "mask": lung_l, "type": "ORGAN", "color": (0, 200, 255)},
        {"name": "Columna", "mask": spine & body, "type": "ORGAN", "color": (255, 255, 0)},
    ]
    return grid, hu, structs, tumor_c


def conformal_leaves(points, geom, lb, margin=5.0, closed_pos=0.0):
    """Posiciones de láminas que conforman la proyección BEV de un conjunto de puntos."""
    xb, yb, _ = geom.to_bev(points)
    n = lb.size - 1
    a = np.full(n, closed_pos)
    b = np.full(n, closed_pos)
    for r in range(n):
        sel = (yb >= lb[r] - margin) & (yb <= lb[r + 1] + margin)
        if sel.any():
            a[r] = xb[sel].min() - margin
            b[r] = xb[sel].max() + margin
    return a, b


def _jaws_from_leaves(a, b, lb, margin=5.0):
    open_rows = np.nonzero(b - a > 0.5)[0]
    if open_rows.size == 0:
        return -5.0, 5.0, -5.0, 5.0
    x1 = a[open_rows].min() - margin
    x2 = b[open_rows].max() + margin
    y1 = lb[open_rows[0]] - margin
    y2 = lb[open_rows[-1] + 1] + margin
    return x1, x2, y1, y2


def _cp(g, iso, a, b, lb, cmw, coll=0.0, couch=0.0, jaws=None):
    x1, x2, y1, y2 = jaws if jaws is not None else _jaws_from_leaves(a, b, lb)
    closed = (b - a) <= 0.5
    a = np.where(closed, x1 - 10.0, a)
    b = np.where(closed, x1 - 10.0, b)
    return {"gantry": g, "coll": coll, "couch": couch, "iso": iso, "x1": x1, "x2": x2, "y1": y1, "y2": y2,
            "mlc_a": a.copy(), "mlc_b": b.copy(), "cmw": cmw}


def make_plan_beams(technique, ptv_points, iso, lb):
    beams = []
    if technique == "3D":
        for k, g in enumerate((0.0, 90.0, 180.0, 300.0)):
            geom = BeamGeometry(iso, 1000.0, g, 0.0, 0.0)
            a, b = conformal_leaves(ptv_points, geom, lb)
            cps = [_cp(g, iso, a, b, lb, 0.0), _cp(g, iso, a, b, lb, 1.0)]
            beams.append({"name": f"G{int(g):03d}", "mu": 90.0, "energy": "6X", "cps": cps})
    elif technique == "IMRT":
        # Step-and-shoot: 5 campos, 3 segmentos cada uno.
        for g in (20.0, 70.0, 120.0, 330.0, 280.0):
            geom = BeamGeometry(iso, 1000.0, g, 10.0, 0.0)
            a, b = conformal_leaves(ptv_points, geom, lb)
            c = 0.5 * (a + b)
            segs = [(a, b), (a + 0.25 * (c - a), b), (a, b - 0.3 * (b - c))]
            jaws = _jaws_from_leaves(a, b, lb)
            cps = []
            w = [0.5, 0.25, 0.25]
            cum = 0.0
            for (sa, sb), wi in zip(segs, w):
                cps.append(_cp(g, iso, sa, sb, lb, cum, 10.0, jaws=jaws))
                cum += wi
                cps.append(_cp(g, iso, sa, sb, lb, cum, 10.0, jaws=jaws))
            beams.append({"name": f"IM{int(g):03d}", "mu": 110.0, "energy": "6X", "cps": cps})
        # Ventana deslizante: un campo con barrido de láminas.
        g = 0.0
        geom = BeamGeometry(iso, 1000.0, g, 0.0, 0.0)
        a, b = conformal_leaves(ptv_points, geom, lb)
        jaws = _jaws_from_leaves(a, b, lb)
        n = 41
        cps = []
        for t in np.linspace(0, 1, n):
            gap = 12.0
            pos = jaws[0] - gap + t * (jaws[1] - jaws[0] + gap)
            la = np.where(b - a > 0.5, np.clip(pos, a, b), 0.0)
            lbp = np.where(b - a > 0.5, np.clip(pos + gap, a, b), 0.0)
            cps.append(_cp(g, iso, la, lbp, lb, t, 0.0, jaws=jaws))
        beams.append({"name": "SW000", "mu": 160.0, "energy": "6X", "cps": cps})
    elif technique == "VMAT":
        for arc, (g0, g1, coll) in enumerate(((181.0, 179.0, 30.0), (179.0, 181.0, 330.0))):
            n = 90
            span = 358.0
            sgn = 1.0 if arc == 0 else -1.0
            cps = []
            for i in range(n + 1):
                t = i / n
                g = (g0 + sgn * span * t) % 360.0
                geom = BeamGeometry(iso, 1000.0, g, coll, 0.0)
                a, b = conformal_leaves(ptv_points, geom, lb)
                # Modulación: se cierra parcialmente la apertura de forma oscilante.
                c = 0.5 * (a + b)
                f = 0.25 + 0.2 * np.sin(2 * np.pi * 3 * t + arc)
                openr = b - a > 0.5
                a2 = np.where(openr, a + f * (c - a) * (np.arange(a.size) % 2), a)
                b2 = np.where(openr, b - f * (b - c) * ((np.arange(a.size) + 1) % 2), b)
                jaws = _jaws_from_leaves(a, b, lb)
                cp = _cp(g, iso, a2, b2, lb, t, coll, jaws=jaws)
                cp["gdir"] = "CW" if sgn > 0 else "CC"
                cps.append(cp)
            beams.append({"name": f"ARC{arc + 1}", "mu": 280.0, "energy": "6X", "cps": cps})
    else:
        raise ValueError(technique)
    return beams


def generate_case(folder, technique="3D", engine=None, n_fractions=1, rx_gy=2.0,
                  ct_spacing_mm=2.0, dose_spacing_mm=2.5, progress=print, mlc="Millennium120"):
    """Crea un caso completo. Si `engine` no es None, también el RTDOSE de referencia.

    mlc: "Millennium120" o "HD120" (calcindep.mlc.MLC_TYPES).
    """
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    grid, hu, structs, iso = thorax_phantom(ct_spacing_mm)
    pat = new_patient(pid=f"SINT_{technique}")
    series, uids = write_ct_series(folder / "CT", hu, grid, pat)
    write_rtstruct(folder / "RS.dcm", structs, grid, pat, series, uids)
    lb = MLC_TYPES[mlc][1]()
    Z, Y, X = grid.coords()
    ptv = structs[1]["mask"]
    pts = np.column_stack([X[ptv], Y[ptv], Z[ptv]])[::7]
    beams = make_plan_beams(technique, pts, iso, lb)
    plan_uid = write_rtplan(folder / "RP.dcm", pat, beams, n_fractions=n_fractions, rx_gy=rx_gy * n_fractions,
                            label=f"SINT_{technique}", leaf_boundaries=lb)
    if engine is not None:
        from . import dicom_io
        from .engine import build_density
        from .hu_ed import EXAMPLE_CURVE, HUEDCurve
        progress("Calculando RTDOSE de referencia")
        plan = dicom_io.read_rtplan(folder / "RP.dcm")
        ct, _ = dicom_io.read_ct(sorted((folder / "CT").glob("*.dcm")))
        st, _ = dicom_io.read_rtstruct(folder / "RS.dcm")
        x0, x1, y0, y1, z0, z1 = grid.extent()
        sp = dose_spacing_mm
        n = np.floor(np.array([x1 - x0, y1 - y0, z1 - z0]) / sp).astype(int) + 1
        dgrid = Grid([x0, y0, z0], [sp] * 3, (n[2], n[1], n[0]))
        rho, mask, _ = build_density(ct, HUEDCurve.from_csv(EXAMPLE_CURVE), dgrid, st, engine.options)
        dose, _ = engine.compute_plan(plan, rho, dgrid, mask, progress=progress)
        write_rtdose(folder / "RD.dcm", dose * n_fractions, dgrid, patient=pat, plan_uid=plan_uid,
                     description="Dosis de referencia sintetica")
    return folder
