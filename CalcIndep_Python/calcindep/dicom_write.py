"""Escritura de objetos DICOM: RTDOSE calculado y casos sintéticos de prueba."""
import datetime as _dt
from pathlib import Path

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

CT_SOP = "1.2.840.10008.5.1.4.1.1.2"
RTDOSE_SOP = "1.2.840.10008.5.1.4.1.1.481.2"
RTSTRUCT_SOP = "1.2.840.10008.5.1.4.1.1.481.3"
RTPLAN_SOP = "1.2.840.10008.5.1.4.1.1.481.5"


def _new_ds(path, sop_class, sop_uid=None):
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = sop_class
    meta.MediaStorageSOPInstanceUID = sop_uid or generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = generate_uid()
    ds = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = sop_class
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    now = _dt.datetime.now()
    ds.InstanceCreationDate = now.strftime("%Y%m%d")
    ds.InstanceCreationTime = now.strftime("%H%M%S")
    ds.SpecificCharacterSet = "ISO_IR 192"
    return ds


def _patient(ds, patient):
    ds.PatientName = patient.get("name", "SINTETICO^CASO")
    ds.PatientID = patient.get("id", "SINT001")
    ds.PatientBirthDate = ""
    ds.PatientSex = ""
    ds.StudyInstanceUID = patient["study_uid"]
    ds.StudyID = "1"
    ds.StudyDate = _dt.date.today().strftime("%Y%m%d")
    ds.StudyTime = "000000"
    ds.ReferringPhysicianName = ""
    ds.AccessionNumber = ""
    ds.FrameOfReferenceUID = patient["for_uid"]
    ds.PositionReferenceIndicator = ""


def new_patient(name="SINTETICO^CASO", pid="SINT001"):
    return {"name": name, "id": pid, "study_uid": generate_uid(), "for_uid": generate_uid()}


# ----------------------------------------------------------------------------
def write_ct_series(folder, hu, grid, patient, patient_position="HFS"):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    series = generate_uid()
    x, y, z = grid.axes()
    uids = []
    for k in range(grid.nz):
        uid = generate_uid()
        p = folder / f"CT.{k:04d}.dcm"
        ds = _new_ds(p, CT_SOP, uid)
        _patient(ds, patient)
        ds.Modality = "CT"
        ds.SeriesInstanceUID = series
        ds.SeriesNumber = 1
        ds.InstanceNumber = k + 1
        ds.PatientPosition = patient_position
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.ImagePositionPatient = [float(x[0]), float(y[0]), float(z[k])]
        ds.SliceThickness = float(grid.spacing[2])
        ds.PixelSpacing = [float(grid.spacing[1]), float(grid.spacing[0])]
        ds.Rows, ds.Columns = grid.ny, grid.nx
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 1
        ds.RescaleIntercept = 0
        ds.RescaleSlope = 1
        ds.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
        ds.PixelData = np.round(hu[k]).astype(np.int16).tobytes()
        ds.save_as(p, enforce_file_format=True)
        uids.append(uid)
    return series, uids


def mask_to_contours(mask, grid):
    from skimage import measure
    x, y, z = grid.axes()
    out = []
    for k in range(grid.nz):
        if not mask[k].any():
            continue
        padded = np.pad(mask[k].astype(float), 1)
        for c in measure.find_contours(padded, 0.5):
            if len(c) < 4:
                continue
            jj = c[:, 0] - 1
            ii = c[:, 1] - 1
            px = x[0] + ii * grid.spacing[0]
            py = y[0] + jj * grid.spacing[1]
            pts = np.column_stack([px, py, np.full_like(px, z[k])])
            out.append(pts[:-1])
    return out


