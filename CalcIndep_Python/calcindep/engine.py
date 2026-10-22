"""Motor de cálculo: densidad, TERMA, superposición y suma por haces."""
import logging
import time
from dataclasses import dataclass, field

import numpy as np
from scipy.ndimage import map_coordinates

from .beam_model import BeamModel, BeamModelLibrary
from . import gpu as _gpu
from .dicom_io import rasterize
from .fluence import subbeam_angles, subbeams
from .geometry import Grid
from .mlc import display_name
from .kernels import build_cone_set, load_edk, polyenergetic_kernel
from .physics import mu_rho_water
from .terma import compute_terma

log = logging.getLogger(__name__)

AIR_RED = 0.001


class Cancelled(Exception):
    """El usuario ha cancelado el cálculo."""


@dataclass
class CalcOptions:
    fluence_res_mm: float = 0.5
    max_gantry_step_deg: float = 2.0
    sector_deg: float = 10.0          # agrupación de incidencias de arco para la superposición
    ray_spacing_mm: float = None      # por defecto el tamaño de vóxel (máx. 2.5 mm)
    line_spacing_mm: float = None     # separación entre líneas de transporte
    step_mm: float = None             # paso a lo largo de las líneas
    density_supersampling: int = 3
    outside_external: str = "air"     # "air" o "ct"
    keep_support_structures: bool = True
    apply_structure_overrides: bool = True
    margin_mm: float = 20.0
    # Densidades asignadas por nombre de estructura: {"Couch": {"hu": -300}} o {"Bolus": {"red": 1.0}}
    structure_overrides: dict = field(default_factory=dict)
    trace_full_ct: bool = True        # trazar el TERMA a través de todo el CT
    kernel_tilt: bool = True          # inclinar el kernel con la divergencia del haz
    tilt_tile_deg: float = 10.0       # separación angular de las direcciones nodales (grados vistos desde la fuente)
    tilt_min_halfangle_deg: float = 4.5  # por debajo (campos de menos de ~16 cm) no se divide
    tilt_coarse_mm: float = 5.0       # rejilla de la corrección por inclinación (la diferencia es suave)
    # Superposición en GPU: None (ajuste de la aplicación), "auto", "cpu" o el nombre de una GPU.
    gpu: str = None


@dataclass
class BeamResult:
    number: int
    name: str
    mu: float
    technique: str
    model: str
    dose_gy: np.ndarray          # dosis por fracción en la rejilla de cálculo
    n_subbeams: int
    n_superpositions: int
    seconds: float
    warnings: list = field(default_factory=list)
    mlc: str = ""                # MLC identificado y parámetros usados


class ConeCache:
    def __init__(self, edk=None):
        self.edk = edk or load_edk()
        self._c = {}

    def get(self, model: BeamModel):
        key = (tuple(np.round(model.weights, 6)), model.kernel_weight_depth_cm, model.kernel_components)
        if key not in self._c:
            k = polyenergetic_kernel(self.edk, model.energies, model.weights, model.kernel_weight_depth_cm)
            self._c[key] = build_cone_set(k, self.edk.angle_edges, self.edk.radius_edges,
                                          n_comp=model.kernel_components)
        return self._c[key]


# ----------------------------------------------------------------------------
# Densidad
# ----------------------------------------------------------------------------
def resample_red(ct, curve, grid, supersampling=3):
    """Densidad electrónica relativa media de cada vóxel de la rejilla de cálculo."""
    red_ct = curve(ct.data).astype(np.float32)
    n = max(1, int(supersampling))
    offs = (np.arange(n) + 0.5) / n - 0.5
    x, y, z = grid.axes()
    acc = np.zeros(grid.shape, dtype=np.float64)
    for oz in offs:
        for oy in offs:
            for ox in offs:
                zz = z + oz * grid.spacing[2]
                yy = y + oy * grid.spacing[1]
                xx = x + ox * grid.spacing[0]
                fk = (zz - ct.grid.origin[2]) / ct.grid.spacing[2]
                fj = (yy - ct.grid.origin[1]) / ct.grid.spacing[1]
                fi = (xx - ct.grid.origin[0]) / ct.grid.spacing[0]
                K, J, I = np.meshgrid(fk, fj, fi, indexing="ij")
                acc += map_coordinates(red_ct, [K, J, I], order=1, mode="constant", cval=AIR_RED)
    return acc / n ** 3


