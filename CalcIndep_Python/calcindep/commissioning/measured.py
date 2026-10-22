"""Lectura de datos medidos de haz (golden beam data o medidas propias).

Formatos admitidos
------------------
* w2CAD / OmniPro ASCII (.asc), el formato en que Varian distribuye los datos
  representativos para Eclipse. Cada curva va entre $STOM y $ENOM, con
  cabeceras %TYPE (OPD = PDD, OPP = perfil), %FLSZ (campo en mm, "100*100"),
  %SSD (mm), %DPTH (mm, perfiles), %AXIS (X, Y, Z o D) y puntos
  "< x y z valor >" en mm.
* CSV de dos columnas (posición o profundidad, valor). Los metadatos se
  indican en el fichero de configuración del comisionado.
"""
import csv
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np


@dataclass
class Curve:
    kind: str                 # "pdd" o "profile"
    field_x_mm: float
    field_y_mm: float
    ssd_mm: float
    pos_mm: np.ndarray        # profundidad (pdd) o posición (perfil)
    value: np.ndarray
    depth_mm: float = None    # perfiles
    axis: str = "Z"           # X (crossline), Y (inline), D (diagonal), Z (pdd)
    source: str = ""
    meta: dict = field(default_factory=dict)

    @property
    def label(self):
        f = f"{self.field_x_mm / 10:g}x{self.field_y_mm / 10:g}"
        if self.kind == "pdd":
            return f"PDD {f} DFS {self.ssd_mm / 10:g}"
        return f"Perfil {self.axis} {f} prof. {self.depth_mm / 10:g} cm DFS {self.ssd_mm / 10:g}"

    def normalized(self):
        v = np.asarray(self.value, float)
        if self.kind == "pdd":
            return self.pos_mm, v / v.max() * 100.0
        c = np.interp(0.0, self.pos_mm, v)
        return self.pos_mm, v / c * 100.0

    @property
    def is_half(self):
        """Perfil medido solo a un lado del eje (habitual en campos grandes)."""
        if self.kind != "profile":
            return False
        x = np.asarray(self.pos_mm, float)
        return x.min() > -0.1 * max(abs(x.max()), 1.0)

    def normalized_sym(self):
        """Perfil normalizado y simetrizado: si solo hay un lado, se refleja."""
        x, v = self.normalized()
        if self.kind != "profile":
            return x, v
        if self.is_half:
            pos = x >= 0
            xp, vp = x[pos], v[pos]
            return np.concatenate([-xp[::-1], xp]), np.concatenate([vp[::-1], vp])
        if x.max() < 0.1 * abs(x.min()):
            neg = x <= 0
            xn, vn = x[neg], v[neg]
            return np.concatenate([xn, -xn[::-1]]), np.concatenate([vn, vn[::-1]])
        return x, v


def _parse_flsz(s):
    m = re.findall(r"[-+]?\d*\.?\d+", s)
    if len(m) >= 2:
        return float(m[0]), float(m[1])
    if len(m) == 1:
        return float(m[0]), float(m[0])
    return np.nan, np.nan


# Tipos de curva w2CAD/OmniPro. Los de cuña (WDD, WDP, WLP o con %WDGL) no se usan:
# el modelo de haz describe solo campos abiertos.
_PDD_TYPES = {"OPD", "PDD"}
_PROFILE_TYPES = {"OPP", "PRO", "PRF"}
_DIAG_TYPES = {"DPR", "DPP", "OPD_DIAG"}


def read_w2cad(path, skipped=None):
    """Lee las curvas de campo abierto de un fichero w2CAD.

    skipped: lista opcional donde se anotan las curvas descartadas (cuñas,
    tipos desconocidos) como (fichero, tipo, motivo).
    """
    text = Path(path).read_text(encoding="latin-1", errors="ignore")
    curves = []
    blocks = re.split(r"\$STOM", text)[1:]
    for blk in blocks:
        body = blk.split("$ENOM")[0]
        hdr = {}
        pts = []
        for line in body.splitlines():
            line = line.strip()
            if line.startswith("%"):
                parts = line[1:].split(None, 1)
                if parts:
                    hdr[parts[0].upper()] = parts[1].strip() if len(parts) > 1 else ""
            elif line.startswith("<"):
                nums = re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", line)
                if len(nums) >= 4:
                    pts.append([float(v) for v in nums[:4]])
        if not pts:
            continue
        a = np.array(pts)
        typ = hdr.get("TYPE", "").upper()
        fx, fy = _parse_flsz(hdr.get("FLSZ", ""))
        ssd = float(re.findall(r"[-+]?\d*\.?\d+", hdr.get("SSD", "1000"))[0])
        axis = hdr.get("AXIS", "").upper()[:1]
        wedge = ("WDGL" in hdr and hdr.get("WDGL", "").strip() not in ("", "0", "00")) or typ.startswith("W")
        if wedge:
            if skipped is not None:
                skipped.append((Path(path).name, typ, "cuña"))
            continue
        dp = hdr.get("DPTH")
        if typ in _PDD_TYPES or (typ == "" and axis == "Z"):
            depth = a[:, 2]
            o = np.argsort(depth)
            curves.append(Curve("pdd", fx, fy, ssd, depth[o], a[o, 3], axis="Z", source=str(path), meta=hdr))
            continue
        if typ in _PROFILE_TYPES or typ in _DIAG_TYPES or (typ == "" and axis in ("X", "Y")):
            depth = float(re.findall(r"[-+]?\d*\.?\d+", dp)[0]) if dp else float(np.median(a[:, 2]))
            if typ in _DIAG_TYPES or axis == "D":
                # Distancia sobre la diagonal: con una sola coordenada no nula, es esa coordenada.
                if np.allclose(a[:, 1], 0.0):
                    pos = a[:, 0]
                elif np.allclose(a[:, 0], 0.0):
                    pos = a[:, 1]
                else:
                    pos = np.sign(a[:, 0] + a[:, 1]) * np.hypot(a[:, 0], a[:, 1])
                axis = "D"
            elif axis == "Y":
                pos = a[:, 1]
            else:
                axis = "X"
                pos = a[:, 0]
            o = np.argsort(pos)
            curves.append(Curve("profile", fx, fy, ssd, pos[o], a[o, 3], depth_mm=depth, axis=axis,
                                source=str(path), meta=hdr))
            continue
        if skipped is not None:
            skipped.append((Path(path).name, typ or "?", "tipo no reconocido"))
    return curves