def write_rtstruct(path, structures, grid, patient, ct_series_uid, ct_uids):
    """structures: lista de dicts {name, mask, type, color, red (opcional)}."""
    ds = _new_ds(path, RTSTRUCT_SOP)
    _patient(ds, patient)
    ds.Modality = "RTSTRUCT"
    ds.SeriesInstanceUID = generate_uid()
    ds.SeriesNumber = 2
    ds.StructureSetLabel = "Sintetico"
    ds.StructureSetDate = _dt.date.today().strftime("%Y%m%d")
    ds.StructureSetTime = "000000"
    rfr = Dataset()
    rfr.FrameOfReferenceUID = patient["for_uid"]
    st = Dataset()
    st.ReferencedSOPClassUID = "1.2.840.10008.3.1.2.3.1"
    st.ReferencedSOPInstanceUID = patient["study_uid"]
    se = Dataset()
    se.SeriesInstanceUID = ct_series_uid
    se.ContourImageSequence = Sequence()
    for u in ct_uids:
        ci = Dataset()
        ci.ReferencedSOPClassUID = CT_SOP
        ci.ReferencedSOPInstanceUID = u
        se.ContourImageSequence.append(ci)
    st.RTReferencedSeriesSequence = Sequence([se])
    rfr.RTReferencedStudySequence = Sequence([st])
    ds.ReferencedFrameOfReferenceSequence = Sequence([rfr])
    ds.StructureSetROISequence = Sequence()
    ds.ROIContourSequence = Sequence()
    ds.RTROIObservationsSequence = Sequence()
    for n, s in enumerate(structures, start=1):
        r = Dataset()
        r.ROINumber = n
        r.ReferencedFrameOfReferenceUID = patient["for_uid"]
        r.ROIName = s["name"]
        r.ROIGenerationAlgorithm = "MANUAL"
        ds.StructureSetROISequence.append(r)
        rc = Dataset()
        rc.ReferencedROINumber = n
        rc.ROIDisplayColor = list(s.get("color", (255, 0, 0)))
        rc.ContourSequence = Sequence()
        for pts in mask_to_contours(s["mask"], grid):
            c = Dataset()
            c.ContourGeometricType = "CLOSED_PLANAR"
            c.NumberOfContourPoints = len(pts)
            c.ContourData = [float(round(v, 3)) for v in pts.ravel()]
            rc.ContourSequence.append(c)
        ds.ROIContourSequence.append(rc)
        o = Dataset()
        o.ObservationNumber = n
        o.ReferencedROINumber = n
        o.RTROIInterpretedType = s.get("type", "ORGAN")
        o.ROIInterpreter = ""
        if s.get("red") is not None:
            pp = Dataset()
            pp.ROIPhysicalProperty = "REL_ELEC_DENSITY"
            pp.ROIPhysicalPropertyValue = float(s["red"])
            o.ROIPhysicalPropertiesSequence = Sequence([pp])
        ds.RTROIObservationsSequence.append(o)
    ds.save_as(path, enforce_file_format=True)
    return ds.SOPInstanceUID


def _bld_seq(cp, with_mlc):
    seq = Sequence()
    for t, pos in (("ASYMX", [cp["x1"], cp["x2"]]), ("ASYMY", [cp["y1"], cp["y2"]])):
        d = Dataset()
        d.RTBeamLimitingDeviceType = t
        d.LeafJawPositions = [float(v) for v in pos]
        seq.append(d)
    if with_mlc:
        d = Dataset()
        d.RTBeamLimitingDeviceType = "MLCX"
        d.LeafJawPositions = [float(v) for v in np.concatenate([cp["mlc_a"], cp["mlc_b"]])]
        seq.append(d)
    return seq


def write_rtplan(path, patient, beams, n_fractions=1, label="SINTETICO", rx_gy=None,
                 patient_position="HFS", leaf_boundaries=None, machine="TB1"):
    """beams: lista de dicts {name, mu, energy, cps:[{gantry, coll, couch, iso, x1..y2, mlc_a, mlc_b, cmw}]}."""
    ds = _new_ds(path, RTPLAN_SOP)
    _patient(ds, patient)
    ds.Modality = "RTPLAN"
    ds.SeriesInstanceUID = generate_uid()
    ds.SeriesNumber = 3
    ds.RTPlanLabel = label
    ds.RTPlanDate = _dt.date.today().strftime("%Y%m%d")
    ds.RTPlanTime = "000000"
    ds.RTPlanGeometry = "PATIENT"
    if rx_gy is not None:
        dr = Dataset()
        dr.DoseReferenceNumber = 1
        dr.DoseReferenceStructureType = "SITE"
        dr.DoseReferenceType = "TARGET"
        dr.TargetPrescriptionDose = float(rx_gy)
        ds.DoseReferenceSequence = Sequence([dr])
    ps = Dataset()
    ps.PatientSetupNumber = 1
    ps.PatientPosition = patient_position
    ds.PatientSetupSequence = Sequence([ps])
    fg = Dataset()
    fg.FractionGroupNumber = 1
    fg.NumberOfFractionsPlanned = int(n_fractions)
    fg.NumberOfBeams = len(beams)
    fg.NumberOfBrachyApplicationSetups = 0
    fg.ReferencedBeamSequence = Sequence()
    ds.BeamSequence = Sequence()
    for n, b in enumerate(beams, start=1):
        rb = Dataset()
        rb.ReferencedBeamNumber = n
        rb.BeamMeterset = float(b["mu"])
        fg.ReferencedBeamSequence.append(rb)
        bs = Dataset()
        bs.BeamNumber = n
        bs.BeamName = b["name"]
        bs.TreatmentMachineName = machine
        bs.PrimaryDosimeterUnit = "MU"
        bs.SourceAxisDistance = 1000.0
        bs.BeamType = "DYNAMIC" if len(b["cps"]) > 2 else "STATIC"
        bs.RadiationType = "PHOTON"
        bs.TreatmentDeliveryType = "TREATMENT"
        bs.NumberOfWedges = 0
        bs.NumberOfCompensators = 0
        bs.NumberOfBoli = 0
        bs.NumberOfBlocks = 0
        bs.ReferencedPatientSetupNumber = 1
        with_mlc = b["cps"][0].get("mlc_a") is not None
        bld = Sequence()
        for t in ("ASYMX", "ASYMY"):
            d = Dataset()
            d.RTBeamLimitingDeviceType = t
            d.NumberOfLeafJawPairs = 1
            bld.append(d)
        if with_mlc:
            d = Dataset()
            d.RTBeamLimitingDeviceType = "MLCX"
            d.NumberOfLeafJawPairs = len(leaf_boundaries) - 1
            d.LeafPositionBoundaries = [float(v) for v in leaf_boundaries]
            bld.append(d)
        bs.BeamLimitingDeviceSequence = bld
        bs.NumberOfControlPoints = len(b["cps"])
        bs.FinalCumulativeMetersetWeight = 1.0
        bs.ControlPointSequence = Sequence()
        for i, cp in enumerate(b["cps"]):
            c = Dataset()
            c.ControlPointIndex = i
            c.CumulativeMetersetWeight = float(cp["cmw"])
            c.GantryAngle = float(cp["gantry"])
            c.BeamLimitingDeviceAngle = float(cp.get("coll", 0.0))
            c.PatientSupportAngle = float(cp.get("couch", 0.0))
            c.BeamLimitingDevicePositionSequence = _bld_seq(cp, with_mlc)
            if i == 0:
                c.NominalBeamEnergy = float(str(b.get("energy", "6X")).rstrip("X"))
                c.IsocenterPosition = [float(v) for v in cp["iso"]]
                c.GantryRotationDirection = cp.get("gdir", "NONE")
            bs.ControlPointSequence.append(c)
        ds.BeamSequence.append(bs)
    ds.FractionGroupSequence = Sequence([fg])
    ds.save_as(path, enforce_file_format=True)
    return ds.SOPInstanceUID


