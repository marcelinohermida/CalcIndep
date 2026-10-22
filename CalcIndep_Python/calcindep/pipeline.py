"""Flujo completo de verificación de un plan."""
import json
import logging
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

import numpy as np
from scipy.ndimage import map_coordinates

from . import __version__, dicom_io
from .beam_model import BeamModel, BeamModelLibrary
from .calibration import calibrate
from .dicom_write import write_rtdose
from .dvh import metrics
from .engine import (CalcOptions, Cancelled, DoseEngine, build_density, build_trace_density,
                     calc_grid_from)
from .gamma import GammaSettings, gamma_3d, gamma_by_structure
from .geometry import Grid
from .hu_ed import EXAMPLE_CURVE, HUEDCurve

log = logging.getLogger(__name__)


@dataclass
class CheckConfig:
    beam_models: list = field(default_factory=list)       # rutas JSON
    hu_ed_csv: str = None
    gamma: GammaSettings = field(default_factory=GammaSettings)
    options: CalcOptions = field(default_factory=CalcOptions)
    pass_threshold_pct: float = 95.0
    calc_spacing_mm: float = None      # None: rejilla del RTDOSE del TPS
    fraction_factor: float = None      # None: automático según DoseSummationType
    min_points_structure: int = 10
    save_rtdose: bool = True
    save_models_after_calibration: bool = False

    @classmethod
    def from_json(cls, path):
        d = json.loads(Path(path).read_text(encoding="utf-8"))
        g = GammaSettings(**d.pop("gamma", {}))
        o = CalcOptions(**d.pop("options", {}))
        base = Path(path).parent
        d["beam_models"] = [str((base / p).resolve()) if not Path(p).is_absolute() else p
                            for p in d.get("beam_models", [])]
        if d.get("hu_ed_csv") and not Path(d["hu_ed_csv"]).is_absolute():
            d["hu_ed_csv"] = str((base / d["hu_ed_csv"]).resolve())
        return cls(gamma=g, options=o, **d)


@dataclass
class CheckResult:
    plan: object
    tps_grid: Grid
    tps_dose: np.ndarray
    calc_dose: np.ndarray            # en la rejilla del TPS, misma suma (Gy)
    ct_on_grid: np.ndarray
    masks: dict
    structures: list
    gamma: object
    gamma_struct: dict
    dvh_tps: dict
    dvh_calc: dict
    beams: list
    warnings: list
    info: dict
    curve: object
    config: CheckConfig


def _find_inputs(folder):
    f = dicom_io.scan_folder(folder)
    if not f["CT"]:
        raise FileNotFoundError("No hay CT en la carpeta")
    if len(f["RTPLAN"]) != 1:
        raise FileNotFoundError(f"Se esperaba un RTPLAN y hay {len(f['RTPLAN'])}")
    if len(f["RTSTRUCT"]) != 1:
        raise FileNotFoundError(f"Se esperaba un RTSTRUCT y hay {len(f['RTSTRUCT'])}")
    if not f["RTDOSE"]:
        raise FileNotFoundError("No hay RTDOSE en la carpeta")
    return f["CT"], f["RTSTRUCT"][0], f["RTPLAN"][0], f["RTDOSE"]


def _select_rtdose(paths, plan):
    """Si hay dosis de plan y por haz, se usa la de plan."""
    infos = [(p, dicom_io.read_rtdose(p)[1]) for p in paths]
    infos = [x for x in infos if not x[1]["referenced_plan_uid"] or x[1]["referenced_plan_uid"] == plan.sop_uid] or infos
    plan_d = [p for p, i in infos if i["summation"] in ("PLAN", "FRACTION")]
    if plan_d:
        return [plan_d[0]]
    return [p for p, i in infos if i["summation"] == "BEAM"]


def resample_to(src, src_grid, dst_grid, order=1, cval=0.0):
    x, y, z = dst_grid.axes()
    fk = (z - src_grid.origin[2]) / src_grid.spacing[2]
    fj = (y - src_grid.origin[1]) / src_grid.spacing[1]
    fi = (x - src_grid.origin[0]) / src_grid.spacing[0]
    K, J, I = np.meshgrid(fk, fj, fi, indexing="ij")
    return map_coordinates(src, [K, J, I], order=order, mode="constant", cval=cval)


