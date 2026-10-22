"""Lectura de objetos DICOM RT: CT, RTSTRUCT, RTPLAN y RTDOSE."""
import copy
import logging
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pydicom
from matplotlib.path import Path as MplPath

from .geometry import Grid

log = logging.getLogger(__name__)


# ----------------------------------------------------------------------------
# Utilidades
# ----------------------------------------------------------------------------
def scan_folder(folder):
    """Clasifica los ficheros DICOM de una carpeta por modalidad."""
    out = {"CT": [], "RTSTRUCT": [], "RTPLAN": [], "RTDOSE": []}
    for p in sorted(Path(folder).rglob("*")):
        if not p.is_file():
            continue
        try:
            ds = pydicom.dcmread(p, stop_before_pixels=True, force=True)
        except Exception:
            continue
        mod = getattr(ds, "Modality", None)
        if mod in out:
            out[mod].append(p)
    return out


def _axis_aligned(iop):
    iop = np.asarray(iop, float)
    r, c = iop[:3], iop[3:]
    ok = all(np.isclose(np.abs(v), 1.0).sum() == 1 and np.isclose(np.abs(v), 0.0).sum() == 2 for v in (r, c))
    if not ok:
        raise ValueError(f"Orientación de imagen no alineada con los ejes: {iop}")
    if not (np.isclose(abs(r[0]), 1) and np.isclose(abs(c[1]), 1)):
        raise ValueError(f"Solo se admiten cortes axiales: {iop}")
    return np.sign(r[0]), np.sign(c[1])


@dataclass
class Volume:
    grid: Grid
    data: np.ndarray  # (nz, ny, nx)


def _to_increasing(data, origin_xyz, spacing_xyz, sx, sy):
    """Reordena un volumen para que x e y crezcan con el índice."""
    origin = np.array(origin_xyz, float)
    nz, ny, nx = data.shape
    if sx < 0:
        data = data[:, :, ::-1]
        origin[0] = origin[0] - (nx - 1) * spacing_xyz[0]
    if sy < 0:
        data = data[:, ::-1, :]
        origin[1] = origin[1] - (ny - 1) * spacing_xyz[1]
    return np.ascontiguousarray(data), origin


# ----------------------------------------------------------------------------
# CT
# ----------------------------------------------------------------------------
def read_ct(files, series_uid=None):
    dss = []
    for f in files:
        ds = pydicom.dcmread(f, force=True)
        if series_uid and ds.SeriesInstanceUID != series_uid:
            continue
        dss.append(ds)
    if not dss:
        raise ValueError("No se han encontrado cortes de CT")
    uids = {d.SeriesInstanceUID for d in dss}
    if len(uids) > 1:
        # Se toma la serie con más cortes.
        best = max(uids, key=lambda u: sum(d.SeriesInstanceUID == u for d in dss))
        log.warning("Varias series de CT; se usa %s", best)
        dss = [d for d in dss if d.SeriesInstanceUID == best]
    sx, sy = _axis_aligned(dss[0].ImageOrientationPatient)
    dss.sort(key=lambda d: float(d.ImagePositionPatient[2]))
    z = np.array([float(d.ImagePositionPatient[2]) for d in dss])
    dz = np.diff(z)
    if dz.size and (dz.max() - dz.min()) > 0.01:
        raise ValueError("El espaciado entre cortes del CT no es uniforme")
    ps = [float(v) for v in dss[0].PixelSpacing]  # [fila, columna] = [dy, dx]
    spacing = np.array([ps[1], ps[0], dz.mean() if dz.size else 1.0])
    vol = np.stack([d.pixel_array.astype(np.float32) * float(getattr(d, "RescaleSlope", 1))
                    + float(getattr(d, "RescaleIntercept", 0)) for d in dss])
    ipp = np.array([float(v) for v in dss[0].ImagePositionPatient])
    vol, origin = _to_increasing(vol, ipp, spacing, sx, sy)
    info = {
        "series_uid": dss[0].SeriesInstanceUID,
        "frame_of_reference_uid": getattr(dss[0], "FrameOfReferenceUID", ""),
        "patient_position": getattr(dss[0], "PatientPosition", "HFS"),
        "patient_id": str(getattr(dss[0], "PatientID", "")),
        "patient_name": str(getattr(dss[0], "PatientName", "")),
        "station": str(getattr(dss[0], "StationName", "") or ""),
        "manufacturer": str(getattr(dss[0], "Manufacturer", "") or ""),
        "scanner_model": str(getattr(dss[0], "ManufacturerModelName", "") or ""),
        "kvp": str(getattr(dss[0], "KVP", "") or ""),
    }
    return Volume(Grid(origin, spacing, vol.shape), vol), info


