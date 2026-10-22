"""Modelo de haz para el cálculo collapsed cone.

El modelo se guarda en JSON. Todas las magnitudes espaciales del plano del
isocentro están en mm; los coeficientes de atenuación en cm^-1.

Fluencia de energía en el plano del isocentro para una apertura A(x, y)
(transmisiones de MLC y mandíbulas incluidas):

    Psi(x, y) = f_oa(r) [G(sigma_p) * A](x, y) + w_ef [G(sigma_ef) * A](x, y)

f_oa(r) es el perfil radial de fluencia (cuernos), sigma_p el tamaño de la
fuente primaria proyectado al isocentro y (w_ef, sigma_ef) la fuente
extrafocal que reproduce la dispersión en el cabezal.
"""
import json
from dataclasses import dataclass, field, asdict
from pathlib import Path

import numpy as np

from .mlc import MLC_TYPES, MLCParams, display_name, identify_mlc

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


@dataclass
class Calibration:
    dose_per_mu_cgy: float = 1.0      # dosis por UM en condiciones de referencia
    ssd_mm: float = 1000.0
    depth_mm: float = 15.0
    field_mm: float = 100.0
    # Factor que convierte la dosis calculada (unidades internas por UM) en cGy.
    # Se obtiene con calcindep.calibration.calibrate().
    cgy_per_unit: float = 0.0
    # Rejilla con la que se obtuvo cgy_per_unit (el factor depende ligeramente
    # del tamaño de vóxel).
    grid_mm: float = 2.5


