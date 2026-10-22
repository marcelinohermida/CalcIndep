"""Rejillas 3D y transformaciones geométricas IEC 61217.

Convenciones
------------
* Coordenadas de paciente DICOM en mm.
* Los volúmenes se guardan como arrays (nz, ny, nx) alineados con los ejes,
  con coordenadas crecientes: x = x0 + i*dx, y = y0 + j*dy, z = z0 + k*dz.
* Sistemas IEC: fijo (f), gantry (g), colimador/BLD (b) y mesa (s).
  Todas las rotaciones IEC se implementan como rotaciones dextrógiras
  alrededor del eje correspondiente.
"""
from dataclasses import dataclass

import numpy as np


@dataclass
class Grid:
    origin: np.ndarray   # (x0, y0, z0) mm, centro del vóxel [0, 0, 0]
    spacing: np.ndarray  # (dx, dy, dz) mm
    shape: tuple         # (nz, ny, nx)

    def __post_init__(self):
        self.origin = np.asarray(self.origin, float)
        self.spacing = np.asarray(self.spacing, float)
        self.shape = tuple(int(s) for s in self.shape)

    @property
    def nx(self):
        return self.shape[2]

    @property
    def ny(self):
        return self.shape[1]

    @property
    def nz(self):
        return self.shape[0]

    def axes(self):
        x = self.origin[0] + self.spacing[0] * np.arange(self.nx)
        y = self.origin[1] + self.spacing[1] * np.arange(self.ny)
        z = self.origin[2] + self.spacing[2] * np.arange(self.nz)
        return x, y, z

    def coords(self):
        """Coordenadas (z, y, x) de todos los vóxeles, cada una (nz, ny, nx)."""
        x, y, z = self.axes()
        return np.meshgrid(z, y, x, indexing="ij")

    def world_to_index(self, pts):
        """pts (..., 3) en (x, y, z) mm -> índices fraccionarios (k, j, i)."""
        pts = np.asarray(pts, float)
        f = (pts - self.origin) / self.spacing
        return f[..., ::-1]

    def voxel_volume_cc(self):
        return float(np.prod(self.spacing)) / 1000.0

    def extent(self):
        x, y, z = self.axes()
        return (x[0], x[-1], y[0], y[-1], z[0], z[-1])

    def crop(self, k0, k1, j0, j1, i0, i1):
        o = self.origin + self.spacing * np.array([i0, j0, k0])
        return Grid(o, self.spacing.copy(), (k1 - k0, j1 - j0, i1 - i0))


def rot_x(t):
    c, s = np.cos(t), np.sin(t)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(t):
    c, s = np.cos(t), np.sin(t)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_z(t):
    c, s = np.cos(t), np.sin(t)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


# Matrices de cambio de base desde el sistema IEC de mesa (Xs, Ys, Zs) a las
# coordenadas DICOM de paciente (x, y, z), según la posición del paciente.
_IEC_TO_DICOM = {
    "HFS": np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float),
    "HFP": np.array([[-1, 0, 0], [0, 0, 1], [0, 1, 0]], float),
    "FFS": np.array([[-1, 0, 0], [0, 0, -1], [0, -1, 0]], float),
    "FFP": np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], float),
}


def iec_table_to_dicom(patient_position):
    pp = (patient_position or "HFS").upper()
    if pp not in _IEC_TO_DICOM:
        raise ValueError(f"Posición de paciente no soportada: {pp}")
    return _IEC_TO_DICOM[pp]


def beam_to_dicom_matrix(gantry_deg, coll_deg, couch_deg, patient_position="HFS"):
    """Matriz 3x3 que lleva vectores del sistema BLD (IEC b) a DICOM.

    En el sistema BLD: Xb, Yb en el plano del isocentro (Xb es la dirección
    de movimiento de las láminas del MLCX y de las mandíbulas X), y Zb apunta
    del isocentro hacia la fuente.
    """
    g = np.deg2rad(gantry_deg)
    c = np.deg2rad(coll_deg)
    t = np.deg2rad(couch_deg)
    m_f_from_b = rot_y(g) @ rot_z(c)          # BLD -> fijo
    m_s_from_f = rot_z(t).T                    # fijo -> mesa
    return iec_table_to_dicom(patient_position) @ m_s_from_f @ m_f_from_b


@dataclass
class BeamGeometry:
    """Geometría de una incidencia (un ángulo de gantry concreto)."""
    iso: np.ndarray            # mm DICOM
    sad: float                 # mm
    gantry: float
    coll: float
    couch: float
    patient_position: str = "HFS"

    def __post_init__(self):
        self.iso = np.asarray(self.iso, float)
        self.m = beam_to_dicom_matrix(self.gantry, self.coll, self.couch,
                                      self.patient_position)

    @property
    def source(self):
        return self.iso + self.m @ np.array([0.0, 0.0, self.sad])

    @property
    def axis(self):
        """Vector unitario de propagación (fuente -> isocentro) en DICOM."""
        return -self.m[:, 2]

    @property
    def u(self):
        return self.m[:, 0]

    @property
    def v(self):
        return self.m[:, 1]

    def to_bev(self, pts):
        """Proyecta puntos DICOM (..., 3) al plano del isocentro.

        Devuelve (xb, yb, dist) donde xb, yb son coordenadas BLD en el plano
        del isocentro (mm) y dist es la distancia a la fuente a lo largo del
        eje (mm).
        """
        p = np.asarray(pts, float) - self.source
        z = p @ self.axis
        xb = (p @ self.u) * self.sad / z
        yb = (p @ self.v) * self.sad / z
        return xb, yb, z