# ----------------------------------------------------------------------------
# RTDOSE
# ----------------------------------------------------------------------------
def read_rtdose(path):
    ds = pydicom.dcmread(path, force=True)
    sx, sy = _axis_aligned(ds.ImageOrientationPatient)
    ipp = np.array([float(v) for v in ds.ImagePositionPatient])
    offs = np.array([float(v) for v in ds.GridFrameOffsetVector])
    if offs.size > 1 and not np.isclose(offs[0], 0.0) and np.isclose(offs[0], ipp[2], atol=1e-3):
        zs = offs  # desplazamientos absolutos
    else:
        zs = ipp[2] + offs
    arr = ds.pixel_array.astype(np.float64) * float(ds.DoseGridScaling)
    if arr.ndim == 2:
        arr = arr[None]
    order = np.argsort(zs)
    zs = zs[order]
    arr = arr[order]
    dz = np.diff(zs)
    if dz.size and (dz.max() - dz.min()) > 0.01:
        raise ValueError("El espaciado en z de la matriz de dosis no es uniforme")
    ps = [float(v) for v in ds.PixelSpacing]
    spacing = np.array([ps[1], ps[0], dz.mean() if dz.size else 1.0])
    origin = np.array([ipp[0], ipp[1], zs[0]])
    arr, origin = _to_increasing(arr, origin, spacing, sx, sy)
    units = str(getattr(ds, "DoseUnits", "GY")).upper()
    if units == "CGY":
        arr = arr / 100.0
    info = {
        "summation": str(getattr(ds, "DoseSummationType", "PLAN")).upper(),
        "units": "GY",
        "referenced_plan_uid": "",
        "referenced_beam_number": None,
    }
    try:
        rps = ds.ReferencedRTPlanSequence[0]
        info["referenced_plan_uid"] = rps.ReferencedSOPInstanceUID
        if hasattr(rps, "ReferencedFractionGroupSequence"):
            rb = rps.ReferencedFractionGroupSequence[0].ReferencedBeamSequence[0]
            info["referenced_beam_number"] = int(rb.ReferencedBeamNumber)
    except Exception:
        pass
    return Volume(Grid(origin, spacing, arr.shape), arr), info


def sum_rtdoses(paths):
    vols = [read_rtdose(p) for p in paths]
    v0, i0 = vols[0]
    total = v0.data.copy()
    for v, _ in vols[1:]:
        if v.grid.shape != v0.grid.shape or not np.allclose(v.grid.origin, v0.grid.origin):
            raise ValueError("Las matrices RTDOSE por haz no comparten rejilla")
        total += v.data
    info = dict(i0)
    if len(vols) > 1:
        info["summation"] = "PLAN" if i0["summation"] == "BEAM" else i0["summation"]
        info["summed_beams"] = len(vols)
    return Volume(v0.grid, total), info


# ----------------------------------------------------------------------------
# RTSTRUCT
# ----------------------------------------------------------------------------
@dataclass
class Structure:
    number: int
    name: str
    type: str = ""
    contours: list = field(default_factory=list)  # lista de arrays (N, 3) mm
    color: tuple = (255, 0, 0)
    rel_elec_density: float = None


def read_rtstruct(path):
    ds = pydicom.dcmread(path, force=True)
    rois = {}
    for r in ds.StructureSetROISequence:
        rois[int(r.ROINumber)] = Structure(int(r.ROINumber), str(r.ROIName))
    for o in getattr(ds, "RTROIObservationsSequence", []):
        n = int(o.ReferencedROINumber)
        if n not in rois:
            continue
        rois[n].type = str(getattr(o, "RTROIInterpretedType", "") or "").upper()
        for pp in getattr(o, "ROIPhysicalPropertiesSequence", []):
            if str(pp.ROIPhysicalProperty).upper() == "REL_ELEC_DENSITY":
                rois[n].rel_elec_density = float(pp.ROIPhysicalPropertyValue)
    for rc in getattr(ds, "ROIContourSequence", []):
        n = int(rc.ReferencedROINumber)
        if n not in rois:
            continue
        if hasattr(rc, "ROIDisplayColor"):
            rois[n].color = tuple(int(c) for c in rc.ROIDisplayColor)
        for c in getattr(rc, "ContourSequence", []):
            if str(getattr(c, "ContourGeometricType", "CLOSED_PLANAR")).upper() not in ("CLOSED_PLANAR",):
                continue
            pts = np.array(c.ContourData, float).reshape(-1, 3)
            if len(pts) >= 3:
                rois[n].contours.append(pts)
    info = {"referenced_series_uid": None,
            "frame_of_reference_uid": None}
    try:
        rfr = ds.ReferencedFrameOfReferenceSequence[0]
        info["frame_of_reference_uid"] = rfr.FrameOfReferenceUID
        info["referenced_series_uid"] = (rfr.RTReferencedStudySequence[0]
                                         .RTReferencedSeriesSequence[0].SeriesInstanceUID)
    except Exception:
        pass
    return [s for s in rois.values()], info