def read_two_column(path, scale_pos=1.0):
    text = Path(path).read_text(encoding="utf-8-sig")
    lines = [l for l in text.splitlines() if l.strip()]
    dialect = csv.Sniffer().sniff(lines[0], delimiters=",;\t ")
    x, y = [], []
    for row in csv.reader(lines, dialect):
        row = [r for r in row if r.strip() != ""]
        if len(row) < 2:
            continue
        try:
            x.append(float(row[0]) * scale_pos)
            y.append(float(row[1]))
        except ValueError:
            continue
    x = np.array(x)
    y = np.array(y)
    o = np.argsort(x)
    return x[o], y[o]


def _floats(line):
    out = []
    for t in re.split(r"[,;\t ]+", line.strip()):
        if not t:
            continue
        try:
            out.append(float(t.replace(",", ".")))
        except ValueError:
            return None
    return out


def read_output_factors(path):
    """Lee factores de campo. Devuelve (filas, meta).

    filas: lista de (campo_x_mm, campo_y_mm, factor).
    Formatos admitidos:
    * CSV de tres columnas (campo_x_mm, campo_y_mm, factor) o dos (campo_mm, factor).
    * Tabla 2D de los datos de Varian para Eclipse (p. ej. 06X_00.txt): primera
      línea de cabecera «X06,00,95,100,10,10,...» (energía, cuña, DFS, DAI y
      campo de referencia en cm), segunda línea con los campos X (columnas) y
      después una fila por campo Y con sus factores. Campos en cm.
    """
    text = Path(path).read_text(encoding="utf-8-sig", errors="ignore")
    lines = [l for l in text.splitlines() if l.strip()]
    meta = {"format": "csv"}
    num = [(_floats(l), l) for l in lines]
    numeric = [v for v, _ in num if v]
    # ¿Tabla 2D? Una línea con n campos y varias con n+1 valores.
    if len(numeric) >= 3:
        head = numeric[0]
        body = [v for v in numeric[1:] if len(v) == len(head) + 1]
        if len(head) >= 3 and len(body) >= 2:
            cols = np.array(head, float)
            unit = 10.0 if max(cols.max(), max(r[0] for r in body)) <= 60 else 1.0
            rows = []
            for r in body:
                fy = r[0] * unit
                for fx, f in zip(cols * unit, r[1:]):
                    rows.append((float(fx), float(fy), float(f)))
            meta = {"format": "tabla_2d", "units_cm": unit == 10.0}
            hdr = lines[0].split(",")
            if not _floats(lines[0]) and len(hdr) >= 4:
                try:
                    ssd_cm, sad_cm = float(hdr[2]), float(hdr[3])
                    meta.update(ssd_mm=ssd_cm * 10.0, depth_mm=(sad_cm - ssd_cm) * 10.0, header=lines[0].strip())
                    if len(hdr) >= 6:
                        meta["ref_field_mm"] = (float(hdr[4]) * 10.0, float(hdr[5]) * 10.0)
                except ValueError:
                    pass
            return rows, meta
    rows = []
    for v in numeric:
        if len(v) == 2:
            rows.append((v[0], v[0], v[1]))
        elif len(v) == 3:
            rows.append((v[0], v[1], v[2]))
    return rows, meta


