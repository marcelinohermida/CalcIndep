"""Curva de calibración número CT -> densidad electrónica relativa al agua."""
import csv
from pathlib import Path

import numpy as np

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
EXAMPLE_CURVE = DATA_DIR / "hu_ed" / "curva_ejemplo.csv"


class HUEDCurve:
    """Interpolación lineal por tramos de densidad electrónica relativa (RED).

    Fuera del rango de la tabla se mantiene la pendiente del último tramo y
    la RED nunca es negativa.
    """

    def __init__(self, hu, red, name=""):
        hu = np.asarray(hu, float)
        red = np.asarray(red, float)
        o = np.argsort(hu)
        self.hu = hu[o]
        self.red = red[o]
        if self.hu.size < 2:
            raise ValueError("La curva HU-RED necesita al menos dos puntos")
        if np.any(np.diff(self.hu) <= 0):
            raise ValueError("Valores de HU repetidos en la curva")
        if np.any(np.diff(self.red) < 0):
            raise ValueError("La curva HU-RED debe ser monótona creciente")
        self.name = name

    @classmethod
    def from_csv(cls, path):
        """Lee un CSV con dos columnas: HU y densidad electrónica relativa.

        Admite separador coma, punto y coma o tabulador, y cabecera opcional.
        El separador decimal debe ser el punto.
        """
        text = Path(path).read_text(encoding="utf-8-sig")
        dialect = csv.Sniffer().sniff(text.splitlines()[0] if text else ",", delimiters=",;\t")
        hu, red = [], []
        for row in csv.reader(text.splitlines(), dialect):
            if len(row) < 2:
                continue
            try:
                h, r = float(row[0]), float(row[1])
            except ValueError:
                continue  # cabecera o comentario
            hu.append(h)
            red.append(r)
        return cls(hu, red, name=Path(path).name)

    def __call__(self, hu):
        scalar = np.ndim(hu) == 0
        hu = np.atleast_1d(np.asarray(hu, float))
        out = np.interp(hu, self.hu, self.red)
        lo = hu < self.hu[0]
        hi = hu > self.hu[-1]
        if np.any(lo):
            s = (self.red[1] - self.red[0]) / (self.hu[1] - self.hu[0])
            out[lo] = self.red[0] + s * (hu[lo] - self.hu[0])
        if np.any(hi):
            s = (self.red[-1] - self.red[-2]) / (self.hu[-1] - self.hu[-2])
            out[hi] = self.red[-1] + s * (hu[hi] - self.hu[-1])
        out = np.clip(out, 0.0, None)
        return float(out[0]) if scalar else out

    def table(self):
        return list(zip(self.hu.tolist(), self.red.tolist()))