def rasterize(structure, grid, slice_tol_mm=None):
    """Máscara booleana (nz, ny, nx) de una estructura sobre una rejilla.

    Para cada plano z de la rejilla se usa el plano de contorno más próximo si
    está a menos de la mitad del espaciado entre contornos. Los contornos de un
    mismo plano se combinan con XOR (huecos e islas).
    """
    mask = np.zeros(grid.shape, dtype=bool)
    if not structure.contours:
        return mask
    zc = np.array([c[:, 2].mean() for c in structure.contours])
    uz = np.unique(np.round(zc, 2))
    if slice_tol_mm is None:
        slice_tol_mm = 0.5 * (np.median(np.diff(uz)) if uz.size > 1 else grid.spacing[2]) + 1e-3
    x, y, z = grid.axes()
    for k, zk in enumerate(z):
        if uz.size == 0:
            break
        idx = np.argmin(np.abs(uz - zk))
        if abs(uz[idx] - zk) > slice_tol_mm:
            continue
        zsel = uz[idx]
        plane = np.zeros((grid.ny, grid.nx), dtype=bool)
        for c, cz in zip(structure.contours, zc):
            if abs(round(cz, 2) - zsel) > 1e-6:
                continue
            xmin, ymin = c[:, 0].min(), c[:, 1].min()
            xmax, ymax = c[:, 0].max(), c[:, 1].max()
            i0 = max(0, int(np.floor((xmin - x[0]) / grid.spacing[0])))
            i1 = min(grid.nx, int(np.ceil((xmax - x[0]) / grid.spacing[0])) + 1)
            j0 = max(0, int(np.floor((ymin - y[0]) / grid.spacing[1])))
            j1 = min(grid.ny, int(np.ceil((ymax - y[0]) / grid.spacing[1])) + 1)
            if i1 <= i0 or j1 <= j0:
                continue
            X, Y = np.meshgrid(x[i0:i1], y[j0:j1])
            inside = MplPath(c[:, :2]).contains_points(np.column_stack([X.ravel(), Y.ravel()]))
            plane[j0:j1, i0:i1] ^= inside.reshape(X.shape)
        mask[k] = plane
    return mask


# ----------------------------------------------------------------------------
# RTPLAN
# ----------------------------------------------------------------------------
@dataclass
class ControlPoint:
    index: int
    cmw: float                 # peso acumulado normalizado (0-1)
    gantry: float
    coll: float
    couch: float
    iso: np.ndarray
    x1: float
    x2: float
    y1: float
    y2: float
    mlc_a: np.ndarray = None   # lado negativo (X1)
    mlc_b: np.ndarray = None   # lado positivo (X2)
    ssd: float = None


@dataclass
class Beam:
    number: int
    name: str
    machine: str
    energy: str
    fluence_mode: str
    sad: float
    mu: float
    beam_type: str
    radiation_type: str
    delivery_type: str
    patient_position: str
    leaf_boundaries: np.ndarray
    cps: list
    wedges: list = field(default_factory=list)
    blocks: int = 0
    applicator: str = ""
    warnings: list = field(default_factory=list)

    @property
    def is_arc(self):
        g = [cp.gantry for cp in self.cps]
        return len(g) > 1 and np.ptp(np.unwrap(np.deg2rad(g))) > 1e-3

    @property
    def technique(self):
        if self.is_arc:
            return "VMAT/arco"
        if self.mlc_moves:
            return "IMRT"
        return "Estático"

    @property
    def mlc_moves(self):
        if self.cps[0].mlc_a is None:
            return False
        a0, b0 = self.cps[0].mlc_a, self.cps[0].mlc_b
        return any(not (np.allclose(cp.mlc_a, a0) and np.allclose(cp.mlc_b, b0)) for cp in self.cps)