def write_rtdose(path, dose_gy, grid, patient=None, template=None, plan_uid=None,
                 description="Calculo independiente CCC", summation="PLAN"):
    """Escribe una matriz de dosis (Gy) como RTDOSE.

    template: ruta o dataset RTDOSE del TPS para copiar los datos de paciente.
    """
    if template is not None:
        t = pydicom.dcmread(template) if not isinstance(template, Dataset) else template
    else:
        t = None
    ds = _new_ds(path, RTDOSE_SOP)
    if t is not None:
        for tag in ("PatientName", "PatientID", "PatientBirthDate", "PatientSex", "StudyInstanceUID",
                    "StudyID", "StudyDate", "StudyTime", "ReferringPhysicianName", "AccessionNumber",
                    "FrameOfReferenceUID", "PositionReferenceIndicator"):
            if hasattr(t, tag):
                setattr(ds, tag, getattr(t, tag))
        if plan_uid is None and hasattr(t, "ReferencedRTPlanSequence"):
            plan_uid = t.ReferencedRTPlanSequence[0].ReferencedSOPInstanceUID
    else:
        _patient(ds, patient)
    ds.Modality = "RTDOSE"
    ds.SeriesInstanceUID = generate_uid()
    ds.SeriesNumber = 99
    ds.SeriesDescription = description
    ds.DoseUnits = "GY"
    ds.DoseType = "PHYSICAL"
    ds.DoseSummationType = summation
    if plan_uid:
        r = Dataset()
        r.ReferencedSOPClassUID = RTPLAN_SOP
        r.ReferencedSOPInstanceUID = plan_uid
        ds.ReferencedRTPlanSequence = Sequence([r])
    x, y, z = grid.axes()
    ds.ImagePositionPatient = [float(x[0]), float(y[0]), float(z[0])]
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.PixelSpacing = [float(grid.spacing[1]), float(grid.spacing[0])]
    ds.SliceThickness = float(grid.spacing[2])
    ds.GridFrameOffsetVector = [float(v) for v in (z - z[0])]
    ds.FrameIncrementPointer = pydicom.tag.Tag(0x3004, 0x000C)
    ds.NumberOfFrames = grid.nz
    ds.Rows, ds.Columns = grid.ny, grid.nx
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 32
    ds.BitsStored = 32
    ds.HighBit = 31
    ds.PixelRepresentation = 0
    d = np.clip(np.asarray(dose_gy, float), 0, None)
    mx = d.max() if d.size else 0.0
    scale = mx / (2 ** 32 - 2) if mx > 0 else 1e-9
    ds.DoseGridScaling = float(f"{scale:.10e}")
    ds.PixelData = np.round(d / float(ds.DoseGridScaling)).astype(np.uint32).tobytes()
    ds.save_as(path, enforce_file_format=True)
    return ds.SOPInstanceUID