def run_check(folder=None, ct_files=None, rtstruct=None, rtplan=None, rtdose=None,
              config=None, out_dir=None, progress=print, fraction=None, cancel=None,
              models_by_beam=None):
    """Verificación completa de un plan.

    progress(mensaje), fraction(0-1): avance para la interfaz.
    cancel: threading.Event; si se activa, se lanza Cancelled.
    models_by_beam: {número de haz: ruta del modelo JSON} para forzar el modelo de cada haz.
    """
    cfg = config or CheckConfig()
    t0 = time.time()
    warnings = []

    def frac(f):
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        if fraction:
            fraction(min(max(f, 0.0), 1.0))
    if folder is not None:
        ct_files, rtstruct, rtplan, rtdose = _find_inputs(folder)
    if isinstance(rtdose, (str, Path)):
        rtdose = [rtdose]
    progress("Leyendo DICOM")
    frac(0.0)
    plan = dicom_io.read_rtplan(rtplan)
    structures, sinfo = dicom_io.read_rtstruct(rtstruct)
    ct, ctinfo = dicom_io.read_ct(ct_files, sinfo.get("referenced_series_uid"))
    rtdose = _select_rtdose(rtdose, plan)
    tps, dinfo = dicom_io.sum_rtdoses(rtdose)
    # Coherencia de los objetos
    fors = {ctinfo["frame_of_reference_uid"], sinfo.get("frame_of_reference_uid") or ctinfo["frame_of_reference_uid"],
            plan.frame_of_reference_uid or ctinfo["frame_of_reference_uid"]}
    if len(fors) > 1:
        warnings.append("Los FrameOfReferenceUID de CT, estructuras y plan no coinciden")
    if dinfo["referenced_plan_uid"] and dinfo["referenced_plan_uid"] != plan.sop_uid:
        warnings.append("El RTDOSE no referencia al RTPLAN cargado")
    # Curva HU-ED
    curve = HUEDCurve.from_csv(cfg.hu_ed_csv) if cfg.hu_ed_csv else HUEDCurve.from_csv(EXAMPLE_CURVE)
    if not cfg.hu_ed_csv:
        warnings.append("Se ha usado la curva HU-ED de ejemplo: cargue la curva de su CT")
    # Modelos
    loaded = {}

    def load(p):
        key = str(Path(p).resolve())
        if key not in loaded:
            loaded[key] = BeamModel.from_json(p)
        return loaded[key]
    models_lib = [load(p) for p in cfg.beam_models]
    assigned = {int(n): load(p) for n, p in (models_by_beam or {}).items()}
    if not models_lib and not assigned:
        from .beam_model import default_model_path
        models_lib = [load(default_model_path())]
        warnings.append("Se ha usado el modelo de haz genérico de ejemplo")
    library = BeamModelLibrary(models_lib)
    engine = DoseEngine(library, cfg.options)
    engine.assignments = assigned
    treat = [b for b in plan.beams if b.beam_type == "TREATMENT" and b.mu > 0 and b.radiation_type == "PHOTON"]
    used = []
    for b in treat:
        m = engine.model_for(b)  # lanza KeyError si un haz no tiene modelo
        if all(m is not u for u in used):
            used.append(m)
    models = used
    engine.check_plan(plan)   # MLC de cada haz reconocido y con parámetros en su modelo
    frac(0.04)
    # Dispositivo de la superposición (GPU si está disponible y validada en este ordenador)
    backend = engine.prepare_backend(progress)
    n_warn_backend = len(backend.warnings)
    progress(f"Superposición: {backend.describe()}")
    # Rejilla de cálculo
    progress("Preparando rejillas y densidades")
    masks = {s.name: dicom_io.rasterize(s, tps.grid) for s in structures}
    ext = next((s for s in structures if s.type == "EXTERNAL"), None)
    if ext is None:
        warnings.append("No hay estructura de tipo EXTERNAL: se calcula en toda la rejilla del CT")
    if cfg.calc_spacing_mm:
        sp = float(cfg.calc_spacing_mm)
        x0, x1, y0, y1, z0, z1 = tps.grid.extent()
        n = np.floor(np.array([x1 - x0, y1 - y0, z1 - z0]) / sp).astype(int) + 1
        base = Grid([x0, y0, z0], [sp] * 3, (n[2], n[1], n[0]))
    else:
        base = tps.grid
    ext_mask_base = dicom_io.rasterize(ext, base) if ext is not None else None
    grid, crop = calc_grid_from(base, ext_mask_base, cfg.options.margin_mm)
    rho, cmask, dens_info = build_density(ct, curve, grid, structures, cfg.options)
    for name in dens_info.get("missing_overrides", []):
        warnings.append(f"No existe la estructura '{name}' indicada para asignar densidad")
    trace = None
    if cfg.options.trace_full_ct:
        trace = build_trace_density(ct, curve, structures, float(grid.spacing.min()), cfg.options)
    frac(0.10)
    # Calibración de UM de los modelos para esta rejilla
    for m in models:
        if m.calibration.cgy_per_unit <= 0 or abs(m.calibration.grid_mm - grid.spacing.min()) > 0.6:
            progress(f"Calibrando UM del modelo '{m.name}' con rejilla de {grid.spacing.min():.2f} mm")
            calibrate(m, spacing_mm=float(grid.spacing.min()), engine=engine)
            frac(0.10)
    # Cálculo
    progress("Calculando dosis")
    total_groups = max(1, sum(engine.count_groups(b) for b in treat))
    done = {"n": 0, "beam": None}

    def step(beam, k, n):
        if k > 0:
            done["n"] += 1
        frac(0.12 + 0.78 * done["n"] / total_groups)
    engine.step_callback = step
    dose_fx, beams = engine.compute_plan(plan, rho, grid, cmask, progress=progress, trace=trace)
    engine.step_callback = None
    for w in backend.warnings[n_warn_backend:]:
        warnings.append(w)
    for b in beams:
        for w in b.warnings:
            msg = f"{b.name}: {w}"
            if msg not in warnings:
                warnings.append(msg)
    if cfg.fraction_factor is not None:
        ff = float(cfg.fraction_factor)
    else:
        ff = float(plan.n_fractions) if dinfo["summation"] in ("PLAN", "BEAM") else 1.0
    dose_calc_grid = dose_fx * ff
    # Llevar el cálculo a la rejilla del TPS
    full = np.zeros(base.shape)
    k0, k1, j0, j1, i0, i1 = crop
    full[k0:k1, j0:j1, i0:i1] = dose_calc_grid
    calc_on_tps = full if base is tps.grid else resample_to(full, base, tps.grid)
    # Gamma
    progress("Calculando gamma")
    frac(0.90)
    ext_mask_tps = masks.get(ext.name) if ext is not None else None
    if cfg.gamma.reference == "tps":
        ref, ev = tps.data, calc_on_tps
    else:
        ref, ev = calc_on_tps, tps.data
    g = gamma_3d(ref, tps.grid, ev, tps.grid, cfg.gamma, mask=ext_mask_tps,
                 prescription_gy=plan.prescription_gy)
    gs = gamma_by_structure(g, masks)
    frac(0.96)
    vcc = tps.grid.voxel_volume_cc()
    dvh_t = {n: metrics(tps.data, m, vcc) for n, m in masks.items()}
    dvh_c = {n: metrics(calc_on_tps, m, vcc) for n, m in masks.items()}
    ct_disp = resample_to(ct.data, ct.grid, tps.grid, order=1, cval=-1000.0)
    info = {
        "tps_grid": tps.grid, "calc_grid": grid, "fraction_factor": ff,
        "dose_summation": dinfo["summation"], "rtdose_files": [str(p) for p in rtdose],
        "rtplan": str(rtplan), "rtstruct": str(rtstruct), "n_ct": len(ct_files),
        "density": dens_info, "elapsed_s": time.time() - t0,
        "superposition": backend.describe(),
        "models": [{"name": m.name, "energy": m.energy, "fluence_mode": m.fluence_mode,
                    "commissioned": m.commissioned, "cgy_per_unit": m.calibration.cgy_per_unit}
                   for m in models],
        "patient_id": ctinfo["patient_id"], "patient_name": ctinfo["patient_name"],
    }
    res = CheckResult(plan, tps.grid, tps.data, calc_on_tps, ct_disp, masks, structures, g, gs,
                      dvh_t, dvh_c, beams, warnings, info, curve, cfg)
    if out_dir is not None:
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        if cfg.save_rtdose:
            write_rtdose(out / "RD_calculo_independiente.dcm", calc_on_tps, tps.grid,
                         template=rtdose[0], plan_uid=plan.sop_uid,
                         summation="PLAN" if ff != 1.0 or dinfo["summation"] == "PLAN" else "FRACTION")
        save_summary(res, out / "resumen.json")
    frac(1.0)
    return res