@dataclass
class Plan:
    label: str
    sop_uid: str
    n_fractions: int
    beams: list
    prescription_gy: float = None
    patient_position: str = "HFS"
    frame_of_reference_uid: str = ""
    patient_id: str = ""
    patient_name: str = ""


def _jaws_from_seq(seq, prev):
    x1, x2, y1, y2, a, b = prev
    for d in seq:
        t = str(d.RTBeamLimitingDeviceType).upper()
        pos = np.array([float(v) for v in d.LeafJawPositions])
        if t in ("ASYMX", "X"):
            x1, x2 = pos[0], pos[1]
        elif t in ("ASYMY", "Y"):
            y1, y2 = pos[0], pos[1]
        elif t == "MLCX":
            n = pos.size // 2
            a, b = pos[:n].copy(), pos[n:].copy()
        elif t == "MLCY":
            raise ValueError("MLCY no soportado")
        elif t.startswith("MLCX"):
            raise ValueError(f"MLC {t} (doble capa) no soportado")
    return x1, x2, y1, y2, a, b


def _applicator(b):
    seq = getattr(b, "ApplicatorSequence", None)
    if seq is None or len(seq) == 0:
        return ""
    return str(getattr(seq[0], "ApplicatorID", "") or "aplicador")


def read_rtplan(path):
    ds = pydicom.dcmread(path, force=True)
    fg = ds.FractionGroupSequence[0]
    nfx = int(getattr(fg, "NumberOfFractionsPlanned", 1) or 1)
    mu_by_beam = {}
    for rb in getattr(fg, "ReferencedBeamSequence", []):
        if hasattr(rb, "BeamMeterset"):
            mu_by_beam[int(rb.ReferencedBeamNumber)] = float(rb.BeamMeterset)
    pp_by_setup = {}
    for ps in getattr(ds, "PatientSetupSequence", []):
        pp_by_setup[int(ps.PatientSetupNumber)] = str(getattr(ps, "PatientPosition", "HFS"))
    rx = None
    for dr in getattr(ds, "DoseReferenceSequence", []):
        if hasattr(dr, "TargetPrescriptionDose"):
            rx = float(dr.TargetPrescriptionDose)
            break
    beams = []
    for b in ds.BeamSequence:
        num = int(b.BeamNumber)
        mu = mu_by_beam.get(num, 0.0)
        btype = str(getattr(b, "TreatmentDeliveryType", "TREATMENT")).upper()
        energy = None
        fmode = "STANDARD"
        if hasattr(b, "PrimaryFluenceModeSequence"):
            f = b.PrimaryFluenceModeSequence[0]
            if str(getattr(f, "FluenceMode", "STANDARD")).upper() == "NON_STANDARD":
                fmode = str(getattr(f, "FluenceModeID", "FFF")).upper()
        cp0 = b.ControlPointSequence[0]
        if hasattr(cp0, "NominalBeamEnergy"):
            energy = f"{float(cp0.NominalBeamEnergy):g}X"
        lb = None
        for bld in getattr(b, "BeamLimitingDeviceSequence", []):
            if str(bld.RTBeamLimitingDeviceType).upper() == "MLCX":
                lb = np.array([float(v) for v in bld.LeafPositionBoundaries])
        sad = float(getattr(b, "SourceAxisDistance", 1000.0))
        pp = pp_by_setup.get(int(getattr(b, "ReferencedPatientSetupNumber", 1)), "HFS")
        cps = []
        prev = (np.nan,) * 4 + (None, None)
        gantry = coll = couch = 0.0
        iso = None
        ssd = None
        final = float(getattr(b, "FinalCumulativeMetersetWeight", 1.0) or 1.0)
        for i, cp in enumerate(b.ControlPointSequence):
            if hasattr(cp, "GantryAngle"):
                gantry = float(cp.GantryAngle)
            if hasattr(cp, "BeamLimitingDeviceAngle"):
                coll = float(cp.BeamLimitingDeviceAngle)
            if hasattr(cp, "PatientSupportAngle"):
                couch = float(cp.PatientSupportAngle)
            if hasattr(cp, "IsocenterPosition"):
                iso = np.array([float(v) for v in cp.IsocenterPosition])
            if hasattr(cp, "BeamLimitingDevicePositionSequence"):
                prev = _jaws_from_seq(cp.BeamLimitingDevicePositionSequence, prev)
            ssd = float(cp.SourceToSurfaceDistance) if hasattr(cp, "SourceToSurfaceDistance") else ssd
            x1, x2, y1, y2, a, bb = prev
            cmw = float(getattr(cp, "CumulativeMetersetWeight", 0.0) or 0.0) / final
            cps.append(ControlPoint(i, cmw, gantry, coll, couch, iso, x1, x2, y1, y2,
                                    None if a is None else a.copy(),
                                    None if bb is None else bb.copy(), ssd))
        # Mandíbulas no definidas: se asume que no limitan.
        for cp in cps:
            if np.isnan(cp.x1):
                cp.x1, cp.x2 = -200.0, 200.0
            if np.isnan(cp.y1):
                cp.y1, cp.y2 = -200.0, 200.0
        wedges = []
        for w in getattr(b, "WedgeSequence", []):
            wedges.append({"type": str(getattr(w, "WedgeType", "")), "angle": float(getattr(w, "WedgeAngle", 0)),
                           "id": str(getattr(w, "WedgeID", ""))})
        beam = Beam(number=num, name=str(getattr(b, "BeamName", num)),
                    machine=str(getattr(b, "TreatmentMachineName", "")),
                    energy=energy or "", fluence_mode=fmode, sad=sad, mu=mu,
                    beam_type=btype, radiation_type=str(getattr(b, "RadiationType", "PHOTON")).upper(),
                    delivery_type=str(getattr(b, "BeamType", "STATIC")).upper(),
                    patient_position=pp, leaf_boundaries=lb, cps=cps, wedges=wedges,
                    blocks=int(getattr(b, "NumberOfBlocks", 0) or 0),
                    applicator=_applicator(b))
        if beam.wedges:
            beam.warnings.append("El haz tiene cuñas: no están modeladas")
        if beam.blocks:
            beam.warnings.append("El haz tiene bloques: no están modelados")
        if beam.applicator:
            beam.warnings.append("El haz tiene aplicador/cono: no está modelado")
        beams.append(beam)
    pos = beams[0].patient_position if beams else "HFS"
    return Plan(label=str(getattr(ds, "RTPlanLabel", "")), sop_uid=ds.SOPInstanceUID,
                n_fractions=nfx, beams=beams, prescription_gy=rx, patient_position=pos,
                frame_of_reference_uid=str(getattr(ds, "FrameOfReferenceUID", "")),
                patient_id=str(getattr(ds, "PatientID", "")),
                patient_name=str(getattr(ds, "PatientName", "")))


