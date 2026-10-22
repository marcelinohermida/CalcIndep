"""Ajustes de la aplicación y biblioteca de modelos, curvas y resultados."""
import json
import os
import re
import shutil
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

from ..beam_model import BeamModel, default_model_path
from ..hu_ed import EXAMPLE_CURVE, HUEDCurve

APP = "calcindep"


def config_dir():
    if sys.platform.startswith("win"):
        base = Path(os.environ.get("APPDATA") or Path.home())
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config"))
    return base / APP


def default_library():
    docs = Path.home() / "Documents"
    if not docs.exists():
        docs = Path.home()
    return docs / "calcindep"


def safe_name(s, maxlen=60):
    s = re.sub(r"[^\w\-.]+", "_", str(s), flags=re.UNICODE).strip("_.")
    return (s or "sin_nombre")[:maxlen]


@dataclass
class Settings:
    library: str = ""
    results_dir: str = ""                 # vacío: <biblioteca>/resultados
    threads: int = 0                      # 0: todos los núcleos
    gpu_mode: str = "auto"                # superposición: "auto", "cpu" o el nombre de una GPU
    # Opciones de cálculo
    fluence_res_mm: float = 0.5
    max_gantry_step_deg: float = 2.0
    sector_deg: float = 10.0
    trace_full_ct: bool = True
    margin_mm: float = 20.0
    # Últimos valores de la verificación
    last_folder: str = ""
    last_curve: str = ""
    gamma_dose_pct: float = 3.0
    gamma_dta_mm: float = 2.0
    gamma_local: bool = False
    gamma_threshold_pct: float = 10.0
    gamma_normalization: str = "max"
    gamma_reference: str = "tps"
    pass_threshold_pct: float = 95.0
    outside_air: bool = True
    keep_support: bool = True
    calc_spacing_mm: float = 0.0          # 0: rejilla de la dosis del TPS
    save_rtdose: bool = True
    scanner_curves: dict = field(default_factory=dict)   # escáner -> fichero de curva
    model_choice: dict = field(default_factory=dict)     # "máquina|energía|modo" -> fichero de modelo
    default_model: str = ""                               # fichero del modelo por defecto ("" : ninguno)
    last_commission_dir: str = ""

    # ------------------------------------------------------------------
    @property
    def path(self):
        return config_dir() / "ajustes.json"

    @classmethod
    def load(cls):
        p = config_dir() / "ajustes.json"
        s = cls()
        if p.exists():
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
                for k, v in d.items():
                    if k in cls.__dataclass_fields__:
                        setattr(s, k, v)
            except Exception:
                pass
        if not s.library:
            s.library = str(default_library())
        return s

    def save(self):
        p = self.path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(asdict(self), indent=2, ensure_ascii=False), encoding="utf-8")

    # ------------------------------------------------------------------
    @property
    def lib(self):
        return Path(self.library)

    @property
    def models_dir(self):
        return self.lib / "modelos"

    @property
    def curves_dir(self):
        return self.lib / "curvas_hu"

    @property
    def commissioning_dir(self):
        return self.lib / "comisionado"

    @property
    def results_path(self):
        return Path(self.results_dir) if self.results_dir else self.lib / "resultados"

    def ensure_library(self):
        """Crea la estructura de carpetas y copia los ejemplos la primera vez."""
        for d in (self.models_dir, self.curves_dir, self.commissioning_dir, self.results_path):
            d.mkdir(parents=True, exist_ok=True)
        if not any(self.models_dir.glob("*.json")):
            shutil.copy(default_model_path(), self.models_dir / "generico_6X.json")
        if not any(self.curves_dir.glob("*.csv")):
            shutil.copy(EXAMPLE_CURVE, self.curves_dir / "curva_ejemplo.csv")

    # ------------------------------------------------------------------
    def list_models(self):
        """{nombre de fichero: BeamModel} de la biblioteca (se omiten los que no se pueden leer)."""
        out = {}
        for p in sorted(self.models_dir.glob("*.json")):
            try:
                out[p.name] = BeamModel.from_json(p)
            except Exception:
                continue
        return out

    def list_curves(self):
        return sorted(p.name for p in self.curves_dir.glob("*.csv"))

    def load_curve(self, name):
        return HUEDCurve.from_csv(self.curves_dir / name)