def select_output_factors(rows, max_rect=8):
    """Subconjunto para el ajuste: todos los cuadrados y algunos rectangulares.

    Los rectangulares se eligen con la mayor elongación en ambos sentidos
    (X largo e Y largo) para que el ajuste vea campos estrechos.
    """
    sq = [r for r in rows if abs(r[0] - r[1]) < 1e-6]
    rect = [r for r in rows if abs(r[0] - r[1]) >= 1e-6]
    if not rect:
        return sq
    pick = []
    for long_x in (True, False):
        cand = [r for r in rect if (r[0] > r[1]) == long_x]
        cand.sort(key=lambda r: -max(r[0], r[1]) / min(r[0], r[1]))
        # Variedad de tamaños: se toma uno de cada tamaño corto.
        seen = set()
        for r in cand:
            short = min(r[0], r[1])
            if short in seen:
                continue
            seen.add(short)
            pick.append(r)
            if len([p for p in pick if (p[0] > p[1]) == long_x]) >= max_rect // 2:
                break
    return sq + pick


def _curve_key(c):
    v = np.asarray(c.value, float)
    return (c.kind, round(c.field_x_mm, 1), round(c.field_y_mm, 1), round(c.ssd_mm, 1),
            None if c.depth_mm is None else round(c.depth_mm, 1), c.axis, len(v),
            round(float(v[0]), 3), round(float(v[-1]), 3))


def load_measured(cfg, base_dir, info=None):
    """Carga las curvas indicadas en la sección 'measured' de la configuración.

    info: diccionario opcional donde se anotan las curvas descartadas y repetidas
    y el formato de los factores de campo.
    """
    base = Path(base_dir)
    curves = []
    skipped = []
    files = []
    for f in cfg.get("w2cad", []):
        if str(f) in files:
            continue  # fichero repetido en la lista
        files.append(str(f))
        curves += read_w2cad(base / f, skipped)
    for p in cfg.get("pdd", []):
        sc = 10.0 if p.get("units", "mm") == "cm" else 1.0
        x, y = read_two_column(base / p["file"], sc)
        fx = p.get("field_x_mm", p.get("field_mm"))
        fy = p.get("field_y_mm", p.get("field_mm"))
        curves.append(Curve("pdd", fx, fy, p.get("ssd_mm", 1000.0), x, y, source=p["file"]))
    for p in cfg.get("profiles", []):
        sc = 10.0 if p.get("units", "mm") == "cm" else 1.0
        x, y = read_two_column(base / p["file"], sc)
        fx = p.get("field_x_mm", p.get("field_mm"))
        fy = p.get("field_y_mm", p.get("field_mm"))
        curves.append(Curve("profile", fx, fy, p.get("ssd_mm", 1000.0), x, y,
                            depth_mm=p["depth_mm"], axis=p.get("axis", "X").upper(), source=p["file"]))
    unique, keys, dup = [], set(), 0
    for c in curves:
        k = _curve_key(c)
        if k in keys:
            dup += 1
            continue
        keys.add(k)
        unique.append(c)
    of = None
    of_meta = {}
    if cfg.get("output_factors"):
        o = cfg["output_factors"]
        rows, of_meta = read_output_factors(base / o["file"])
        of = {"rows": rows, "ssd_mm": o.get("ssd_mm", 1000.0),
              "depth_mm": o.get("depth_mm", 100.0), "ref_field_mm": o.get("ref_field_mm", 100.0),
              "meta": of_meta}
    if info is not None:
        info["skipped"] = skipped
        info["duplicates"] = dup
        info["repeated_files"] = len(cfg.get("w2cad", [])) - len(files)
        info["of_meta"] = of_meta
        info["n_of"] = 0 if of is None else len(of["rows"])
    return unique, of


def write_w2cad(path, curves):
    """Escribe curvas en formato w2CAD (para pruebas e intercambio)."""
    out = [f"$NUMS {len(curves):03d}"]
    for c in curves:
        out.append("$STOM")
        out.append("%VERSION 02")
        out.append("%DETY CHA")
        out.append("%BMTY PHO")
        out.append(f"%FLSZ {c.field_x_mm:.0f}*{c.field_y_mm:.0f}")
        out.append(f"%TYPE {'OPD' if c.kind == 'pdd' else 'OPP'}")
        out.append(f"%AXIS {c.axis}")
        out.append(f"%PNTS {len(c.pos_mm)}")
        out.append(f"%SSD {c.ssd_mm:.0f}")
        if c.kind == "profile":
            out.append(f"%DPTH {c.depth_mm:.0f}")
        for p, v in zip(c.pos_mm, c.value):
            if c.kind == "pdd":
                out.append(f"< +000.0 +000.0 {p:+06.1f} {v:+06.2f} >")
            elif c.axis == "X":
                out.append(f"< {p:+06.1f} +000.0 {c.depth_mm:+06.1f} {v:+06.2f} >")
            elif c.axis == "Y":
                out.append(f"< +000.0 {p:+06.1f} {c.depth_mm:+06.1f} {v:+06.2f} >")
            else:
                q = p / np.sqrt(2)
                out.append(f"< {q:+06.1f} {q:+06.1f} {c.depth_mm:+06.1f} {v:+06.2f} >")
        out.append("$ENOM")
    out.append("$ENDF")
    Path(path).write_text("\n".join(out) + "\n", encoding="latin-1")
