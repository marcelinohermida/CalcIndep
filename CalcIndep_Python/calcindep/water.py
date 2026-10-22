"""Cálculos en maniquí de agua: calibración de UM y comisionado.

Convenio: superficie del agua en el plano y = 0 (DICOM), haz anterior
(gantry 0, paciente HFS), eje del haz en x = z = 0. La profundidad es y.
"""
import numpy as np

from .dicom_io import Beam, ControlPoint
from .geometry import Grid
from .mlc import hd120_boundaries, millennium120_boundaries  # noqa: F401


def water_grid(spacing_mm=2.5, lateral_mm=300.0, depth_mm=300.0, lateral_z_mm=None):
    lz = lateral_mm if lateral_z_mm is None else lateral_z_mm
    nx = int(round(lateral_mm / spacing_mm))
    nz = int(round(lz / spacing_mm))
    ny = int(round(depth_mm / spacing_mm))
    # Centro del haz en el centro de un vóxel si n es impar; se fuerza impar.
    nx += (nx + 1) % 2
    nz += (nz + 1) % 2
    origin = [-(nx - 1) / 2 * spacing_mm, spacing_mm / 2, -(nz - 1) / 2 * spacing_mm]
    return Grid(origin, [spacing_mm] * 3, (nz, ny, nx))


def square_beam(fx_mm, fy_mm=None, ssd_mm=1000.0, mu=100.0, sad_mm=1000.0, mlc=None,
                coll=0.0, energy="6X", fluence_mode="STANDARD", number=1):
    """Haz estático rectangular definido por mandíbulas (con MLC opcional).

    mlc: None (sin MLC) o 'retracted' (MLC Millennium 120 retirado detrás de las
    mandíbulas) o 'conform' (MLC ajustado al campo).
    """
    fy_mm = fx_mm if fy_mm is None else fy_mm
    iso = np.array([0.0, sad_mm - ssd_mm, 0.0])
    lb = None
    a = b = None
    if mlc is not None:
        lb = millennium120_boundaries()
        n = lb.size - 1
        if mlc == "retracted":
            a = np.full(n, -200.0)
            b = np.full(n, 200.0)
        else:
            a = np.full(n, -fx_mm / 2)
            b = np.full(n, fx_mm / 2)
    cps = []
    for i, w in enumerate((0.0, 1.0)):
        cps.append(ControlPoint(i, w, 0.0, coll, 0.0, iso, -fx_mm / 2, fx_mm / 2, -fy_mm / 2, fy_mm / 2,
                                None if a is None else a.copy(), None if b is None else b.copy(), ssd_mm))
    return Beam(number=number, name=f"{fx_mm / 10:g}x{fy_mm / 10:g}", machine="", energy=energy,
                fluence_mode=fluence_mode, sad=sad_mm, mu=mu, beam_type="TREATMENT",
                radiation_type="PHOTON", delivery_type="STATIC", patient_position="HFS",
                leaf_boundaries=lb, cps=cps)


def central_axis(dose, grid):
    """Curva de dosis en profundidad sobre el eje (x = z = 0)."""
    x, y, z = grid.axes()
    i = int(np.argmin(np.abs(x)))
    k = int(np.argmin(np.abs(z)))
    return y.copy(), dose[k, :, i].copy()


def profile(dose, grid, depth_mm, direction="X"):
    """Perfil a una profundidad (interpolación lineal en profundidad).

    direction 'X' (crossline, eje x DICOM), 'Y' (inline, eje z DICOM) o
    'D' (diagonal en el plano x-z).
    """
    x, y, z = grid.axes()
    j = np.interp(depth_mm, y, np.arange(y.size))
    j0 = int(np.floor(j))
    j1 = min(j0 + 1, y.size - 1)
    t = j - j0
    plane = (1 - t) * dose[:, j0, :] + t * dose[:, j1, :]  # (nz, nx)
    i = int(np.argmin(np.abs(x)))
    k = int(np.argmin(np.abs(z)))
    if direction.upper() == "X":
        return x.copy(), plane[k, :].copy()
    if direction.upper() == "Y":
        return z.copy(), plane[:, i].copy()
    if direction.upper() == "D":
        n = min(x.size, z.size)
        off = (n - 1) // 2
        idx = np.arange(-off, off + 1)
        vals = plane[k + idx, i + idx]
        pos = np.sign(idx) * np.hypot(x[i + idx] - x[i], z[k + idx] - z[k])
        return pos, vals.copy()
    raise ValueError(direction)


def point_dose(dose, grid, depth_mm, x_mm=0.0, z_mm=0.0):
    from scipy.ndimage import map_coordinates
    f = grid.world_to_index(np.array([x_mm, depth_mm, z_mm]))
    return float(map_coordinates(dose, f.reshape(3, 1), order=1)[0])


def compute_water(engine, model, beam, grid):
    rho = np.ones(grid.shape)
    mask = np.ones(grid.shape, dtype=bool)
    D, _, _ = engine.compute_beam_raw(beam, model, rho, grid, mask)
    return D
