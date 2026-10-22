"""Interfaz de línea de comandos.

Ejemplos
--------
python -m calcindep verificar CARPETA_DICOM --config verificacion.json --salida resultados
python -m calcindep comisionar comisionado.json
python -m calcindep calibrar modelo.json --rejilla 2.5
python -m calcindep caso-sintetico CARPETA --tecnica VMAT
python -m calcindep gpu --comprobar
python -m calcindep --gpu cpu verificar CARPETA_DICOM ...
"""
import argparse
import logging
import sys
from pathlib import Path


def _verificar(a):
    from .gamma import GammaSettings
    from .pipeline import CheckConfig, run_check
    from .report import write_report
    cfg = CheckConfig.from_json(a.config) if a.config else CheckConfig()
    if a.modelo:
        cfg.beam_models = [str(Path(p).resolve()) for p in a.modelo]
    if a.curva:
        cfg.hu_ed_csv = str(Path(a.curva).resolve())
    if a.gamma:
        dd, dta = (float(v) for v in a.gamma.split(","))
        cfg.gamma.dose_pct, cfg.gamma.dta_mm = dd, dta
    if a.local:
        cfg.gamma.local = True
    if a.umbral is not None:
        cfg.gamma.threshold_pct = a.umbral
    if a.rejilla:
        cfg.calc_spacing_mm = a.rejilla
    out = Path(a.salida)
    res = run_check(folder=a.carpeta, config=cfg, out_dir=out)
    path = write_report(res, out)
    s = res.gamma.stats
    print(f"Gamma {cfg.gamma.dose_pct:g}%/{cfg.gamma.dta_mm:g} mm: {s['pass_pct']:.1f}% de {s['n']} puntos")
    print(f"Informe: {path}")


def _comisionar(a):
    from .commissioning.fit import CommissioningConfig, Commissioner
    from .commissioning.report import write_commissioning_report
    p = Path(a.config).resolve()
    cfg = CommissioningConfig.from_json(p)
    comm = Commissioner(cfg, base_dir=p.parent)
    val, of_res = comm.run()
    out_model = p.parent / cfg.output_model
    comm.model.to_json(out_model)
    rep = write_commissioning_report(p.parent / cfg.report, comm, val, of_res)
    print(f"Modelo: {out_model}")
    print(f"Informe: {rep}")


def _calibrar(a):
    from .beam_model import BeamModel
    from .calibration import calibrate
    m = BeamModel.from_json(a.modelo)
    c = calibrate(m, spacing_mm=a.rejilla)
    m.to_json(a.modelo)
    print(f"{m.name}: {c:.6g} cGy por unidad interna (rejilla {a.rejilla:g} mm)")


def _sintetico(a):
    from .beam_model import BeamModel, default_model_path
    from .engine import DoseEngine
    from .synthetic import generate_case
    eng = DoseEngine(BeamModel.from_json(a.modelo or default_model_path()))
    generate_case(a.carpeta, a.tecnica, engine=eng if not a.sin_dosis else None)
    print(f"Caso creado en {a.carpeta}")


def _gpu(a):
    from . import gpu
    if a.comprobar:
        res, reason = gpu.check_devices(force=True, progress=print)
    else:
        res, reason = gpu.check_devices(force=False, progress=print)
    if not res:
        print(f"Sin GPU: {reason}. La superposición se hará en la CPU.")
        return
    for info, rec in res:
        print(f"{info.name} ({info.platform}, driver {info.driver}, {info.compute_units} unidades, "
              f"{info.memory_gb:g} GB): {gpu.describe_record(rec)}")
    b = gpu.get_backend("auto")
    print(f"En modo automático la superposición se hará en: {b.describe()}")
    print(f"Registro: {gpu.registry_path()}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="calcindep", description="Cálculo independiente de dosis (collapsed cone)")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--gpu", default="auto",
                    help="Superposición: auto (GPU si está validada y es más rápida), cpu, o el nombre de una GPU")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("verificar", help="Calcula un plan y lo compara con la dosis del TPS")
    v.add_argument("carpeta", help="Carpeta con CT, RTSTRUCT, RTPLAN y RTDOSE")
    v.add_argument("--config", help="Fichero JSON de verificación")
    v.add_argument("--modelo", nargs="+", help="Modelos de haz JSON")
    v.add_argument("--curva", help="CSV de la curva HU-densidad electrónica")
    v.add_argument("--gamma", help="Criterio 'dosis%%,mm', por ejemplo 3,2")
    v.add_argument("--local", action="store_true", help="Gamma local")
    v.add_argument("--umbral", type=float, help="Umbral de dosis en %%")
    v.add_argument("--rejilla", type=float, help="Tamaño de vóxel de cálculo (mm)")
    v.add_argument("--salida", default="resultados_verificacion")
    v.set_defaults(func=_verificar)
    c = sub.add_parser("comisionar", help="Ajusta un modelo de haz a datos medidos")
    c.add_argument("config")
    c.set_defaults(func=_comisionar)
    k = sub.add_parser("calibrar", help="Calibra las UM de un modelo de haz")
    k.add_argument("modelo")
    k.add_argument("--rejilla", type=float, default=2.5)
    k.set_defaults(func=_calibrar)
    s = sub.add_parser("caso-sintetico", help="Genera un caso DICOM sintético de prueba")
    s.add_argument("carpeta")
    s.add_argument("--tecnica", choices=["3D", "IMRT", "VMAT"], default="3D")
    s.add_argument("--modelo")
    s.add_argument("--sin-dosis", action="store_true")
    s.set_defaults(func=_sintetico)
    g = sub.add_parser("gpu", help="Muestra las GPU disponibles y su comprobación frente a la CPU")
    g.add_argument("--comprobar", action="store_true", help="Repite la comprobación aunque ya esté hecha")
    g.set_defaults(func=_gpu)
    if argv is None:
        argv = sys.argv[1:]
    if not argv:
        from .gui.launcher import run as gui_run
        return gui_run()
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO if a.verbose else logging.WARNING, format="%(message)s")
    from . import gpu
    gpu.set_default_mode(a.gpu)
    a.func(a)


if __name__ == "__main__":
    sys.exit(main())
