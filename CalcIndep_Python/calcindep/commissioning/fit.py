"""Ajuste del modelo de haz a datos medidos (golden beam data).

Pasos (cada uno se puede desactivar en la configuración):

1. Espectro: dosis en profundidad de cada energía del kernel para el campo de
   referencia y ajuste por mínimos cuadrados no negativos con regularización
   de suavidad, más la contaminación electrónica en la zona de build-up.
2. Perfil radial de fluencia (cuernos): iteración multiplicativa con el
   perfil del campo mayor a poca profundidad.
3. Ablandamiento fuera de eje: búsqueda en rejilla con el perfil profundo
   del campo mayor.
4. Tamaño de la fuente primaria: búsqueda en rejilla con la penumbra de un
   campo de referencia.
5. Fuente extrafocal (dispersión en el cabezal): ajuste a los factores de
   campo medidos.
6. Calibración de UM y validación con todas las curvas medidas.
"""
import copy
import datetime as _dt
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy.optimize import minimize_scalar, nnls

from ..mlc import MLCParams
from ..beam_model import BeamModel, Calibration, default_model_path
from ..calibration import calibrate
from ..engine import CalcOptions, DoseEngine
from ..fluence import subbeams
from ..physics import mu_rho_water
from ..terma import compute_terma
from ..water import central_axis, point_dose, profile, square_beam, water_grid
from scipy.special import erf

from .measured import load_measured, select_output_factors

log = logging.getLogger(__name__)


def gamma_1d(x_ref, d_ref, x_ev, d_ev, dd=2.0, dta=2.0, threshold=10.0):
    """Gamma 1D global (dosis en %, posiciones en mm). Devuelve gamma por punto."""
    xf = np.arange(x_ev.min(), x_ev.max(), 0.1)
    df = np.interp(xf, x_ev, d_ev)
    norm = max(d_ref.max(), 1e-9)
    g = np.full(d_ref.shape, np.nan)
    for i, (x, d) in enumerate(zip(x_ref, d_ref)):
        if d < threshold / 100 * norm or x < x_ev.min() or x > x_ev.max():
            continue
        sel = np.abs(xf - x) <= 3 * dta
        gg = ((xf[sel] - x) / dta) ** 2 + ((df[sel] - d) / (dd / 100 * norm)) ** 2
        g[i] = np.sqrt(gg.min()) if gg.size else np.nan
    return g


def _soft_label(s, pw):
    if s == 0:
        return "s = 0 (sin ablandamiento)"
    if pw == 1:
        return f"lineal, s = {s:g} cm⁻¹"
    if pw == 2:
        return f"cuadrática, s = {s:g} cm⁻²"
    return f"potencia {pw:g}, s = {s:g}"


@dataclass
class CommissioningConfig:
    machine: str = ""
    energy: str = "6X"
    fluence_mode: str = "STANDARD"
    name: str = ""
    measured: dict = field(default_factory=dict)
    # Parámetros de cada MLC (no se ajustan: valores de la configuración de Eclipse).
    mlc: dict = field(default_factory=lambda: {"Millennium120": MLCParams().to_dict()})
    jaw_transmission: float = 0.001
    calibration: dict = field(default_factory=dict)
    start_model: str = None
    kernel_tilt: bool = True           # inclinar el kernel con la divergencia del haz
    grid_mm: float = 2.5
    steps: dict = field(default_factory=lambda: {"spectrum": True, "econt": True, "horns": True,
                                                  "softening": True, "source": True,
                                                  "output_factors": True})
    reference_field_mm: float = 100.0
    output_model: str = "modelo_comisionado.json"
    report: str = "informe_comisionado.html"
    source_sigma_grid_mm: list = field(default_factory=lambda: [0.3, 0.6, 0.9, 1.2, 1.5, 2.0, 2.5])
    softening_grid: list = field(default_factory=lambda: [0.0, 0.003, 0.006])
    softening_fields_mm: list = field(default_factory=lambda: [100.0, 150.0, 250.0])
    softening_max: float = 0.02        # límite de la ampliación de la búsqueda (cm⁻¹)
    # Formas del ablandamiento que se prueban: 1 lineal mu(1 + s r), 2 cuadrática mu(1 + s r²).
    softening_powers: list = field(default_factory=lambda: [1.0, 2.0])
    softening_grid_quad: list = field(default_factory=lambda: [0.0, 0.00015, 0.0003, 0.00045])
    softening_max_quad: float = 0.0015  # cm⁻²
    extrafocal_sigma_grid_mm: list = field(default_factory=lambda: [6.0, 8.0, 10.0, 12.0, 15.0, 18.0, 22.0,
                                                                     26.0, 30.0, 35.0, 40.0])
    extrafocal_ratio_grid: list = field(default_factory=lambda: [1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0])
    spectrum_smoothing: float = 1e-3
    spectrum_smoothing_grid: list = field(default_factory=lambda: [1e-3, 3e-3, 1e-2, 3e-2, 0.1, 0.3])
    spectrum_rms_tolerance: float = 0.15
    spectrum_fields_mm: list = field(default_factory=lambda: [30.0, 200.0])
    spectrum_refinements: int = 2
    softening_horn_iterations: int = 2

    @classmethod
    def from_json(cls, path):
        d = json.loads(Path(path).read_text(encoding="utf-8"))
        # Configuraciones antiguas: un solo par transmisión/DLG (Millennium 120).
        t_old = d.pop("mlc_transmission", None)
        dlg_old = d.pop("mlc_dlg_mm", None)
        if "mlc" not in d and (t_old is not None or dlg_old is not None):
            p = MLCParams()
            p.transmission = float(t_old) if t_old is not None else p.transmission
            p.dlg_mm = float(dlg_old) if dlg_old is not None else p.dlg_mm
            d["mlc"] = {"Millennium120": p.to_dict()}
        known = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(**known)


