"""Calibración absoluta de UM del modelo de haz."""
import numpy as np

from .engine import CalcOptions, DoseEngine
from .water import compute_water, point_dose, square_beam, water_grid


def calibrate(model, spacing_mm=2.5, options=None, engine=None):
    """Calcula calibration.cgy_per_unit en las condiciones de referencia.

    Condiciones: campo cuadrado de calibration.field_mm definido por
    mandíbulas, DFS calibration.ssd_mm, profundidad calibration.depth_mm, y
    dosis calibration.dose_per_mu_cgy por UM.
    """
    cal = model.calibration
    eng = engine or DoseEngine(model, options or CalcOptions())
    lateral = max(250.0, cal.field_mm * 1.6 + 100.0)
    grid = water_grid(spacing_mm, lateral, max(250.0, cal.depth_mm + 150.0))
    mu = 100.0
    beam = square_beam(cal.field_mm, ssd_mm=cal.ssd_mm, mu=mu, energy=model.energy,
                       fluence_mode=model.fluence_mode)
    D = compute_water(eng, model, beam, grid)
    d = point_dose(D, grid, cal.depth_mm)
    if not np.isfinite(d) or d <= 0:
        raise RuntimeError("Dosis de referencia no válida en la calibración")
    cal.cgy_per_unit = cal.dose_per_mu_cgy * mu / d
    cal.grid_mm = float(spacing_mm)
    return cal.cgy_per_unit
