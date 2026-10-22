"""Tipos de MLC y parámetros dosimétricos de cada uno.

El RTPLAN no suele indicar el modelo de MLC, pero los límites de las láminas
(LeafPositionBoundaries, en mm en el plano del isocentro) lo identifican sin
ambigüedad. Cada modelo de haz guarda la transmisión, la DLG y el ancho de la
zona lengüeta-ranura de cada MLC, y el cálculo usa los del MLC del plan.
"""
from dataclasses import dataclass

import numpy as np


def _boundaries(start, widths):
    b = [float(start)]
    for n, w in widths:
        for _ in range(n):
            b.append(b[-1] + w)
    return np.array(b)


def millennium120_boundaries():
    """Millennium 120: 60 pares; 10 de 10 mm, 40 de 5 mm y 10 de 10 mm (±200 mm)."""
    return _boundaries(-200.0, [(10, 10.0), (40, 5.0), (10, 10.0)])


def hd120_boundaries():
    """HD120: 60 pares; 14 de 5 mm, 32 de 2.5 mm y 14 de 5 mm (±110 mm)."""
    return _boundaries(-110.0, [(14, 5.0), (32, 2.5), (14, 5.0)])


# Nombre interno -> (nombre para mostrar, función de límites)
MLC_TYPES = {
    "Millennium120": ("Millennium 120", millennium120_boundaries),
    "HD120": ("HD120", hd120_boundaries),
}


def display_name(key):
    return MLC_TYPES.get(key, (key, None))[0]


def identify_mlc(leaf_boundaries, atol_mm=0.05):
    """Devuelve el nombre interno del MLC a partir de los límites de las láminas.

    Lanza ValueError si los límites no corresponden a ningún MLC conocido.
    """
    lb = np.asarray(leaf_boundaries, float)
    for key, (_, fn) in MLC_TYPES.items():
        ref = fn()
        if lb.shape == ref.shape and np.allclose(lb, ref, atol=atol_mm):
            return key
    w = np.diff(lb)
    raise ValueError(
        f"MLC no reconocido: {lb.size - 1} pares de láminas entre {lb[0]:g} y {lb[-1]:g} mm "
        f"(anchos de {w.min():g} a {w.max():g} mm). MLC admitidos: "
        + ", ".join(v[0] for v in MLC_TYPES.values()))


@dataclass
class MLCParams:
    transmission: float = 0.013     # transmisión media (entre láminas y a través de ellas)
    dlg_mm: float = 1.3             # separación dosimétrica de las puntas
    tg_width_mm: float = 0.0        # ancho total de la zona lengüeta-ranura en cada límite; 0: no se modela

    @classmethod
    def from_dict(cls, d):
        return cls(transmission=float(d.get("transmission", 0.013)),
                   dlg_mm=float(d.get("dlg_mm", 1.3)),
                   tg_width_mm=float(d.get("tg_width_mm", 0.0)))

    def to_dict(self):
        return {"transmission": float(self.transmission), "dlg_mm": float(self.dlg_mm),
                "tg_width_mm": float(self.tg_width_mm)}

    def validate(self, name=""):
        lab = f" ({display_name(name)})" if name else ""
        if not 0.0 <= self.transmission <= 0.2:
            raise ValueError(f"Transmisión del MLC{lab} fuera de rango (0-0.2): {self.transmission:g}")
        if not 0.0 <= self.dlg_mm <= 5.0:
            raise ValueError(f"DLG{lab} fuera de rango (0-5 mm): {self.dlg_mm:g}")
        if not 0.0 <= self.tg_width_mm <= 2.0:
            raise ValueError(f"Ancho lengüeta-ranura{lab} fuera de rango (0-2 mm): {self.tg_width_mm:g}")


def tg_rows(yg, res_mm, leaf_boundaries, rows, width_mm):
    """Franja lengüeta-ranura para cada fila del mapa de fluencia.

    La zona de cada límite entre dos láminas tiene un ancho total width_mm
    centrado en el límite. Dentro de ella el punto solo está descubierto
    cuando lo están las dos láminas vecinas. Para cada fila (píxel de alto
    res_mm centrado en yg) devuelve el índice de la lámina vecina (-1 si
    ninguna) y la fracción del píxel que cae en la zona.
    """
    n = yg.size
    nbr = np.full(n, -1, dtype=int)
    frac = np.zeros(n)
    if width_mm <= 0 or rows is None:
        return nbr, frac
    lb = np.asarray(leaf_boundaries, float)
    nleaf = lb.size - 1
    h = 0.5 * width_mm
    for j in range(n):
        r = rows[j]
        if r < 0:
            continue
        p0, p1 = yg[j] - 0.5 * res_mm, yg[j] + 0.5 * res_mm
        best = (0.0, -1)
        for nb, yb in ((r - 1, lb[r]), (r + 1, lb[r + 1])):
            if nb < 0 or nb >= nleaf:
                continue
            ov = min(p1, yb + h) - max(p0, yb - h)
            if ov > best[0]:
                best = (ov, nb)
        if best[1] >= 0:
            nbr[j] = best[1]
            frac[j] = min(best[0] / res_mm, 1.0)
    return nbr, frac