def calc_grid_from(reference_grid, external_mask=None, margin_mm=20.0):
    """Recorta una rejilla al volumen del External más un margen."""
    if external_mask is None or not external_mask.any():
        return reference_grid, (0, reference_grid.nz, 0, reference_grid.ny, 0, reference_grid.nx)
    kk, jj, ii = np.nonzero(external_mask)
    m = np.ceil(margin_mm / reference_grid.spacing).astype(int)
    k0, k1 = max(0, kk.min() - m[2]), min(reference_grid.nz, kk.max() + m[2] + 1)
    j0, j1 = max(0, jj.min() - m[1]), min(reference_grid.ny, jj.max() + m[1] + 1)
    i0, i1 = max(0, ii.min() - m[0]), min(reference_grid.nx, ii.max() + m[0] + 1)
    return reference_grid.crop(k0, k1, j0, j1, i0, i1), (k0, k1, j0, j1, i0, i1)


def build_density(ct, curve, grid, structures=None, options=None):
    """Mapa de densidad electrónica en la rejilla de cálculo y máscara de cálculo."""
    o = options or CalcOptions()
    rho = resample_red(ct, curve, grid, o.density_supersampling)
    info = {"overrides": [], "external": None, "support": []}
    calc_mask = np.ones(grid.shape, dtype=bool)
    if structures:
        ext = [s for s in structures if s.type == "EXTERNAL"]
        if ext:
            em = rasterize(ext[0], grid)
            info["external"] = ext[0].name
            keep = em.copy()
            if o.keep_support_structures:
                for s in structures:
                    if s.type == "SUPPORT":
                        sm = rasterize(s, grid)
                        keep |= sm
                        info["support"].append(s.name)
            if o.outside_external == "air":
                rho[~keep] = AIR_RED
            calc_mask = keep
        _apply_overrides(rho, grid, structures, curve, o, info)
    return rho, calc_mask, info


def _apply_overrides(rho, grid, structures, curve, o, info):
    by_name = {s.name: s for s in structures}
    if o.apply_structure_overrides:
        for s in structures:
            if s.rel_elec_density is not None and s.type not in ("EXTERNAL",) and s.name not in o.structure_overrides:
                sm = rasterize(s, grid)
                rho[sm] = s.rel_elec_density
                info["overrides"].append((s.name, s.rel_elec_density))
    for name, val in (o.structure_overrides or {}).items():
        s = by_name.get(name)
        if s is None:
            info.setdefault("missing_overrides", []).append(name)
            continue
        red = float(val["red"]) if "red" in val else float(curve(float(val["hu"])))
        rho[rasterize(s, grid)] = red
        info["overrides"].append((name, red))


def build_trace_density(ct, curve, structures, spacing_mm, options=None):
    """Densidad en todo el volumen del CT para el trazado de rayos del TERMA."""
    o = options or CalcOptions()
    x0, x1, y0, y1, z0, z1 = ct.grid.extent()
    sp = np.full(3, float(spacing_mm))
    n = np.floor(np.array([x1 - x0, y1 - y0, z1 - z0]) / sp).astype(int) + 1
    g = Grid([x0, y0, z0], sp, (n[2], n[1], n[0]))
    rho = resample_red(ct, curve, g, supersampling=1)
    info = {"overrides": []}
    if structures:
        ext = [s for s in structures if s.type == "EXTERNAL"]
        if ext and o.outside_external == "air":
            keep = rasterize(ext[0], g)
            if o.keep_support_structures:
                for s in structures:
                    if s.type == "SUPPORT":
                        keep |= rasterize(s, g)
            rho[~keep] = AIR_RED
        _apply_overrides(rho, g, structures, curve, o, info)
    return rho, g


# ----------------------------------------------------------------------------
# Cálculo
# ----------------------------------------------------------------------------
def _frame(axis, ref_u):
    w = axis / np.linalg.norm(axis)
    u = ref_u - (ref_u @ w) * w
    if np.linalg.norm(u) < 1e-6:
        u = np.cross(w, [1.0, 0.0, 0.0])
    u /= np.linalg.norm(u)
    v = np.cross(w, u)
    return u, v, w