# ----------------------------------------------------------------------------
# Índice de una carpeta con varios pacientes, planes o series
# ----------------------------------------------------------------------------
@dataclass
class PlanEntry:
    path: Path
    uid: str
    label: str
    name: str
    date: str
    patient_id: str
    patient_name: str
    n_beams: int
    n_fractions: int
    struct_uid: str
    beams: list = field(default_factory=list)  # (nombre, máquina, energía, UM, técnica)

    def describe(self):
        d = f" · {self.date[:4]}-{self.date[4:6]}-{self.date[6:8]}" if len(self.date) >= 8 else ""
        return f"{self.label} · {self.n_beams} haces · {self.patient_id}{d}"


@dataclass
class FolderIndex:
    folder: Path
    plans: list = field(default_factory=list)
    structs: dict = field(default_factory=dict)   # uid -> dict
    cts: dict = field(default_factory=dict)       # series uid -> dict
    doses: list = field(default_factory=list)
    n_files: int = 0
    unreadable: int = 0


def index_folder(folder, progress=None):
    """Lee las cabeceras de todos los DICOM de una carpeta (recursivo)."""
    idx = FolderIndex(Path(folder))
    files = [p for p in sorted(Path(folder).rglob("*")) if p.is_file()]
    for n, p in enumerate(files):
        if progress and n % 50 == 0:
            progress(n / max(len(files), 1))
        try:
            ds = pydicom.dcmread(p, stop_before_pixels=True, force=True)
            mod = getattr(ds, "Modality", None)
        except Exception:
            idx.unreadable += 1
            continue
        if mod is None:
            continue
        idx.n_files += 1
        if mod == "CT":
            uid = str(getattr(ds, "SeriesInstanceUID", ""))
            e = idx.cts.setdefault(uid, {"files": [], "station": str(getattr(ds, "StationName", "") or ""),
                                         "manufacturer": str(getattr(ds, "Manufacturer", "") or ""),
                                         "model": str(getattr(ds, "ManufacturerModelName", "") or ""),
                                         "description": str(getattr(ds, "SeriesDescription", "") or ""),
                                         "for_uid": str(getattr(ds, "FrameOfReferenceUID", ""))})
            e["files"].append(p)
        elif mod == "RTSTRUCT":
            ref_series = None
            try:
                ref_series = (ds.ReferencedFrameOfReferenceSequence[0].RTReferencedStudySequence[0]
                              .RTReferencedSeriesSequence[0].SeriesInstanceUID)
            except Exception:
                pass
            idx.structs[str(ds.SOPInstanceUID)] = {
                "path": p, "label": str(getattr(ds, "StructureSetLabel", "")),
                "series_uid": ref_series, "n_rois": len(getattr(ds, "StructureSetROISequence", []))}
        elif mod == "RTPLAN":
            struct_uid = ""
            try:
                struct_uid = str(ds.ReferencedStructureSetSequence[0].ReferencedSOPInstanceUID)
            except Exception:
                pass
            nfx = 1
            mu = {}
            try:
                fg = ds.FractionGroupSequence[0]
                nfx = int(getattr(fg, "NumberOfFractionsPlanned", 1) or 1)
                mu = {int(r.ReferencedBeamNumber): float(getattr(r, "BeamMeterset", 0) or 0)
                      for r in getattr(fg, "ReferencedBeamSequence", [])}
            except Exception:
                pass
            beams = []
            for b in getattr(ds, "BeamSequence", []):
                if str(getattr(b, "TreatmentDeliveryType", "TREATMENT")).upper() != "TREATMENT":
                    continue
                cps = getattr(b, "ControlPointSequence", [])
                e = ""
                if len(cps) and hasattr(cps[0], "NominalBeamEnergy"):
                    e = f"{float(cps[0].NominalBeamEnergy):g}X"
                beams.append((str(getattr(b, "BeamName", "")), str(getattr(b, "TreatmentMachineName", "")),
                              e, mu.get(int(b.BeamNumber), 0.0)))
            idx.plans.append(PlanEntry(
                path=p, uid=str(ds.SOPInstanceUID), label=str(getattr(ds, "RTPlanLabel", "")),
                name=str(getattr(ds, "RTPlanName", "")), date=str(getattr(ds, "RTPlanDate", "") or ""),
                patient_id=str(getattr(ds, "PatientID", "")), patient_name=str(getattr(ds, "PatientName", "")),
                n_beams=len(beams), n_fractions=nfx, struct_uid=struct_uid, beams=beams))
        elif mod == "RTDOSE":
            ref = ""
            try:
                ref = str(ds.ReferencedRTPlanSequence[0].ReferencedSOPInstanceUID)
            except Exception:
                pass
            idx.doses.append({"path": p, "plan_uid": ref,
                              "summation": str(getattr(ds, "DoseSummationType", "")).upper(),
                              "description": str(getattr(ds, "SeriesDescription", "") or "")})
    if progress:
        progress(1.0)
    return idx