NON_ANATOMIC = ("SUPPORT", "MARKER", "REGISTRATION", "FIXATION", "CONTROL", "BOLUS", "AVOIDANCE")


def verdict(res):
    """Resultado de la verificación.

    Cumple si la gamma global (dentro del External) y la de cada estructura
    anatómica con puntos suficientes alcanzan el umbral de aprobación.
    Devuelve (cumple, lista de estructuras que no cumplen).
    """
    cfg = res.config
    thr = cfg.pass_threshold_pct
    fails = []
    for s in res.structures:
        st = res.gamma_struct.get(s.name, {})
        if s.type in NON_ANATOMIC or st.get("n", 0) < cfg.min_points_structure:
            continue
        if st["pass_pct"] < thr:
            fails.append(s.name)
    g = res.gamma.stats.get("pass_pct", float("nan"))
    ok = bool(np.isfinite(g) and g >= thr and not fails)
    return ok, fails


def save_summary(res, path):
    """Resumen en JSON (trazabilidad): configuración, modelos, avisos y gamma por estructura."""
    def clean(d):
        return {k: (None if isinstance(v, float) and not np.isfinite(v) else v) for k, v in d.items()}
    cfg = res.config
    out = {
        "fecha": time.strftime("%Y-%m-%d %H:%M:%S"),
        "version_calcindep": __version__,
        "resultado": "CUMPLE" if verdict(res)[0] else "NO CUMPLE",
        "estructuras_que_no_cumplen": verdict(res)[1],
        "paciente": {"id": res.info["patient_id"], "nombre": res.info["patient_name"]},
        "plan": {"label": res.plan.label, "uid": res.plan.sop_uid, "fracciones": res.plan.n_fractions,
                 "prescripcion_gy": res.plan.prescription_gy},
        "gamma": {"criterio": asdict(cfg.gamma), "normalizacion_gy": res.gamma.norm_gy,
                  "global": clean(res.gamma.stats),
                  "por_estructura": {k: clean(v) for k, v in res.gamma_struct.items()}},
        "umbral_aprobacion_pct": cfg.pass_threshold_pct,
        "dosimetria": {"tps": {k: clean(v) for k, v in res.dvh_tps.items()},
                       "calculo": {k: clean(v) for k, v in res.dvh_calc.items()}},
        "modelos": res.info["models"],
        "curva_hu_ed": {"nombre": res.curve.name, "tabla": res.curve.table()},
        "opciones": asdict(cfg.options),
        "haces": [{"nombre": b.name, "um": b.mu, "tecnica": b.technique, "modelo": b.model,
                   "segundos": round(b.seconds, 1), "avisos": b.warnings} for b in res.beams],
        "avisos": res.warnings,
        "ficheros": {"rtplan": res.info["rtplan"], "rtstruct": res.info["rtstruct"],
                     "rtdose": res.info["rtdose_files"]},
        "tiempo_s": round(res.info["elapsed_s"], 1),
        "superposicion": res.info.get("superposition", "CPU (numba)"),
    }
    Path(path).write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