class DoseEngine:
    def __init__(self, models, options=None, edk=None):
        if isinstance(models, BeamModel):
            models = BeamModelLibrary([models])
        self.library = models
        self.options = options or CalcOptions()
        self.cones = ConeCache(edk)
        # Modelo asignado explícitamente a un haz: {número de haz: BeamModel}
        self.assignments = {}
        # Llamada tras cada superposición: step_callback(haz, hechas, total).
        # Puede lanzar Cancelled para interrumpir el cálculo.
        self.step_callback = None
        self._backend = None

    @property
    def backend(self):
        """Dónde se hace la superposición (GPU o CPU), según CalcOptions.gpu y el ordenador."""
        if self._backend is None:
            self._backend = _gpu.get_backend(self.options.gpu)
        return self._backend

    def prepare_backend(self, progress=None):
        """Elige el dispositivo antes de calcular (la primera vez con una GPU, la comprueba)."""
        if self._backend is None:
            self._backend = _gpu.get_backend(self.options.gpu, progress)
        return self._backend

    def model_for(self, beam):
        if beam.number in self.assignments:
            return self.assignments[beam.number]
        return self.library.find(beam.machine, beam.energy, beam.fluence_mode)

    def _group_key(self, beam, gantry, coll, couch):
        o = self.options
        if beam.is_arc:
            k = int(np.floor(((gantry + 0.5 * o.sector_deg) % 360.0) / o.sector_deg))
        else:
            k = 0
        return (k, round(couch, 1), round(coll, 1))

    def count_groups(self, beam):
        """Número de superposiciones que necesitará un haz."""
        ang = subbeam_angles(beam, self.options.max_gantry_step_deg)
        return len({self._group_key(beam, g, c, t) for g, c, t in ang})

    def superpose_group(self, rho, grid, model, group, mask, trace=None):
        """TERMA de un grupo de incidencias y una superposición con eje medio."""
        o = self.options
        cs = self.cones.get(model)
        e = model.energies
        w = model.weights
        mu = mu_rho_water(e)
        T = np.zeros(grid.shape)
        De = np.zeros(grid.shape)
        axis = np.zeros(3)
        for sb in group:
            t, de = compute_terma(rho, grid, sb.geom, sb.fluence, sb.axes, sb.efluence, e, w, mu,
                                  softening=model.softening_per_cm,
                                  softening_rmax_cm=model.softening_rmax_cm,
                                  softening_power=getattr(model, "softening_power", 1.0),
                                  ke=model.econt_k_per_cm, ray_spacing_mm=o.ray_spacing_mm,
                                  trace=trace)
            T += t
            De += de
            axis += sb.geom.axis * max(sb.mu, 1e-9)
        u, v, wv = _frame(axis, group[0].geom.u)
        sp_cm = grid.spacing / 10.0
        kw = dict(mask=mask, line_spacing_cm=None if o.line_spacing_mm is None else o.line_spacing_mm / 10,
                  step_cm=None if o.step_mm is None else o.step_mm / 10)
        tilt = o.kernel_tilt and getattr(model, "kernel_tilt", True)
        tiles = self._tilt_tiles(T, grid, group[len(group) // 2].geom.source, u, v, wv) if tilt else None
        M = np.column_stack([u, v, wv])
        D = self.backend.superpose(T, rho, sp_cm, cs.directions @ M.T, cs.A, cs.a, **kw)
        if tiles:
            # Inclinación del kernel con la divergencia del haz (campos grandes).
            D += self._tilt_correction(T, rho, grid, mask, tiles, cs, (u, v, wv), kw) * mask
        return D + De * mask

    def _tilt_correction(self, T, rho, grid, mask, tiles, cs, frame, kw):
        """Corrección por inclinación del kernel: Σ S(T_nodo, kernel inclinado) − S(T, kernel según el eje).

        El TERMA de cada nodo se reparte con pesos lineales que suman 1, de modo que la
        dirección efectiva del kernel varía de forma continua. La diferencia es suave,
        así que se calcula en una rejilla de unos tilt_coarse_mm (promedio por bloques)
        y se interpola trilinealmente a la rejilla del cálculo.
        """
        o = self.options
        u, v, w = frame
        f = max(1, int(np.floor(o.tilt_coarse_mm / float(np.min(grid.spacing)) + 1e-6)))

        def down(a, how="mean"):
            if f == 1:
                return a
            pad = [(0, (-n) % f) for n in a.shape]
            a = np.pad(a, pad, mode="edge")
            nz, ny, nx = (n // f for n in a.shape)
            b = a.reshape(nz, f, ny, f, nx, f)
            return b.any(axis=(1, 3, 5)) if how == "any" else b.mean(axis=(1, 3, 5))

        rho_c = down(rho)
        mask_c = down(mask.astype(bool), "any") if mask is not None else None
        sp_c = grid.spacing * f / 10.0
        kwc = dict(kw, mask=mask_c)
        if f > 1:
            kwc["line_spacing_cm"] = None if kw["line_spacing_cm"] is None else kw["line_spacing_cm"] * f
            kwc["step_cm"] = None if kw["step_cm"] is None else kw["step_cm"] * f
        Ma = np.column_stack([u, v, w])
        diff = -self.backend.superpose(down(T), rho_c, sp_c, cs.directions @ Ma.T, cs.A, cs.a, **kwc)
        Tw = np.zeros(grid.shape)
        for idx, wts, d in tiles:
            tu, tv, tw = _frame(d, u)
            M = np.column_stack([tu, tv, tw])
            Tw[:] = 0.0
            Tw.flat[idx] = wts
            diff += self.backend.superpose(down(Tw), rho_c, sp_c, cs.directions @ M.T, cs.A, cs.a, **kwc)
        if f == 1:
            return diff
        from scipy.ndimage import map_coordinates
        c = [(np.arange(n) - (f - 1) / 2.0) / f for n in grid.shape]
        kk, jj, ii = np.meshgrid(*c, indexing="ij")
        return map_coordinates(diff, [kk, jj, ii], order=1, mode="nearest")

    def _tilt_tiles(self, T, grid, src, u, v, w):
        """Reparto del TERMA entre direcciones nodales para inclinar el kernel.

        Cada vóxel tiene dos ángulos vistos desde la fuente (planos u-w y v-w). Los
        nodos están en múltiplos de tilt_tile_deg, centrados en el eje. El TERMA de
        un vóxel se reparte entre los cuatro nodos que lo rodean con pesos bilineales,
        de modo que la dirección efectiva del kernel varía de forma continua y no hay
        saltos entre sectores. Devuelve None si el campo es estrecho (todo el TERMA
        relevante dentro de ±tilt_min_halfangle_deg) y basta el kernel según el eje.
        """
        o = self.options
        tmax = T.max()
        if tmax <= 0:
            return None
        kk, jj, ii = np.nonzero(T > 0)
        tvals = T[kk, jj, ii]
        x, y, z = grid.axes()
        r = np.column_stack([x[ii], y[jj], z[kk]]) - src
        rw = r @ w
        td = o.tilt_tile_deg
        ax = np.degrees(np.arctan2(r @ u, rw)) / td
        ay = np.degrees(np.arctan2(r @ v, rw)) / td
        core = tvals > 0.05 * tmax
        ang = np.degrees(np.arctan2(np.hypot(r[core] @ u, r[core] @ v), rw[core]))
        if ang.max() <= o.tilt_min_halfangle_deg:
            return None
        # Nodos: del más próximo al borde negativo del TERMA relevante al del positivo.
        nx0, nx1 = int(np.rint(ax[core].min())), int(np.rint(ax[core].max()))
        ny0, ny1 = int(np.rint(ay[core].min())), int(np.rint(ay[core].max()))
        if nx0 == nx1 and ny0 == ny1:
            return None
        ax = np.clip(ax, nx0, nx1)
        ay = np.clip(ay, ny0, ny1)
        ix = np.minimum(np.floor(ax).astype(int), max(nx1 - 1, nx0))
        iy = np.minimum(np.floor(ay).astype(int), max(ny1 - 1, ny0))
        fx = ax - ix if nx1 > nx0 else np.zeros_like(ax)
        fy = ay - iy if ny1 > ny0 else np.zeros_like(ay)
        acc = {}
        for dx, wx in ((0, 1.0 - fx), (1, fx)):
            for dy, wy in ((0, 1.0 - fy), (1, fy)):
                wt = wx * wy
                nx = ix + dx
                ny = iy + dy
                for key in set(zip(nx[wt > 0].tolist(), ny[wt > 0].tolist())):
                    s = (nx == key[0]) & (ny == key[1]) & (wt > 0)
                    acc.setdefault(key, []).append((s, wt[s]))
        tiles = []
        for (nx, ny), parts in sorted(acc.items()):
            wsum = np.zeros(len(tvals))
            for s, wt in parts:
                wsum[s] += wt
            s = wsum > 0
            d = np.tan(np.radians(nx * td)) * u + np.tan(np.radians(ny * td)) * v + w
            flat = np.ravel_multi_index((kk[s], jj[s], ii[s]), T.shape)
            tiles.append((flat, tvals[s] * wsum[s], d / np.linalg.norm(d)))
        return tiles

    def compute_beam_raw(self, beam, model, rho, grid, mask=None, trace=None):
        """Dosis en unidades internas (sin calibrar) de un haz con un modelo dado."""
        o = self.options
        if mask is None:
            mask = np.ones(grid.shape, dtype=bool)
        sbs = list(subbeams(beam, model, res_mm=o.fluence_res_mm, max_gantry_step=o.max_gantry_step_deg))
        groups = {}
        for sb in sbs:
            key = self._group_key(beam, sb.gantry, sb.geom.coll, sb.geom.couch)
            groups.setdefault(key, []).append(sb)
        D = np.zeros(grid.shape)
        n = len(groups)
        if self.step_callback:
            self.step_callback(beam, 0, n)
        for i, key in enumerate(sorted(groups)):
            D += self.superpose_group(rho, grid, model, groups[key], mask, trace)
            if self.step_callback:
                self.step_callback(beam, i + 1, n)
        return D, len(sbs), len(groups)

    def compute_beam(self, beam, rho, grid, mask=None, trace=None):
        t0 = time.time()
        model = self.model_for(beam)
        D, nsb, ngr = self.compute_beam_raw(beam, model, rho, grid, mask, trace)
        cal = model.calibration
        if cal.cgy_per_unit <= 0:
            raise RuntimeError(f"El modelo '{model.name}' no está calibrado (calibration.cgy_per_unit)")
        warn = list(beam.warnings)
        if abs(cal.grid_mm - float(grid.spacing.min())) > 0.6:
            warn.append(f"La calibración del modelo se hizo con rejilla de {cal.grid_mm} mm "
                        f"y el cálculo usa {grid.spacing.min():.2f} mm")
        if not model.commissioned:
            warn.append("Modelo de haz no comisionado: resultado no válido para uso clínico")
        dose_gy = D * cal.cgy_per_unit / 100.0
        mlc_name, mp = model.mlc_for_beam(beam)
        mlc_txt = "" if mlc_name is None else (
            f"{display_name(mlc_name)} (T {mp.transmission:g}, DLG {mp.dlg_mm:g} mm, "
            + (f"LR {mp.tg_width_mm:g} mm)" if mp.tg_width_mm > 0 else "sin LR)"))
        return BeamResult(beam.number, beam.name, beam.mu, beam.technique, model.name,
                          dose_gy, nsb, ngr, time.time() - t0, warn, mlc_txt)

    def check_plan(self, plan):
        """Comprueba antes de calcular que cada haz tiene modelo y parámetros de su MLC."""
        errors = []
        for b in self.treatment_beams(plan):
            try:
                self.model_for(b).mlc_for_beam(b)
            except (KeyError, ValueError) as e:
                msg = e.args[0] if e.args else str(e)
                errors.append(f"Haz {b.name}: {msg}")
        if errors:
            raise ValueError("No se puede calcular el plan:\n" + "\n".join(errors))

    @staticmethod
    def treatment_beams(plan):
        return [b for b in plan.beams if b.beam_type == "TREATMENT" and b.mu > 0
                and b.radiation_type == "PHOTON"]

    def compute_plan(self, plan, rho, grid, mask=None, progress=None, trace=None):
        results = []
        self.check_plan(plan)
        treat = self.treatment_beams(plan)
        for i, b in enumerate(treat):
            if progress:
                progress(f"Haz {i + 1}/{len(treat)}: {b.name} ({b.technique}, {b.mu:.1f} UM)")
            r = self.compute_beam(b, rho, grid, mask, trace)
            log.info("Haz %s: %.1f s, %d incidencias, %d superposiciones",
                     b.name, r.seconds, r.n_subbeams, r.n_superpositions)
            results.append(r)
        total = np.zeros(grid.shape)
        for r in results:
            total += r.dose_gy
        return total, results