class Commissioner:
    def __init__(self, cfg: CommissioningConfig, base_dir=".", progress=print, fraction=None):
        self.cfg = cfg
        self.base = Path(base_dir)
        self.progress = progress
        self.fraction = fraction or (lambda f: None)
        self.load_info = {}
        self.curves, self.of = load_measured(cfg.measured, self.base, self.load_info)
        if not self.curves:
            raise ValueError("No se han encontrado curvas de campo abierto")
        if self.of:
            self.of_fit_rows = select_output_factors(self.of["rows"])
        if cfg.start_model:
            m = BeamModel.from_json(self.base / cfg.start_model)
        else:
            m = BeamModel.from_json(default_model_path())
        m.machine = cfg.machine
        m.energy = cfg.energy
        m.fluence_mode = cfg.fluence_mode
        m.name = cfg.name or f"{cfg.machine} {cfg.energy}{'' if cfg.fluence_mode == 'STANDARD' else ' ' + cfg.fluence_mode}"
        m.mlc = {k: MLCParams.from_dict(v).to_dict() for k, v in (cfg.mlc or {}).items()}
        m.jaw_transmission = cfg.jaw_transmission
        cal = Calibration(**cfg.calibration) if cfg.calibration else Calibration()
        m.calibration = cal
        m.commissioned = False
        m.kernel_tilt = bool(cfg.kernel_tilt)
        self.model = m
        self.engine = DoseEngine(m, CalcOptions())
        self.log = []
        self.timing = {}

    # ------------------------------------------------------------------
    def _note(self, msg):
        self.log.append(msg)
        self.progress(msg)

    def _geometry_for(self, fx, fy, ssd, curves, spacing=None):
        sp = spacing or self.cfg.grid_mm
        dmax = 150.0
        for c in curves:
            if c.kind == "pdd":
                dmax = max(dmax, c.pos_mm.max() + 30.0)
            else:
                dmax = max(dmax, c.depth_mm + 80.0)
        deep = min(dmax, 350.0)
        mag = (ssd + min(deep, 300.0)) / self.model.sad_mm
        lateral = max(fx, fy) * mag + 2 * 55.0
        for c in curves:
            if c.kind == "profile":
                lateral = max(lateral, 2 * np.abs(c.pos_mm).max() / (np.sqrt(2) if c.axis == "D" else 1.0) + 10)
        lateral = max(lateral, 150.0)
        return water_grid(sp, lateral, deep)

    def calc(self, model, fx, fy, ssd, curves=(), grid=None, mlc=None):
        g = grid or self._geometry_for(fx, fy, ssd, curves)
        b = square_beam(fx, fy, ssd_mm=ssd, mu=100.0, energy=model.energy,
                        fluence_mode=model.fluence_mode, mlc=mlc)
        D, _, _ = self.engine.compute_beam_raw(b, model, np.ones(g.shape), g, None)
        return D, g

    def _pdd_ref(self):
        pdds = [c for c in self.curves if c.kind == "pdd"]
        if not pdds:
            raise ValueError("Hace falta al menos una PDD")
        f = self.cfg.reference_field_mm
        return min(pdds, key=lambda c: (abs(np.sqrt(c.field_x_mm * c.field_y_mm) - f), abs(c.ssd_mm - 1000)))

    # ------------------------------------------------------------------
    def _spectrum_curves(self):
        ref = self._pdd_ref()
        pdds = [c for c in self.curves if c.kind == "pdd" and abs(c.ssd_mm - ref.ssd_mm) < 1]
        out = [ref]
        for f in self.cfg.spectrum_fields_mm:
            if not pdds:
                break
            c = min(pdds, key=lambda c: abs(np.sqrt(c.field_x_mm * c.field_y_mm) - f))
            if all(c is not o for o in out) and abs(np.sqrt(c.field_x_mm * c.field_y_mm) - f) <= 0.25 * f:
                out.append(c)
        return out

    def fit_spectrum(self, with_econt=True):
        """Ajuste conjunto del espectro y la contaminación electrónica.

        Para cada PDD f se calcula la dosis en el eje de cada energía (fluencia
        de energía unidad) y de la contaminación electrónica. Incógnitas:
        pesos c_i >= 0, peso de contaminación c_e >= 0 y un factor de escala
        s_f >= 0 por PDD (salvo la de referencia), porque las PDD medidas están
        normalizadas a su máximo.
        """
        curves = self._spectrum_curves()
        self._note("Espectro: PDD usadas " + ", ".join(c.label for c in curves))
        m0 = self.model
        E = m0.energies
        n = E.size
        use_e = with_econt and self.cfg.steps.get("econt", True)
        kvals = (0.25, 0.35, 0.5, 0.7, 1.0, 1.4, 2.0) if use_e else (None,)
        data = []
        for c in curves:
            g = self._geometry_for(c.field_x_mm, c.field_y_mm, c.ssd_mm, [c])
            m_e = copy.deepcopy(m0)
            m_e.econt_weight = 0.0
            cols = []
            for i, e in enumerate(E):
                mi = copy.deepcopy(m_e)
                w = np.zeros(n)
                w[i] = 1.0 / e  # fluencia de energía unidad
                mi.spectrum_weights = w.tolist()
                D, _ = self.calc(mi, c.field_x_mm, c.field_y_mm, c.ssd_mm, grid=g)
                y, p = central_axis(D, g)
                cols.append(p)
            self.progress(f"  {c.label}: dosis por energía calculadas")
            ec = {}
            for k in kvals:
                if k is None:
                    continue
                mk = copy.deepcopy(m0)
                mk.econt_weight = 1.0
                mk.econt_k_per_cm = k
                b = square_beam(c.field_x_mm, c.field_y_mm, ssd_mm=c.ssd_mm, mu=100.0)
                sb = next(subbeams(b, mk))
                _, De = compute_terma(np.ones(g.shape), g, sb.geom, sb.fluence, sb.axes, sb.efluence,
                                      mk.energies, mk.weights, mu_rho_water(mk.energies), ke=k)
                ec[k] = central_axis(De, g)[1]
            zm, pm = c.normalized()
            P = np.interp(y, zm, pm, left=np.nan, right=np.nan)
            zmax = zm[np.argmax(pm)]
            zlo = 3.0 if use_e else zmax + 10.0
            sel = np.isfinite(P) & (y >= zlo) & (y <= min(zm.max(), 300.0))
            data.append({"A": np.column_stack(cols)[sel], "P": P[sel], "ec": {k: v[sel] for k, v in ec.items()},
                         "label": c.label, "curve": c, "grid": g, "sel": sel})
        # Regularización: segunda diferencia del número de fotones (c_i / E_i).
        L = np.zeros((n - 2, n))
        for i in range(n - 2):
            L[i, i:i + 3] = [1, -2, 1]
        L = L @ np.diag(1.0 / E)
        nf = len(data)

        lam_sel = {"v": self.cfg.spectrum_smoothing}

        def solve(k, deltas, lam=None):
            lam = lam_sel["v"] if lam is None else lam
            ne = 1 if k is not None else 0
            ncol = n + ne + (nf - 1)
            rows, rhs = [], []
            for fi, d in enumerate(data):
                M = np.zeros((d["A"].shape[0], ncol))
                M[:, :n] = d["A"]
                if ne:
                    M[:, n] = d["ec"][k]
                if fi == 0:
                    rhs.append(d["P"] - deltas[fi])
                else:
                    M[:, n + ne + fi - 1] = -d["P"]
                    rhs.append(-deltas[fi])
                rows.append(M)
            Mall = np.vstack(rows)
            ball = np.concatenate(rhs)
            scale = np.linalg.norm(Mall[:, :n], axis=0).mean()
            Lr = np.zeros((L.shape[0], ncol))
            Lr[:, :n] = L * lam * scale * np.mean(E)
            x, _ = nnls(np.vstack([Mall, Lr]), np.concatenate([ball, np.zeros(L.shape[0])]), maxiter=10000)
            errs = []
            for fi, d in enumerate(data):
                pred = d["A"] @ x[:n] + (x[n] * d["ec"][k] if ne else 0.0) + deltas[fi]
                sf = 1.0 if fi == 0 else x[n + ne + fi - 1]
                errs.append(float(np.sqrt(np.mean((pred / sf - d["P"]) ** 2))) if sf > 0 else np.inf)
            return x, errs

        def apply(x, k):
            c = x[:n]
            S = c.sum()
            w = c / E
            self.model.spectrum_weights = [float(v) for v in w / w.sum()]
            if k is not None:
                self.model.econt_k_per_cm = float(k)
                self.model.econt_weight = float(x[n] / S)
            return S

        zero = [np.zeros_like(d["P"]) for d in data]
        # Se elige el espectro más suave cuyo error en las PDD no supere el mínimo
        # en más de spectrum_rms_tolerance (puntos porcentuales).
        results = []
        for lam in self.cfg.spectrum_smoothing_grid:
            best = None
            for k in kvals:
                x, errs = solve(k, zero, lam)
                tot = float(np.sqrt(np.mean(np.square(errs))))
                if best is None or tot < best[2]:
                    best = (x, k, tot, errs, lam)
            results.append(best)
        tmin = min(r[2] for r in results)
        ok = [r for r in results if r[2] <= tmin + self.cfg.spectrum_rms_tolerance]
        x, k, tot, errs, lam = max(ok, key=lambda r: r[4])
        lam_sel["v"] = lam
        self.progress("  suavizado del espectro: " + ", ".join(f"λ={r[4]:g} RMS {r[2]:.2f}%" for r in results)
                      + f" → λ={lam:g}")
        S = apply(x, k)
        # Refinamiento: el motor usa un kernel polienergético único, que no es
        # exactamente la suma de los monoenergéticos. Se calcula la diferencia
        # con el motor real y se reajusta con ella como término fijo.
        deltas = zero
        for it in range(self.cfg.spectrum_refinements):
            new = []
            for fi, d in enumerate(data):
                c = d["curve"]
                D, _ = self.calc(self.model, c.field_x_mm, c.field_y_mm, c.ssd_mm, grid=d["grid"])
                pe = central_axis(D, d["grid"])[1][d["sel"]]
                mono = (d["A"] @ x[:n] + (x[n] * d["ec"][k] if k is not None else 0.0)) / S
                new.append(deltas[fi] + S * (pe - (mono + deltas[fi] / S)))
            deltas = new
            x, errs = solve(k, deltas)
            S = apply(x, k)
            self.progress(f"  refinamiento {it + 1}: RMS " + ", ".join(f"{e:.2f} %" for e in errs))
        w = self.model.weights
        self._note("Espectro ajustado: energía media {:.2f} MeV; RMS por PDD: {}; contaminación electrónica "
                   "w = {:.4f}, k = {:g} cm⁻¹".format(np.sum(w * E), ", ".join(
                       f"{d['label']} {e:.2f} %" for d, e in zip(data, errs)),
                       self.model.econt_weight, self.model.econt_k_per_cm))

    # ------------------------------------------------------------------
    def _largest_field_profiles(self):
        prof = [c for c in self.curves if c.kind == "profile" and abs(c.ssd_mm - 1000) < 1]
        if not prof:
            return None, []
        fmax = max(max(c.field_x_mm, c.field_y_mm) for c in prof)
        same = [c for c in prof if max(c.field_x_mm, c.field_y_mm) == fmax]
        return fmax, same

    def fit_horns(self, iterations=3, quiet=False):
        fmax, curves = self._largest_field_profiles()
        if not curves:
            self._note("Cuernos: no hay perfiles a DFS 100; se omite")
            return
        depths = sorted({c.depth_mm for c in curves})
        d0 = min([d for d in depths if d >= 10.0] or depths)
        sel = [c for c in curves if c.depth_mm == d0]
        if not quiet:
            self._note(f"Perfil radial: campo {fmax / 10:g} cm, profundidad {d0 / 10:g} cm, "
                       f"{len(sel)} perfiles ({', '.join(c.axis for c in sel)})")
        m = self.model
        rmax = max(np.abs(c.pos_mm).max() for c in sel) * m.sad_mm / (1000.0 + d0)
        nodes = np.arange(0.0, max(rmax, 50.0) + 20.0, 20.0)
        f0 = [float(m.oa(r)) for r in nodes]
        m.oa_radius_mm = nodes.tolist()
        m.oa_factor = f0
        g = None
        for it in range(iterations):
            D, g = self.calc(m, fmax, fmax, 1000.0, curves, grid=g)
            ratios = []
            weights = []
            for c in sel:
                xm, vm = c.normalized_sym()   # perfiles medidos a un solo lado: se reflejan
                xc, vc = profile(D, g, d0, c.axis)
                vc = vc / np.interp(0.0, xc, vc) * 100.0
                half = 0.5 * (c.field_x_mm if c.axis in ("X", "D") else c.field_y_mm) * (1000.0 + d0) / m.sad_mm
                if c.axis == "D":
                    half *= np.sqrt(2)
                rr = []
                rpc = m.primary_collimator_radius_mm
                for r in nodes:
                    p = r * (1000.0 + d0) / m.sad_mm
                    lim = half - 15.0
                    if rpc > 0:
                        lim = min(lim, (rpc - 2.5 * m.primary_collimator_sigma_mm) * (1000.0 + d0) / m.sad_mm)
                    if p > lim:
                        rr.append(np.nan)
                        continue
                    a = [np.interp(s * p, xm, vm) / max(np.interp(s * p, xc, vc), 1e-9) for s in (-1, 1)]
                    rr.append(np.mean(a))
                ratios.append(rr)
            Ra = np.array(ratios, float)
            cnt = np.isfinite(Ra).sum(axis=0)
            R = np.where(cnt > 0, np.nansum(Ra, axis=0) / np.maximum(cnt, 1), np.nan)
            ok = np.isfinite(R)
            if not ok.any():
                break
            last = np.nonzero(ok)[0][-1]
            R[~ok] = R[last]
            R = R / R[0]
            f = np.asarray(m.oa_factor) * R
            f = f / f[0]
            m.oa_factor = [float(v) for v in f]
            if not quiet:
                self.progress(f"  iteración {it + 1}: corrección máxima {np.nanmax(np.abs(R - 1)) * 100:.2f} %")
        if not quiet:
            self._note("Perfil radial ajustado: " + ", ".join(f"{r:.0f} mm: {v:.3f}"
                                                             for r, v in zip(m.oa_radius_mm, m.oa_factor)))

    def fit_primary_collimator(self):
        """Radio y penumbra del colimador primario a partir de los perfiles diagonales.

        Se usan los perfiles diagonales cuya esquina de mandíbulas queda fuera del
        colimador primario: allí el borde del campo (50 %) lo define el colimador
        primario. Radio en el isocentro = posición del 50 % / factor de divergencia.
        """
        m = self.model
        est = []
        for c in self.curves:
            if c.kind != "profile" or c.axis != "D":
                continue
            x, v = c.normalized_sym()
            pos = x >= 0
            x, v = x[pos], v[pos]
            mag = (c.ssd_mm + c.depth_mm) / m.sad_mm
            corner = 0.5 * np.hypot(c.field_x_mm, c.field_y_mm) * mag
            below = np.nonzero(v < 50.0)[0]
            if below.size == 0 or below[0] == 0:
                continue
            i = below[0]
            x50 = float(np.interp(50.0, [v[i], v[i - 1]], [x[i], x[i - 1]]))
            if x50 > 0.95 * corner:
                continue   # el borde lo definen las mandíbulas
            def cross(level):
                j = np.nonzero(v < level)[0]
                j = j[0] if j.size else len(v) - 1
                return float(np.interp(level, [v[j], v[j - 1]], [x[j], x[j - 1]])) if j > 0 else np.nan
            w8020 = cross(20.0) - cross(80.0)
            est.append((c.depth_mm, x50 / mag, w8020 / mag))
        if not est:
            self._note("Colimador primario: no hay perfiles diagonales de campos grandes; no se modela")
            return
        est.sort()
        radii = [e[1] for e in est]
        r_pc = float(np.median(radii))
        # Penumbra: perfil menos profundo, descontando unos 3.5 mm de la penumbra en agua.
        s_tot = est[0][2] / 1.683
        s_pc = float(np.sqrt(max(s_tot ** 2 - 3.5 ** 2, 1.0)))
        m.primary_collimator_radius_mm = round(r_pc, 1)
        m.primary_collimator_sigma_mm = round(s_pc, 1)
        self._note(f"Colimador primario: radio {r_pc:.1f} mm en el isocentro (dispersión entre profundidades "
                   f"{min(radii):.1f}–{max(radii):.1f} mm), σ de penumbra {s_pc:.1f} mm; "
                   f"{len(est)} perfiles diagonales")

    def _profile_error(self, D, g, curves, core=0.8, edge=False):
        errs = []
        for c in curves:
            xm, vm = c.normalized()
            xc, vc = profile(D, g, c.depth_mm, c.axis)
            vc = vc / np.interp(0.0, xc, vc) * 100.0
            fs = c.field_x_mm if c.axis in ("X", "D") else c.field_y_mm
            half = 0.5 * fs * (c.ssd_mm + c.depth_mm) / self.model.sad_mm
            if c.axis == "D":
                half *= np.sqrt(2)
            if edge:
                sel = (np.abs(np.abs(xm) - half) <= 12.0)
            else:
                sel = np.abs(xm) <= core * half
            if sel.sum() < 3:
                continue
            d = np.interp(xm[sel], xc, vc) - vm[sel]
            errs.append(np.sqrt(np.mean(d ** 2)))
        return float(np.mean(errs)) if errs else np.nan

    def fit_softening(self):
        """Busca el ablandamiento reajustando los cuernos para cada valor."""
        fmax, curves = self._largest_field_profiles()
        if not curves:
            return
        deep = [c for c in curves if c.depth_mm >= 150.0]
        if not deep:
            self._note("Ablandamiento: no hay perfiles profundos del campo mayor; se mantiene el valor inicial")
            return
        # Además del campo mayor, perfiles profundos de campos intermedios: el ablandamiento
        # y el perfil radial están acoplados y, ajustados solo con el campo mayor, los
        # campos de 10–20 cm quedan bajos fuera del eje en profundidad.
        prof = [c for c in self.curves if c.kind == "profile" and abs(c.ssd_mm - 1000) < 1
                and c.depth_mm >= 150.0 and c.axis in ("X", "Y")]
        sets = [(fmax, fmax, curves, deep)]
        for f in self.cfg.softening_fields_mm:
            cand = [c for c in prof if abs(c.field_x_mm - c.field_y_mm) < 1]
            if not cand:
                break
            fx = min({c.field_x_mm for c in cand}, key=lambda v: abs(v - f))
            if abs(fx - f) > 0.25 * f or any(abs(fx - st[0]) < 1 for st in sets):
                continue
            sel = [c for c in cand if c.field_x_mm == fx]
            sets.append((fx, fx, sel, sel))
        if len(sets) > 1:
            self._note("Ablandamiento: perfiles profundos de los campos "
                       + ", ".join(f"{st[0] / 10:g}x{st[1] / 10:g}" for st in sets))
        grids = {}
        base = copy.deepcopy(self.model)
        tried = {}

        def evaluate(pw, sv):
            sv = round(float(sv), 8)
            key = (1.0, 0.0) if sv == 0.0 else (pw, sv)   # s = 0 es igual para cualquier forma
            if key in tried:
                return tried[key][0]
            self.model = copy.deepcopy(base)
            self.model.softening_per_cm = sv
            self.model.softening_power = key[0]
            self.fit_horns(iterations=self.cfg.softening_horn_iterations, quiet=True)
            errs = []
            for fx, fy, cv, ev in sets:
                D, g = self.calc(self.model, fx, fy, 1000.0, cv, grid=grids.get(fx))
                grids[fx] = g
                errs.append(self._profile_error(D, g, ev))
            e = float(np.nanmean(errs))
            detail = ", ".join(f"{st[0] / 10:g}: {v:.2f}" for st, v in zip(sets, errs))
            self.progress(f"  {_soft_label(sv, key[0])}: RMS perfiles profundos {e:.2f} % ({detail})")
            tried[key] = (e, copy.deepcopy(self.model))
            return e

        def search(pw, grid, smax):
            grid = sorted(float(v) for v in grid)
            for sv in grid:
                evaluate(pw, sv)

            def mine():
                ks = sorted(k[1] for k in tried if k[0] == pw or k == (1.0, 0.0))
                vals = {k: tried[(1.0, 0.0) if k == 0.0 else (pw, k)][0] for k in ks}
                return ks, vals
            # Si el mínimo está en el extremo superior, se amplía la búsqueda.
            step = grid[-1] - grid[-2] if len(grid) > 1 else grid[-1]
            while True:
                ks, vals = mine()
                kb = min(ks, key=lambda k: vals[k])
                if kb != ks[-1] or ks[-1] + step > smax + 1e-12:
                    break
                evaluate(pw, ks[-1] + step)
            # Interpolación parabólica alrededor del mínimo (una evaluación más).
            ks, vals = mine()
            i = ks.index(min(ks, key=lambda k: vals[k]))
            if 0 < i < len(ks) - 1:
                x0, x1, x2 = ks[i - 1:i + 2]
                y0, y1, y2 = vals[x0], vals[x1], vals[x2]
                den = (x0 - x1) * (x0 - x2) * (x1 - x2)
                a = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / den
                b = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / den
                if a > 0:
                    xv = -b / (2 * a)
                    if x0 < xv < x2 and abs(xv - x1) > 0.1 * step:
                        evaluate(pw, float(f"{xv:.2g}"))

        forms = {1.0: (self.cfg.softening_grid, self.cfg.softening_max),
                 2.0: (self.cfg.softening_grid_quad, self.cfg.softening_max_quad)}
        for pw in self.cfg.softening_powers:
            if float(pw) in forms:
                search(float(pw), *forms[float(pw)])
        kbest = min(tried, key=lambda k: tried[k][0])
        self.model = tried[kbest][1]
        by_form = {}
        for k, (e, _) in tried.items():
            if k[1] > 0 and (k[0] not in by_form or e < by_form[k[0]][1]):
                by_form[k[0]] = (k[1], e)
        cmp_txt = "; ".join(f"mejor {('lineal' if pw == 1 else 'cuadrática')}: {_soft_label(v, pw)} "
                            f"({e:.2f} %)" for pw, (v, e) in sorted(by_form.items()))
        self._note(f"Ablandamiento fuera de eje: {_soft_label(kbest[1], kbest[0])} (RMS perfiles profundos "
                   f"{tried[kbest][0]:.2f} %); perfil radial reajustado" + (f". {cmp_txt}" if len(by_form) > 1 else ""))

    def fit_source(self):
        f = self.cfg.reference_field_mm
        prof = [c for c in self.curves if c.kind == "profile" and abs(c.ssd_mm - 1000) < 1
                and c.axis in ("X", "Y")]
        if not prof:
            return
        fsel = min({c.field_x_mm for c in prof}, key=lambda v: abs(v - f))
        sel = [c for c in prof if c.field_x_mm == fsel]
        best = None
        g = None
        for s in self.cfg.source_sigma_grid_mm:
            m = copy.deepcopy(self.model)
            m.primary_sigma_mm = float(s)
            D, g = self.calc(m, fsel, sel[0].field_y_mm, 1000.0, sel, grid=g)
            e = self._profile_error(D, g, sel, edge=True)
            self.progress(f"  sigma = {s:g} mm: RMS penumbra {e:.2f} %")
            if best is None or e < best[1]:
                best = (s, e)
        self.model.primary_sigma_mm = float(best[0])
        self._note(f"Tamaño de fuente primaria: sigma = {best[0]:g} mm en el isocentro "
                   f"(RMS en penumbra {best[1]:.2f} %, campo {fsel / 10:g} cm)")

    def _of_dose(self, model, fx, fy, ssd, depth, spacing=None):
        sp = spacing or self.cfg.grid_mm
        g = water_grid(sp, fx * 1.2 + 100.0, depth + 100.0, lateral_z_mm=fy * 1.2 + 100.0)
        D, _ = self.calc(model, fx, fy, ssd, grid=g)
        return point_dose(D, g, depth)

    def fit_output_factors(self):
        """Fuente extrafocal anisótropa (σx, σy, w) ajustada a los factores de campo.

        1. Dosis en el eje sin fuente extrafocal, Dp, para un subconjunto de campos.
        2. Búsqueda en rejilla de (σx, σy/σx) con la aproximación
           D ≈ Dp (1 + w g), g = erf(X / (2√2 σx)) erf(Y / (2√2 σy)),
           que es la fluencia extrafocal relativa en el eje; w por mínimos cuadrados.
        3. Para los σ elegidos, dosis extrafocal exacta con el motor y reajuste de w.
        """
        if not self.of:
            self._note("Factores de campo: no hay datos; se mantiene la fuente extrafocal inicial")
            return
        ssd = self.of["ssd_mm"]
        depth = self.of["depth_mm"]
        fref = self.of.get("ref_field_mm", 100.0)
        rows = list(self.of_fit_rows)
        allm = {(r[0], r[1]): r[2] for r in self.of["rows"]}
        mref = allm.get((fref, fref), 1.0)
        meas = {(r[0], r[1]): r[2] / mref for r in rows}
        fields = sorted(set(meas) | {(fref, fref)})
        self._note(f"Factores de campo: {len(self.of['rows'])} campos en la tabla, {len(meas)} usados en el ajuste "
                   f"(DFS {ssd / 10:g} cm, profundidad {depth / 10:g} cm)")
        mp = copy.deepcopy(self.model)
        mp.extrafocal_weight = 0.0
        Dp = {}
        for k, (fx, fy) in enumerate(fields):
            Dp[(fx, fy)] = self._of_dose(mp, fx, fy, ssd, depth)
            self.progress(f"  campo {fx / 10:g}x{fy / 10:g}: dosis sin fuente extrafocal ({k + 1}/{len(fields)})")
        keys = [k for k in meas]

        def gfac(fx, fy, sx, sy):
            return erf(fx / (2 * np.sqrt(2) * sx)) * erf(fy / (2 * np.sqrt(2) * sy))

        def rms_for(w, De):
            ref = Dp[(fref, fref)] + w * De[(fref, fref)]
            d = [((Dp[k] + w * De[k]) / ref - meas[k]) / meas[k] for k in keys]
            return float(np.sqrt(np.mean(np.square(d))))

        best = None
        for sx in self.cfg.extrafocal_sigma_grid_mm:
            for ratio in self.cfg.extrafocal_ratio_grid:
                sy = sx * ratio
                De = {k: Dp[k] * gfac(k[0], k[1], sx, sy) for k in fields}
                r = minimize_scalar(lambda w: rms_for(w, De), bounds=(0.0, 0.5), method="bounded")
                if best is None or r.fun < best[3]:
                    best = (sx, sy, r.x, r.fun)
        sx, sy, w0, e0 = best
        self.progress(f"  aproximación: σx = {sx:g} mm, σy = {sy:g} mm, w = {w0:.4f}, RMS {e0 * 100:.2f} %")
        # Dosis extrafocal exacta para los σ elegidos.
        me = copy.deepcopy(self.model)
        me.primary_weight = 0.0
        me.extrafocal_weight = 1.0
        me.extrafocal_sigma_mm = float(sx)
        me.extrafocal_sigma_y_mm = float(sy)
        De = {}
        for k, (fx, fy) in enumerate(fields):
            De[(fx, fy)] = self._of_dose(me, fx, fy, ssd, depth, spacing=5.0)
            self.progress(f"  campo {fx / 10:g}x{fy / 10:g}: dosis de la fuente extrafocal ({k + 1}/{len(fields)})")
        r = minimize_scalar(lambda w: rms_for(w, De), bounds=(0.0, 0.5), method="bounded")
        self.model.extrafocal_sigma_mm = float(sx)
        self.model.extrafocal_sigma_y_mm = float(sy)
        self.model.extrafocal_weight = float(r.x)
        self._note(f"Fuente extrafocal: w = {r.x:.4f}, σx = {sx:g} mm, σy = {sy:g} mm "
                   f"(RMS factores de campo {r.fun * 100:.2f} %)")

    # ------------------------------------------------------------------
    def validate(self):
        """Calcula todas las combinaciones (campo, DFS) medidas con el modelo final."""
        groups = {}
        for c in self.curves:
            groups.setdefault((c.field_x_mm, c.field_y_mm, c.ssd_mm), []).append(c)
        results = []
        for (fx, fy, ssd), cs in sorted(groups.items()):
            self.progress(f"Validación: campo {fx / 10:g}x{fy / 10:g} DFS {ssd / 10:g}")
            D, g = self.calc(self.model, fx, fy, ssd, cs)
            for c in cs:
                xm, vm = c.normalized()
                if c.kind == "pdd":
                    xc, vc = central_axis(D, g)
                    vc = vc / vc.max() * 100.0
                else:
                    xc, vc = profile(D, g, c.depth_mm, c.axis)
                    vc = vc / np.interp(0.0, xc, vc) * 100.0
                gm = gamma_1d(xm, vm, xc, vc, 2.0, 2.0)
                diff = np.interp(xm, xc, vc) - vm
                if c.kind == "pdd":
                    zmax = xm[np.argmax(vm)]
                    core = xm >= zmax
                else:
                    fsz = c.field_x_mm if c.axis in ("X", "D") else c.field_y_mm
                    half = 0.5 * fsz * (c.ssd_mm + c.depth_mm) / self.model.sad_mm * (np.sqrt(2) if c.axis == "D" else 1)
                    core = np.abs(xm) <= 0.8 * half
                results.append({
                    "curve": c, "x_calc": xc, "v_calc": vc,
                    "gamma_pass": float(np.mean(gm[np.isfinite(gm)] <= 1) * 100) if np.isfinite(gm).any() else np.nan,
                    "max_abs_diff_core": float(np.nanmax(np.abs(diff[core]))) if core.any() else np.nan,
                    "pdd10_meas": float(np.interp(100.0, xm, vm)) if c.kind == "pdd" else None,
                    "pdd10_calc": float(np.interp(100.0, xc, vc)) if c.kind == "pdd" else None,
                })
        of_res = []
        if self.of:
            ssd, depth = self.of["ssd_mm"], self.of["depth_mm"]
            fref = self.of.get("ref_field_mm", 100.0)
            vals = {}
            vrows = self.of_fit_rows
            for fx, fy, _ in vrows + [(fref, fref, None)]:
                if (fx, fy) in vals:
                    continue
                self.progress(f"Validación: factor de campo {fx / 10:g}x{fy / 10:g}")
                vals[(fx, fy)] = self._of_dose(self.model, fx, fy, ssd, depth)
            mref = {(r[0], r[1]): r[2] for r in self.of["rows"]}.get((fref, fref), 1.0)
            for fx, fy, v in vrows:
                calc = vals[(fx, fy)] / vals[(fref, fref)]
                meas = v / mref
                of_res.append({"fx": fx, "fy": fy, "meas": meas, "calc": calc, "diff_pct": (calc - meas) / meas * 100})
        return results, of_res

    # ------------------------------------------------------------------
    def run(self):
        t0 = time.time()
        st = self.cfg.steps
        # Peso aproximado de cada fase en el tiempo total (para la barra de progreso).
        steps = [("primary_collimator", self.fit_primary_collimator, 0.0),
                 ("spectrum", self.fit_spectrum, 0.35), ("output_factors", self.fit_output_factors, 0.12),
                 ("horns", self.fit_horns, 0.08), ("softening", self.fit_softening, 0.15),
                 ("source", self.fit_source, 0.10)]
        final_w = 0.08
        end_w = 0.12
        total = sum(w for k, fn, w in steps if st.get(k, True)) + final_w + end_w
        acc = 0.0
        self.fraction(0.0)
        li = self.load_info
        npdd = sum(c.kind == "pdd" for c in self.curves)
        self._note(f"Curvas de campo abierto: {len(self.curves)} ({npdd} PDD, {len(self.curves) - npdd} perfiles; "
                   f"{sum(c.is_half for c in self.curves)} perfiles medidos a un solo lado)")
        if li.get("skipped"):
            from collections import Counter
            cnt = Counter(t for _, t, _ in li["skipped"])
            self._note("Curvas descartadas (cuñas u otros tipos): " + ", ".join(f"{k} {v}" for k, v in cnt.items()))
        if li.get("repeated_files"):
            self._note(f"Ficheros repetidos en la lista: {li['repeated_files']} (se leen una vez)")
        if li.get("duplicates"):
            self._note(f"Curvas repetidas descartadas: {li['duplicates']}")
        om = li.get("of_meta") or {}
        if om.get("format") == "tabla_2d":
            self._note(f"Factores de campo: tabla 2D de Varian ({li.get('n_of', 0)} combinaciones X×Y, cabecera "
                       f"«{om.get('header', '')}»)")
            if "ssd_mm" in om and (abs(om["ssd_mm"] - self.of["ssd_mm"]) > 1 or
                                   abs(om["depth_mm"] - self.of["depth_mm"]) > 1):
                self._note(f"Aviso: la cabecera indica DFS {om['ssd_mm'] / 10:g} cm y profundidad "
                           f"{om['depth_mm'] / 10:g} cm, distintas de las de la configuración; se usan las de la "
                           "cabecera")
                self.of["ssd_mm"], self.of["depth_mm"] = om["ssd_mm"], om["depth_mm"]
        for key, fn, w in steps:
            if st.get(key, True):
                t = time.time()
                fn()
                self.timing[key] = time.time() - t
                acc += w
                self.fraction(acc / total)
        if st.get("horns", True) and st.get("source", True):
            self._note("Reajuste final del perfil radial")
            self.fit_horns(iterations=2)
            if st.get("output_factors", True) and self.of:
                self._note("Reajuste final de la fuente extrafocal")
                self.fit_output_factors()
        acc += final_w
        self.fraction(acc / total)
        self._note("Calibración de UM")
        calibrate(self.model, spacing_mm=self.cfg.grid_mm, engine=self.engine)
        self._note(f"cGy por unidad interna: {self.model.calibration.cgy_per_unit:.5g}")
        val, of_res = self.validate()
        self.fraction(1.0)
        self.model.commissioned = True
        self.model.notes = (f"Comisionado automático {_dt.date.today().isoformat()} con "
                            f"{len(self.curves)} curvas medidas. Revise el informe de comisionado.")
        self.timing["total"] = time.time() - t0
        return val, of_res