def resolve_plan(idx, plan):
    """Ficheros de CT, RTSTRUCT y RTDOSE que corresponden a un plan.

    Devuelve (ct_files, rtstruct, rtdose_list, problemas).
    """
    problems = []
    st = idx.structs.get(plan.struct_uid)
    if st is None:
        if len(idx.structs) == 1:
            st = next(iter(idx.structs.values()))
            if plan.struct_uid:
                problems.append("El RTSTRUCT de la carpeta no es el que referencia el plan")
        elif not idx.structs:
            problems.append("No hay RTSTRUCT en la carpeta")
        else:
            problems.append("Hay varios RTSTRUCT y ninguno coincide con el que referencia el plan")
    ct_files = []
    if st is not None and st["series_uid"] in idx.cts:
        ct_files = idx.cts[st["series_uid"]]["files"]
    elif len(idx.cts) == 1:
        ct_files = next(iter(idx.cts.values()))["files"]
    elif not idx.cts:
        problems.append("No hay CT en la carpeta")
    else:
        problems.append("Hay varias series de CT y no se puede saber cuál usa el plan")
    doses = [d for d in idx.doses if d["plan_uid"] == plan.uid]
    if not doses:
        problems.append("No hay RTDOSE del TPS para este plan")
    plan_d = [d for d in doses if d["summation"] in ("PLAN", "FRACTION")]
    chosen = [plan_d[0]["path"]] if plan_d else [d["path"] for d in doses if d["summation"] == "BEAM"]
    if doses and not chosen:
        chosen = [doses[0]["path"]]
    return ct_files, (st["path"] if st else None), chosen, problems