@dataclass
class BeamModel:
    name: str = "Genérico 6X"
    machine: str = ""
    energy: str = "6X"
    fluence_mode: str = "STANDARD"     # STANDARD o FFF
    commissioned: bool = False
    notes: str = ""
    commissioning_report: str = ""     # ruta del informe de comisionado
    sad_mm: float = 1000.0
    # Espectro (fracción de fotones por intervalo). Las energías deben
    # coincidir con las de la tabla de kernels EDK.
    spectrum_energies_mev: list = field(default_factory=lambda: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0,
                                                                  3.5, 4.0, 4.5, 5.0, 5.5, 6.0])
    spectrum_weights: list = field(default_factory=lambda: [0.0820, 0.1239, 0.1061, 0.0831,
                                                             0.0588, 0.0391, 0.0213, 0.0243,
                                                             0.0050, 0.0088, 0.0030, 0.0050])
    kernel_weight_depth_cm: float = 10.0
    kernel_components: int = 2
    # Perfil radial de fluencia en el plano del isocentro.
    oa_radius_mm: list = field(default_factory=lambda: [0.0, 50.0, 100.0, 150.0, 200.0, 250.0, 300.0])
    oa_factor: list = field(default_factory=lambda: [1.0, 1.01, 1.03, 1.045, 1.05, 1.05, 1.05])
    # Ablandamiento fuera de eje: mu(r) = mu (1 + s r^n), r en cm en el isocentro (hasta
    # softening_rmax_cm). n = softening_power: 1 lineal (s en cm⁻¹), 2 cuadrático (s en cm⁻²).
    softening_per_cm: float = 0.0025
    softening_rmax_cm: float = 20.0
    softening_power: float = 1.0
    primary_sigma_mm: float = 0.8
    primary_weight: float = 1.0        # uso interno en el comisionado
    # Colimador primario circular: radio y anchura de su penumbra en el isocentro.
    # Recorta las esquinas de los campos grandes (Varian: unos 250 mm). 0: sin colimador primario.
    primary_collimator_radius_mm: float = 0.0
    primary_collimator_sigma_mm: float = 8.0
    extrafocal_weight: float = 0.06
    extrafocal_sigma_mm: float = 20.0      # en la dirección de las mandíbulas X (y del MLC)
    extrafocal_sigma_y_mm: float = 0.0     # dirección de las mandíbulas Y; 0: igual que en X
    # Contaminación electrónica
    econt_weight: float = 0.0
    econt_k_per_cm: float = 0.6
    econt_sigma_mm: float = 15.0
    # Colimación. Parámetros de cada MLC que puede usar la máquina, por nombre interno
    # (véase calcindep.mlc.MLC_TYPES): {"Millennium120": {"transmission": 0.013,
    # "dlg_mm": 1.3, "tg_width_mm": 0.0}, "HD120": {...}}. El cálculo usa los del MLC
    # que se identifica en cada haz del plan.
    mlc: dict = field(default_factory=lambda: {"Millennium120": MLCParams().to_dict()})
    jaw_transmission: float = 0.001
    # Retrodispersión hacia la cámara monitora: Psi *= 1 / (1 + k (S_jaw/100 mm - 1))
    monitor_backscatter_k: float = 0.0
    # Inclinación del kernel con la divergencia del haz (campos grandes). Los modelos
    # guardados antes de esta opción se comisionaron sin ella y se cargan con False,
    # para que sigan calculando igual que cuando se validaron.
    kernel_tilt: bool = True
    calibration: Calibration = field(default_factory=Calibration)

    # ------------------------------------------------------------------
    @property
    def ef_sigmas(self):
        """(σx, σy) de la fuente extrafocal en el plano del isocentro (mm)."""
        sy = self.extrafocal_sigma_y_mm if self.extrafocal_sigma_y_mm > 0 else self.extrafocal_sigma_mm
        return float(self.extrafocal_sigma_mm), float(sy)

    def mlc_params(self, mlc_name):
        """Parámetros (MLCParams) de un MLC; ValueError si el modelo no los tiene."""
        if mlc_name not in self.mlc:
            have = ", ".join(display_name(k) for k in self.mlc) or "ninguno"
            raise ValueError(f"El modelo de haz '{self.name}' no tiene parámetros para el MLC "
                             f"{display_name(mlc_name)} (tiene: {have}). Añádalos en la pestaña "
                             f"«Modelos de haz».")
        p = MLCParams.from_dict(self.mlc[mlc_name])
        p.validate(mlc_name)
        return p

    def mlc_for_beam(self, beam):
        """(nombre del MLC, MLCParams) del haz, o (None, None) si el haz no tiene MLC."""
        if beam.leaf_boundaries is None:
            return None, None
        name = identify_mlc(beam.leaf_boundaries)
        return name, self.mlc_params(name)

    def oa(self, r_mm):
        return np.interp(r_mm, self.oa_radius_mm, self.oa_factor)

    @property
    def energies(self):
        return np.asarray(self.spectrum_energies_mev, float)

    @property
    def weights(self):
        w = np.asarray(self.spectrum_weights, float)
        return w / w.sum()

    def to_json(self, path):
        d = asdict(self)
        Path(path).write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")

    @classmethod
    def from_json(cls, path):
        d = json.loads(Path(path).read_text(encoding="utf-8"))
        cal = Calibration(**d.pop("calibration", {}))
        d.setdefault("kernel_tilt", False)
        # Modelos anteriores a los parámetros por MLC: un único par transmisión/DLG,
        # que era el del Millennium 120.
        t_old = d.pop("mlc_transmission", None)
        dlg_old = d.pop("mlc_dlg_mm", None)
        if "mlc" not in d:
            p = MLCParams()
            if t_old is not None:
                p.transmission = float(t_old)
            if dlg_old is not None:
                p.dlg_mm = float(dlg_old)
            d["mlc"] = {"Millennium120": p.to_dict()}
        d["mlc"] = {k: MLCParams.from_dict(v).to_dict() for k, v in d["mlc"].items()}
        known = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(calibration=cal, **known)


def default_model_path():
    return DATA_DIR / "beam_models" / "generico_6X.json"


class BeamModelLibrary:
    """Asocia (máquina, energía, modo de fluencia) con un fichero de modelo."""

    def __init__(self, models):
        self.models = list(models)

    @classmethod
    def from_paths(cls, paths):
        return cls([BeamModel.from_json(p) for p in paths])

    def find(self, machine, energy, fluence_mode="STANDARD"):
        energy = (energy or "").upper()
        fm = (fluence_mode or "STANDARD").upper()
        cand = [m for m in self.models if m.energy.upper() == energy and m.fluence_mode.upper() == fm]
        exact = [m for m in cand if m.machine and machine and m.machine.upper() == machine.upper()]
        if exact:
            return exact[0]
        generic = [m for m in cand if not m.machine]
        if generic:
            return generic[0]
        if cand:
            return cand[0]
        raise KeyError(f"No hay modelo de haz para máquina={machine}, energía={energy}, modo={fm}")
