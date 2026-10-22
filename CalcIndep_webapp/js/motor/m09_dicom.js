/* CalcIndep web · lectura y escritura DICOM (dicom_io.py, dicom_write.py).
 * Lector propio: VR explícito e implícito little endian, explícito big endian y deflate.
 * Píxeles sin comprimir (como los exporta Eclipse). */
CI_MOTOR_MODULOS.push(function CIMod_dicom(M) {
  "use strict";

  // ------------------------------------------------------------------ diccionario
  // keyword -> [tag (grupo<<16|elemento), VR]
  const DICT = {
    TransferSyntaxUID: [0x00020010, "UI"], MediaStorageSOPClassUID: [0x00020002, "UI"],
    MediaStorageSOPInstanceUID: [0x00020003, "UI"], ImplementationClassUID: [0x00020012, "UI"],
    FileMetaInformationGroupLength: [0x00020000, "UL"], FileMetaInformationVersion: [0x00020001, "OB"],
    ImplementationVersionName: [0x00020013, "SH"],
    SpecificCharacterSet: [0x00080005, "CS"], ImageType: [0x00080008, "CS"], InstanceCreationDate: [0x00080012, "DA"],
    InstanceCreationTime: [0x00080013, "TM"], SOPClassUID: [0x00080016, "UI"], SOPInstanceUID: [0x00080018, "UI"],
    StudyDate: [0x00080020, "DA"], StudyTime: [0x00080030, "TM"], AccessionNumber: [0x00080050, "SH"],
    Modality: [0x00080060, "CS"], Manufacturer: [0x00080070, "LO"], ReferringPhysicianName: [0x00080090, "PN"],
    StationName: [0x00081010, "SH"], SeriesDescription: [0x0008103E, "LO"], ManufacturerModelName: [0x00081090, "LO"],
    ReferencedSOPClassUID: [0x00081150, "UI"], ReferencedSOPInstanceUID: [0x00081155, "UI"],
    PatientName: [0x00100010, "PN"], PatientID: [0x00100020, "LO"], PatientBirthDate: [0x00100030, "DA"],
    PatientSex: [0x00100040, "CS"], SliceThickness: [0x00180050, "DS"], KVP: [0x00180060, "DS"],
    PatientPosition: [0x00185100, "CS"], StudyInstanceUID: [0x0020000D, "UI"], SeriesInstanceUID: [0x0020000E, "UI"],
    StudyID: [0x00200010, "SH"], SeriesNumber: [0x00200011, "IS"], InstanceNumber: [0x00200013, "IS"],
    ImagePositionPatient: [0x00200032, "DS"], ImageOrientationPatient: [0x00200037, "DS"],
    FrameOfReferenceUID: [0x00200052, "UI"], PositionReferenceIndicator: [0x00201040, "LO"],
    SamplesPerPixel: [0x00280002, "US"], PhotometricInterpretation: [0x00280004, "CS"],
    NumberOfFrames: [0x00280008, "IS"], FrameIncrementPointer: [0x00280009, "AT"], Rows: [0x00280010, "US"],
    Columns: [0x00280011, "US"], PixelSpacing: [0x00280030, "DS"], BitsAllocated: [0x00280100, "US"],
    BitsStored: [0x00280101, "US"], HighBit: [0x00280102, "US"], PixelRepresentation: [0x00280103, "US"],
    RescaleIntercept: [0x00281052, "DS"], RescaleSlope: [0x00281053, "DS"],
    PrimaryFluenceModeSequence: [0x30020050, "SQ"], FluenceMode: [0x30020051, "CS"], FluenceModeID: [0x30020052, "SH"],
    DoseUnits: [0x30040002, "CS"], DoseType: [0x30040004, "CS"], DoseSummationType: [0x3004000A, "CS"],
    GridFrameOffsetVector: [0x3004000C, "DS"], DoseGridScaling: [0x3004000E, "DS"],
    StructureSetLabel: [0x30060002, "SH"], StructureSetDate: [0x30060008, "DA"], StructureSetTime: [0x30060009, "TM"],
    ReferencedFrameOfReferenceSequence: [0x30060010, "SQ"], RTReferencedStudySequence: [0x30060012, "SQ"],
    RTReferencedSeriesSequence: [0x30060014, "SQ"], ContourImageSequence: [0x30060016, "SQ"],
    StructureSetROISequence: [0x30060020, "SQ"], ROINumber: [0x30060022, "IS"],
    ReferencedFrameOfReferenceUID: [0x30060024, "UI"], ROIName: [0x30060026, "LO"],
    ROIDisplayColor: [0x3006002A, "IS"], ROIGenerationAlgorithm: [0x30060036, "CS"],
    ROIContourSequence: [0x30060039, "SQ"], ContourSequence: [0x30060040, "SQ"],
    ContourGeometricType: [0x30060042, "CS"], NumberOfContourPoints: [0x30060046, "IS"],
    ContourData: [0x30060050, "DS"], RTROIObservationsSequence: [0x30060080, "SQ"],
    ObservationNumber: [0x30060082, "IS"], ReferencedROINumber: [0x30060084, "IS"],
    RTROIInterpretedType: [0x300600A4, "CS"], ROIInterpreter: [0x300600A6, "PN"],
    ROIPhysicalPropertiesSequence: [0x300600B0, "SQ"], ROIPhysicalProperty: [0x300600B2, "CS"],
    ROIPhysicalPropertyValue: [0x300600B4, "DS"],
    RTPlanLabel: [0x300A0002, "SH"], RTPlanName: [0x300A0003, "LO"], RTPlanDate: [0x300A0006, "DA"],
    RTPlanTime: [0x300A0007, "TM"], RTPlanGeometry: [0x300A000C, "CS"], DoseReferenceSequence: [0x300A0010, "SQ"],
    DoseReferenceNumber: [0x300A0012, "IS"], DoseReferenceStructureType: [0x300A0014, "CS"],
    DoseReferenceType: [0x300A0020, "CS"], TargetPrescriptionDose: [0x300A0026, "DS"],
    FractionGroupSequence: [0x300A0070, "SQ"], FractionGroupNumber: [0x300A0071, "IS"],
    NumberOfFractionsPlanned: [0x300A0078, "IS"], NumberOfBeams: [0x300A0080, "IS"],
    BeamMeterset: [0x300A0086, "DS"], NumberOfBrachyApplicationSetups: [0x300A00A0, "IS"],
    BeamSequence: [0x300A00B0, "SQ"], TreatmentMachineName: [0x300A00B2, "SH"],
    PrimaryDosimeterUnit: [0x300A00B3, "CS"], SourceAxisDistance: [0x300A00B4, "DS"],
    BeamLimitingDeviceSequence: [0x300A00B6, "SQ"], RTBeamLimitingDeviceType: [0x300A00B8, "CS"],
    NumberOfLeafJawPairs: [0x300A00BC, "IS"], LeafPositionBoundaries: [0x300A00BE, "DS"],
    BeamNumber: [0x300A00C0, "IS"], BeamName: [0x300A00C2, "LO"], BeamType: [0x300A00C4, "CS"],
    RadiationType: [0x300A00C6, "CS"], TreatmentDeliveryType: [0x300A00CE, "CS"], NumberOfWedges: [0x300A00D0, "IS"],
    WedgeSequence: [0x300A00D1, "SQ"], WedgeType: [0x300A00D3, "CS"], WedgeID: [0x300A00D4, "SH"],
    WedgeAngle: [0x300A00D5, "IS"], NumberOfCompensators: [0x300A00E0, "IS"], NumberOfBoli: [0x300A00ED, "IS"],
    NumberOfBlocks: [0x300A00F0, "IS"], ApplicatorSequence: [0x300A0107, "SQ"], ApplicatorID: [0x300A0108, "SH"],
    FinalCumulativeMetersetWeight: [0x300A010E, "DS"], NumberOfControlPoints: [0x300A0110, "IS"],
    ControlPointSequence: [0x300A0111, "SQ"], ControlPointIndex: [0x300A0112, "IS"],
    NominalBeamEnergy: [0x300A0114, "DS"], BeamLimitingDevicePositionSequence: [0x300A011A, "SQ"],
    LeafJawPositions: [0x300A011C, "DS"], GantryAngle: [0x300A011E, "DS"], GantryRotationDirection: [0x300A011F, "CS"],
    BeamLimitingDeviceAngle: [0x300A0120, "DS"], PatientSupportAngle: [0x300A0122, "DS"],
    IsocenterPosition: [0x300A012C, "DS"], SourceToSurfaceDistance: [0x300A0130, "DS"],
    CumulativeMetersetWeight: [0x300A0134, "DS"], PatientSetupSequence: [0x300A0180, "SQ"],
    PatientSetupNumber: [0x300A0182, "IS"],
    ReferencedRTPlanSequence: [0x300C0002, "SQ"], ReferencedBeamSequence: [0x300C0004, "SQ"],
    ReferencedBeamNumber: [0x300C0006, "IS"], ReferencedFractionGroupSequence: [0x300C0020, "SQ"],
    ReferencedStructureSetSequence: [0x300C0060, "SQ"], ReferencedPatientSetupNumber: [0x300C006A, "IS"],
    PixelData: [0x7FE00010, "OW"],
  };
  const TAG2 = new Map();
  for (const [k, [t, vr]] of Object.entries(DICT)) TAG2.set(t, [k, vr]);
  M.DICOM_DICT = DICT;

  const EXPLICIT_LONG = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);
  const ITEM = 0xFFFEE000, ITEM_DELIM = 0xFFFEE00D, SEQ_DELIM = 0xFFFEE0DD;

  function decoderFor(charset) {
    const cs = (charset || "").split("\\").map(s => s.trim().toUpperCase()).filter(Boolean);
    let enc = "latin1";
    for (const c of cs) {
      if (c === "ISO_IR 192") enc = "utf-8";
      else if (c === "ISO_IR 100" || c === "ISO 2022 IR 100") enc = "latin1";
      else if (c === "ISO_IR 101") enc = "iso-8859-2";
      else if (c === "ISO_IR 148") enc = "windows-1254";
    }
    try { return new TextDecoder(enc); } catch (e) { return new TextDecoder("latin1"); }
  }

  class Dataset {
    constructor(dec) { this.el = new Map(); this.dec = dec; this.truncated = false; }
    tag(t) { return this.el.get(t); }
    has(k) { const d = DICT[k]; return !!d && this.el.has(d[0]); }
    raw(k) { const d = DICT[k]; const e = d && this.el.get(d[0]); return e ? e : null; }
    // Valor en el estilo de pydicom: str, número, lista de números/cadenas o lista de Dataset
    get(k, def) {
      const e = this.raw(k);
      if (!e) return def;
      return decodeValue(e, this.dec);
    }
    str(k, def) {
      const v = this.get(k, undefined);
      if (v === undefined) return def === undefined ? "" : def;
      if (v === null) return "None";
      if (Array.isArray(v)) return "[" + v.map(x => typeof x === "string" ? `'${x}'` : String(x)).join(", ") + "]";
      return String(v);
    }
    seq(k) {
      const e = this.raw(k);
      if (!e) return [];
      return e.items || [];
    }
  }
  M.DicomDataset = Dataset;

  function decodeValue(e, dec) {
    if (e.items) return e.items;
    const vr = e.vr;
    const b = e.bytes;
    if (vr === "US" || vr === "SS" || vr === "UL" || vr === "SL" || vr === "FL" || vr === "FD" || vr === "AT") {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const le = e.le;
      const out = [];
      const size = { US: 2, SS: 2, UL: 4, SL: 4, FL: 4, FD: 8, AT: 4 }[vr];
      for (let o = 0; o + size <= b.byteLength; o += size) {
        if (vr === "US") out.push(dv.getUint16(o, le));
        else if (vr === "SS") out.push(dv.getInt16(o, le));
        else if (vr === "UL") out.push(dv.getUint32(o, le));
        else if (vr === "SL") out.push(dv.getInt32(o, le));
        else if (vr === "FL") out.push(dv.getFloat32(o, le));
        else if (vr === "FD") out.push(dv.getFloat64(o, le));
        else out.push((dv.getUint16(o, le) << 16 | dv.getUint16(o + 2, le)) >>> 0);
      }
      if (!out.length) return null;
      return out.length === 1 ? out[0] : out;
    }
    if (vr === "OB" || vr === "OW" || vr === "UN" || vr === "OF" || vr === "OD" || vr === "OL") return b;
    let s = (vr === "UI" || vr === "CS" || vr === "DS" || vr === "IS" || vr === "DA" || vr === "TM" || vr === "AS")
      ? latin1(b) : dec.decode(b);
    // quitar relleno
    if (vr === "UI") s = s.replace(/\0+$/, "");
    if (vr === "LT" || vr === "ST" || vr === "UT") s = s.replace(/[\0 ]+$/, "");
    const parts = (vr === "LT" || vr === "ST" || vr === "UT") ? [s] : s.split("\\");
    const clean = parts.map(p => (vr === "LT" || vr === "ST" || vr === "UT") ? p :
      (vr === "UI" ? p.replace(/\0/g, "").trim() : p.replace(/^[ \0]+|[ \0]+$/g, "")));
    if (vr === "DS") {
      const nums = clean.map(p => p === "" ? null : Number(p));
      if (nums.length === 1) return nums[0];
      return nums;
    }
    if (vr === "IS") {
      const nums = clean.map(p => p === "" ? null : parseInt(Number(p), 10));
      if (nums.length === 1) return nums[0];
      return nums;
    }
    if (clean.length === 1) return clean[0];
    return clean;
  }
  function latin1(b) {
    let s = "";
    const n = b.byteLength;
    for (let i = 0; i < n; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(n, i + 8192)));
    return s;
  }

  // ------------------------------------------------------------------ lectura
  class TruncatedError extends Error {}
  function parseElements(buf, off, end, explicit, le, ds, opts, depth) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    while (off < end) {
      if (off + 8 > end) throw new TruncatedError("fin inesperado");
      const g = dv.getUint16(off, le), el = dv.getUint16(off + 2, le);
      const tag = ((g << 16) | el) >>> 0;
      if (tag === ITEM_DELIM || tag === SEQ_DELIM) return { off: off + 8, delim: tag };
      if (opts.stopBeforePixels && tag === 0x7FE00010 && depth === 0) { ds.stoppedAtPixels = true; return { off: end }; }
      let vr, len, hdr;
      if (g === 0xFFFE) { vr = null; len = dv.getUint32(off + 4, le); hdr = 8; }
      else if (explicit) {
        vr = String.fromCharCode(buf[off + 4], buf[off + 5]);
        if (!/^[A-Z]{2}$/.test(vr)) {   // VR no válido: se trata como implícito
          vr = (TAG2.get(tag) || [null, "UN"])[1];
          len = dv.getUint32(off + 4, le); hdr = 8;
        } else if (EXPLICIT_LONG.has(vr)) { len = dv.getUint32(off + 8, le); hdr = 12; }
        else { len = dv.getUint16(off + 6, le); hdr = 8; }
      } else {
        vr = (TAG2.get(tag) || [null, null])[1];
        len = dv.getUint32(off + 4, le); hdr = 8;
        if (el === 0x0000) vr = "UL";
      }
      off += hdr;
      const undefinedLen = len === 0xFFFFFFFF;
      // ¿secuencia?
      let isSeq = vr === "SQ";
      if (!isSeq && (vr === null || vr === "UN") && undefinedLen && tag !== 0x7FE00010) isSeq = true;
      if (!isSeq && vr === null && !undefinedLen && len >= 8 && off + 4 <= end) {
        const t2 = ((dv.getUint16(off, le) << 16) | dv.getUint16(off + 2, le)) >>> 0;
        if (t2 === ITEM) isSeq = true;
      }
      if (isSeq) {
        const items = [];
        const seqEnd = undefinedLen ? end : off + len;
        if (!undefinedLen && seqEnd > end) throw new TruncatedError("secuencia truncada");
        let p = off;
        while (p < seqEnd) {
          if (p + 8 > end) throw new TruncatedError("fin inesperado");
          const it = ((dv.getUint16(p, le) << 16) | dv.getUint16(p + 2, le)) >>> 0;
          const ilen = dv.getUint32(p + 4, le);
          p += 8;
          if (it === SEQ_DELIM) break;
          if (it !== ITEM) throw new Error("Elemento de secuencia no válido");
          const sub = new Dataset(ds.dec);
          if (ilen === 0xFFFFFFFF) {
            const r = parseElements(buf, p, end, explicit, le, sub, opts, depth + 1);
            p = r.off;
          } else {
            if (p + ilen > end) throw new TruncatedError("ítem truncado");
            parseElements(buf, p, p + ilen, explicit, le, sub, opts, depth + 1);
            p += ilen;
          }
          items.push(sub);
        }
        off = undefinedLen ? p : off + len;
        ds.el.set(tag, { vr: "SQ", items, le });
        continue;
      }
      if (undefinedLen) {
        // datos encapsulados (píxeles comprimidos): se busca el delimitador
        let p = off;
        while (p + 8 <= end) {
          const it = ((dv.getUint16(p, le) << 16) | dv.getUint16(p + 2, le)) >>> 0;
          const ilen = dv.getUint32(p + 4, le);
          p += 8;
          if (it === SEQ_DELIM) break;
          p += ilen;
        }
        ds.el.set(tag, { vr: vr || "OB", bytes: buf.subarray(off, Math.min(p, end)), le, encapsulated: true });
        off = p;
        continue;
      }
      if (off + len > end) {
        if (tag === 0x7FE00010) { ds.truncated = true; return { off: end }; }
        throw new TruncatedError("valor truncado");
      }
      ds.el.set(tag, { vr: vr || "UN", bytes: buf.subarray(off, off + len), le });
      if (tag === 0x00080005) ds.dec = decoderFor(latin1(buf.subarray(off, off + len)));
      off += len;
    }
    return { off };
  }

  // Lee un fichero DICOM (Uint8Array o ArrayBuffer). opts: {stopBeforePixels}
  M.dcmread = async function (input, opts) {
    opts = opts || {};
    let buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    let off = 0;
    const hasPreamble = buf.byteLength >= 132 && buf[128] === 0x44 && buf[129] === 0x49 && buf[130] === 0x43 && buf[131] === 0x4D;
    if (hasPreamble) off = 132;
    else if (!opts.force) throw new Error("No es un fichero DICOM");
    const ds = new Dataset(new TextDecoder("latin1"));
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // grupo 0002 (siempre VR explícito little endian)
    let ts = "1.2.840.10008.1.2";
    let metaGroup = false;
    if (buf.byteLength >= off + 6 && dv.getUint16(off, true) === 0x0002) {
      metaGroup = true;
      const meta = new Dataset(ds.dec);
      let p = off;
      while (p + 8 <= buf.byteLength && dv.getUint16(p, true) === 0x0002) {
        const vr2 = String.fromCharCode(buf[p + 4], buf[p + 5]);
        const lng = EXPLICIT_LONG.has(vr2);
        const elEnd = p + (lng ? 12 + dv.getUint32(p + 8, true) : 8 + dv.getUint16(p + 6, true));
        const r = parseElements(buf, p, Math.min(elEnd, buf.byteLength), true, true, meta, {}, 0);
        p = r.off;
      }
      for (const [t, e] of meta.el) ds.el.set(t, e);
      const tsv = meta.get("TransferSyntaxUID");
      if (tsv) ts = String(tsv);
      off = p;
    } else {
      // sin cabecera: se deduce si el VR es explícito
      if (buf.byteLength >= off + 8) {
        const vr = String.fromCharCode(buf[off + 4], buf[off + 5]);
        ts = /^[A-Z]{2}$/.test(vr) && (DICT && true) ? "1.2.840.10008.1.2.1" : "1.2.840.10008.1.2";
      }
    }
    let explicit = ts !== "1.2.840.10008.1.2";
    let le = ts !== "1.2.840.10008.1.2.2";
    if (ts === "1.2.840.10008.1.2.1.99") {
      if (typeof DecompressionStream === "undefined")
        throw new Error("DICOM comprimido con deflate: este navegador no puede leerlo");
      const ds2 = new DecompressionStream("deflate-raw");
      const stream = new Blob([buf.subarray(off)]).stream().pipeThrough(ds2);
      const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
      buf = inflated; off = 0;
    }
    ds.transferSyntax = ts;
    ds.compressed = !["1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2", "1.2.840.10008.1.2.1.99"].includes(ts);
    ds.hasMeta = metaGroup;
    try {
      parseElements(buf, off, buf.byteLength, explicit, le, ds, opts, 0);
    } catch (e) {
      if (e instanceof TruncatedError) { ds.truncated = true; if (!opts.allowTruncated) throw e; }
      else throw e;
    }
    return ds;
  };

  // Matriz de píxeles: Int/Float array (frames*rows*cols) con el signo resuelto
  M.pixelArray = function (ds) {
    const e = ds.raw("PixelData");
    if (!e) throw new Error("El fichero no tiene datos de imagen");
    if (ds.compressed || e.encapsulated)
      throw new Error(`Imagen DICOM comprimida (sintaxis ${ds.transferSyntax}): exporte sin compresión`);
    const rows = ds.get("Rows"), cols = ds.get("Columns");
    const frames = ds.has("NumberOfFrames") ? (parseInt(ds.get("NumberOfFrames"), 10) || 1) : 1;
    const ba = ds.get("BitsAllocated"), bs = ds.get("BitsStored", ba), pr = ds.get("PixelRepresentation", 0);
    const n = rows * cols * frames;
    const b = e.bytes;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const le = e.le;
    let out;
    if (ba === 16) {
      out = pr ? new Int16Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) out[i] = pr ? dv.getInt16(2 * i, le) : dv.getUint16(2 * i, le);
      if (pr && bs < 16) { const sh = 32 - bs; for (let i = 0; i < n; i++) out[i] = (out[i] << sh) >> sh; }
    } else if (ba === 32) {
      out = pr ? new Int32Array(n) : new Uint32Array(n);
      for (let i = 0; i < n; i++) out[i] = pr ? dv.getInt32(4 * i, le) : dv.getUint32(4 * i, le);
    } else if (ba === 8) {
      out = pr ? new Int8Array(n) : new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = pr ? dv.getInt8(i) : dv.getUint8(i);
    } else throw new Error(`BitsAllocated = ${ba} no admitido`);
    return { data: out, rows, cols, frames };
  };

  // ------------------------------------------------------------------ utilidades
  function axisAligned(iop) {
    const r = iop.slice(0, 3), c = iop.slice(3, 6);
    const isclose = (a, b) => Math.abs(a - b) <= 1e-8 + 1e-5 * Math.abs(b);
    const ok = [r, c].every(v => v.filter(x => isclose(Math.abs(x), 1.0)).length === 1 &&
                                 v.filter(x => isclose(Math.abs(x), 0.0)).length === 2);
    if (!ok) throw new Error(`Orientación de imagen no alineada con los ejes: [${iop.join(" ")}]`);
    if (!(isclose(Math.abs(r[0]), 1) && isclose(Math.abs(c[1]), 1))) throw new Error(`Solo se admiten cortes axiales: [${iop.join(" ")}]`);
    return [M.sign(r[0]), M.sign(c[1])];
  }
  function toIncreasing(data, shape, origin, spacing, sx, sy) {
    const [nz, ny, nx] = shape;
    const o = origin.slice();
    if (sx >= 0 && sy >= 0) return [data, o];
    const out = new data.constructor(data.length);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const jj = sy < 0 ? ny - 1 - j : j, ii = sx < 0 ? nx - 1 - i : i;
      out[(k * ny + j) * nx + i] = data[(k * ny + jj) * nx + ii];
    }
    if (sx < 0) o[0] = o[0] - (nx - 1) * spacing[0];
    if (sy < 0) o[1] = o[1] - (ny - 1) * spacing[1];
    return [out, o];
  }
  const numList = v => (Array.isArray(v) ? v : [v]).map(Number);
  const strOr = (ds, k, def) => { const v = ds.get(k, undefined); return (v === undefined || v === null) ? def : String(v); };

  // ------------------------------------------------------------------ CT
  // dss: lista de Dataset completos (con píxeles)
  M.readCT = function (dssAll, seriesUid) {
    let dss = dssAll.filter(d => !seriesUid || d.get("SeriesInstanceUID") === seriesUid);
    if (!dss.length) throw new Error("No se han encontrado cortes de CT");
    const uids = new Set(dss.map(d => d.get("SeriesInstanceUID")));
    if (uids.size > 1) {
      let best = null, bn = -1;
      for (const u of uids) { const n = dss.filter(d => d.get("SeriesInstanceUID") === u).length; if (n > bn) { bn = n; best = u; } }
      dss = dss.filter(d => d.get("SeriesInstanceUID") === best);
    }
    const [sx, sy] = axisAligned(numList(dss[0].get("ImageOrientationPatient")));
    dss = dss.map((d, i) => [d, i]).sort((a, b) => (numList(a[0].get("ImagePositionPatient"))[2] -
      numList(b[0].get("ImagePositionPatient"))[2]) || (a[1] - b[1])).map(x => x[0]);
    const z = dss.map(d => numList(d.get("ImagePositionPatient"))[2]);
    const dz = M.diff(Float64Array.from(z));
    if (dz.length && (M.max(dz) - M.min(dz)) > 0.01) throw new Error("El espaciado entre cortes del CT no es uniforme");
    const ps = numList(dss[0].get("PixelSpacing"));
    const spacing = [ps[1], ps[0], dz.length ? M.npsum(dz) / dz.length : 1.0];
    const rows = dss[0].get("Rows"), cols = dss[0].get("Columns");
    const vol = new Float32Array(dss.length * rows * cols);
    dss.forEach((d, k) => {
      const px = M.pixelArray(d);
      if (px.rows !== rows || px.cols !== cols) throw new Error("Los cortes del CT no tienen el mismo tamaño");
      const slope = Math.fround(Number(d.get("RescaleSlope", 1)));
      const inter = Math.fround(Number(d.get("RescaleIntercept", 0)));
      const off = k * rows * cols;
      for (let q = 0; q < rows * cols; q++) vol[off + q] = Math.fround(Math.fround(px.data[q] * slope) + inter);
    });
    const ipp = numList(dss[0].get("ImagePositionPatient"));
    const shape = [dss.length, rows, cols];
    const [data, origin] = toIncreasing(vol, shape, ipp, spacing, sx, sy);
    const d0 = dss[0];
    const info = {
      series_uid: strOr(d0, "SeriesInstanceUID", ""), frame_of_reference_uid: strOr(d0, "FrameOfReferenceUID", ""),
      patient_position: strOr(d0, "PatientPosition", "HFS"), patient_id: strOr(d0, "PatientID", ""),
      patient_name: strOr(d0, "PatientName", ""), station: strOr(d0, "StationName", ""),
      manufacturer: strOr(d0, "Manufacturer", ""), scanner_model: strOr(d0, "ManufacturerModelName", ""),
      kvp: strOr(d0, "KVP", ""),
    };
    return [{ grid: new M.Grid(origin, spacing, shape), data }, info];
  };

  // ------------------------------------------------------------------ RTDOSE
  M.readRTDose = function (ds) {
    const [sx, sy] = axisAligned(numList(ds.get("ImageOrientationPatient")));
    const ipp = numList(ds.get("ImagePositionPatient"));
    let offs = numList(ds.get("GridFrameOffsetVector"));
    let zs;
    const isc = (a, b, atol) => Math.abs(a - b) <= (atol === undefined ? 1e-8 : atol) + 1e-5 * Math.abs(b);
    if (offs.length > 1 && !isc(offs[0], 0.0) && isc(offs[0], ipp[2], 1e-3)) zs = offs.slice();
    else zs = offs.map(o => ipp[2] + o);
    const px = M.pixelArray(ds);
    const scale = Number(ds.get("DoseGridScaling"));
    const nf = px.frames, rows = px.rows, cols = px.cols;
    const order = M.argsort(zs);
    const zsorted = order.map(i => zs[i]);
    const arr = new Float64Array(nf * rows * cols);
    order.forEach((src, k) => {
      for (let q = 0; q < rows * cols; q++) arr[k * rows * cols + q] = px.data[src * rows * cols + q] * scale;
    });
    const dz = M.diff(Float64Array.from(zsorted));
    if (dz.length && (M.max(dz) - M.min(dz)) > 0.01) throw new Error("El espaciado en z de la matriz de dosis no es uniforme");
    const ps = numList(ds.get("PixelSpacing"));
    const spacing = [ps[1], ps[0], dz.length ? M.npsum(dz) / dz.length : 1.0];
    const origin0 = [ipp[0], ipp[1], zsorted[0]];
    const shape = [nf, rows, cols];
    let [data, origin] = toIncreasing(arr, shape, origin0, spacing, sx, sy);
    const units = strOr(ds, "DoseUnits", "GY").toUpperCase();
    if (units === "CGY") data = data.map(v => v / 100.0);
    const info = { summation: strOr(ds, "DoseSummationType", "PLAN").toUpperCase(), units: "GY",
                   referenced_plan_uid: "", referenced_beam_number: null };
    try {
      const rps = ds.seq("ReferencedRTPlanSequence")[0];
      info.referenced_plan_uid = String(rps.get("ReferencedSOPInstanceUID"));
      if (rps.has("ReferencedFractionGroupSequence")) {
        const rb = rps.seq("ReferencedFractionGroupSequence")[0].seq("ReferencedBeamSequence")[0];
        info.referenced_beam_number = parseInt(rb.get("ReferencedBeamNumber"), 10);
      }
    } catch (e) { /* sin referencia */ }
    if (info.referenced_plan_uid === "undefined") info.referenced_plan_uid = "";
    return [{ grid: new M.Grid(origin, spacing, shape), data }, info];
  };
  M.sumRTDoses = function (dss) {
    const vols = dss.map(d => M.readRTDose(d));
    const [v0, i0] = vols[0];
    const total = Float64Array.from(v0.data);
    for (const [v] of vols.slice(1)) {
      if (!v.grid.shape.every((s, i) => s === v0.grid.shape[i]) ||
          !Array.from(v.grid.origin).every((o, i) => M.allclose([o], [v0.grid.origin[i]])))
        throw new Error("Las matrices RTDOSE por haz no comparten rejilla");
      for (let p = 0; p < total.length; p++) total[p] += v.data[p];
    }
    const info = Object.assign({}, i0);
    if (vols.length > 1) {
      info.summation = i0.summation === "BEAM" ? "PLAN" : i0.summation;
      info.summed_beams = vols.length;
    }
    return [{ grid: v0.grid, data: total }, info];
  };

  // ------------------------------------------------------------------ RTSTRUCT
  M.readRTStruct = function (ds) {
    const rois = new Map();
    for (const r of ds.seq("StructureSetROISequence")) {
      const n = parseInt(r.get("ROINumber"), 10);
      rois.set(n, { number: n, name: strOr(r, "ROIName", ""), type: "", contours: [], color: [255, 0, 0],
                    rel_elec_density: null });
    }
    for (const o of ds.seq("RTROIObservationsSequence")) {
      const n = parseInt(o.get("ReferencedROINumber"), 10);
      if (!rois.has(n)) continue;
      const v = o.get("RTROIInterpretedType", "");
      rois.get(n).type = (v === null || v === undefined ? "" : String(v)).toUpperCase();
      for (const pp of o.seq("ROIPhysicalPropertiesSequence"))
        if (String(pp.get("ROIPhysicalProperty")).toUpperCase() === "REL_ELEC_DENSITY")
          rois.get(n).rel_elec_density = Number(pp.get("ROIPhysicalPropertyValue"));
    }
    for (const rc of ds.seq("ROIContourSequence")) {
      const n = parseInt(rc.get("ReferencedROINumber"), 10);
      if (!rois.has(n)) continue;
      if (rc.has("ROIDisplayColor")) rois.get(n).color = numList(rc.get("ROIDisplayColor")).map(v => Math.trunc(v));
      for (const c of rc.seq("ContourSequence")) {
        if (String(c.get("ContourGeometricType", "CLOSED_PLANAR")).toUpperCase() !== "CLOSED_PLANAR") continue;
        const v = c.get("ContourData");
        const pts = Float64Array.from(numList(v));
        const np = Math.floor(pts.length / 3);
        if (np >= 3) rois.get(n).contours.push(pts.subarray(0, np * 3));
      }
    }
    const info = { referenced_series_uid: null, frame_of_reference_uid: null };
    try {
      const rfr = ds.seq("ReferencedFrameOfReferenceSequence")[0];
      info.frame_of_reference_uid = String(rfr.get("FrameOfReferenceUID"));
      info.referenced_series_uid = String(rfr.seq("RTReferencedStudySequence")[0].seq("RTReferencedSeriesSequence")[0]
        .get("SeriesInstanceUID"));
    } catch (e) { /* sin referencia */ }
    return [Array.from(rois.values()), info];
  };

  // ------------------------------------------------------------------ rasterizado
  // Path.contains_points de matplotlib (prueba de cruces, mismas comparaciones)
  function pointsInPolygon(xs, ys, nPts, px, py, outFlags) {
    // xs, ys: vértices del contorno; px, py: puntos (arrays); outFlags: Uint8Array (resultado)
    const n = px.length;
    const yflag0 = new Uint8Array(n);
    const sub = new Uint8Array(n);
    let vtx0 = xs[0], vty0 = ys[0], vtx1 = xs[0], vty1 = ys[0];
    const sx = xs[0], sy = ys[0];
    for (let i = 0; i < n; i++) { yflag0[i] = (vty0 >= py[i]) ? 1 : 0; sub[i] = 0; }
    // vértices 1..nPts-1, luego el cierre (stop -> vuelve a sx, sy)
    for (let q = 1; q <= nPts; q++) {
      const x = q < nPts ? xs[q] : sx, y = q < nPts ? ys[q] : sy;
      for (let i = 0; i < n; i++) {
        const tx = px[i], ty = py[i];
        const yflag1 = (vty1 >= ty) ? 1 : 0;
        if (yflag0[i] !== yflag1) {
          if ((((vty1 - ty) * (vtx0 - vtx1) >= (vtx1 - tx) * (vty0 - vty1)) ? 1 : 0) === yflag1) sub[i] ^= 1;
        }
        yflag0[i] = yflag1;
      }
      vtx0 = vtx1; vty0 = vty1; vtx1 = x; vty1 = y;
    }
    // último tramo (tras el bucle)
    for (let i = 0; i < n; i++) {
      const tx = px[i], ty = py[i];
      const yflag1 = (vty1 >= ty) ? 1 : 0;
      if (yflag0[i] !== yflag1) {
        if ((((vty1 - ty) * (vtx0 - vtx1) >= (vtx1 - tx) * (vty0 - vty1)) ? 1 : 0) === yflag1) sub[i] ^= 1;
      }
      outFlags[i] = sub[i];
    }
  }
  M.pointsInPolygon = pointsInPolygon;

  // Máscara (Uint8Array nz*ny*nx) de una estructura en una rejilla
  M.rasterize = function (structure, grid, sliceTol) {
    const [nz, ny, nx] = grid.shape;
    const mask = new Uint8Array(nz * ny * nx);
    const contours = structure.contours || [];
    if (!contours.length) return mask;
    const zc = contours.map(c => {
      const n = c.length / 3;
      const zz = new Float64Array(n);
      for (let q = 0; q < n; q++) zz[q] = c[3 * q + 2];
      return M.npsum(zz) / n;
    });
    const uz = M.uniqueSorted(Float64Array.from(zc, v => M.npRound(v, 2)));
    if (sliceTol === undefined || sliceTol === null)
      sliceTol = 0.5 * (uz.length > 1 ? M.median(M.diff(uz)) : grid.spacing[2]) + 1e-3;
    const [x, y, z] = grid.axes();
    const plane = new Uint8Array(ny * nx);
    for (let k = 0; k < nz; k++) {
      if (!uz.length) break;
      const idx = M.argminAbs(uz, z[k]);
      if (Math.abs(uz[idx] - z[k]) > sliceTol) continue;
      const zsel = uz[idx];
      plane.fill(0);
      for (let ci = 0; ci < contours.length; ci++) {
        if (Math.abs(M.pyRound(zc[ci], 2) - zsel) > 1e-6) continue;
        const c = contours[ci];
        const n = c.length / 3;
        const xs = new Float64Array(n), ys = new Float64Array(n);
        let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
        for (let q = 0; q < n; q++) {
          xs[q] = c[3 * q]; ys[q] = c[3 * q + 1];
          if (xs[q] < xmin) xmin = xs[q]; if (xs[q] > xmax) xmax = xs[q];
          if (ys[q] < ymin) ymin = ys[q]; if (ys[q] > ymax) ymax = ys[q];
        }
        const i0 = Math.max(0, Math.floor((xmin - x[0]) / grid.spacing[0]));
        const i1 = Math.min(nx, Math.ceil((xmax - x[0]) / grid.spacing[0]) + 1);
        const j0 = Math.max(0, Math.floor((ymin - y[0]) / grid.spacing[1]));
        const j1 = Math.min(ny, Math.ceil((ymax - y[0]) / grid.spacing[1]) + 1);
        if (i1 <= i0 || j1 <= j0) continue;
        const w = i1 - i0, h = j1 - j0;
        const px = new Float64Array(w * h), py = new Float64Array(w * h);
        for (let jj = 0; jj < h; jj++) for (let ii = 0; ii < w; ii++) { px[jj * w + ii] = x[i0 + ii]; py[jj * w + ii] = y[j0 + jj]; }
        const inside = new Uint8Array(w * h);
        pointsInPolygon(xs, ys, n, px, py, inside);
        for (let jj = 0; jj < h; jj++) for (let ii = 0; ii < w; ii++)
          plane[(j0 + jj) * nx + i0 + ii] ^= inside[jj * w + ii];
      }
      mask.set(plane, k * ny * nx);
    }
    return mask;
  };

  // ------------------------------------------------------------------ RTPLAN
  function jawsFromSeq(seq, prev) {
    let [x1, x2, y1, y2, a, b] = prev;
    for (const d of seq) {
      const t = String(d.get("RTBeamLimitingDeviceType")).toUpperCase();
      const pos = numList(d.get("LeafJawPositions"));
      if (t === "ASYMX" || t === "X") { x1 = pos[0]; x2 = pos[1]; }
      else if (t === "ASYMY" || t === "Y") { y1 = pos[0]; y2 = pos[1]; }
      else if (t === "MLCX") { const n = Math.floor(pos.length / 2); a = Float64Array.from(pos.slice(0, n)); b = Float64Array.from(pos.slice(n)); }
      else if (t === "MLCY") throw new Error("MLCY no soportado");
      else if (t.startsWith("MLCX")) throw new Error(`MLC ${t} (doble capa) no soportado`);
    }
    return [x1, x2, y1, y2, a, b];
  }
  M.readRTPlan = function (ds) {
    const fg = ds.seq("FractionGroupSequence")[0];
    if (!fg) throw new Error("El RTPLAN no tiene FractionGroupSequence");
    const nfx = parseInt(fg.get("NumberOfFractionsPlanned", 1) || 1, 10) || 1;
    const muBy = new Map();
    for (const rb of fg.seq("ReferencedBeamSequence"))
      if (rb.has("BeamMeterset")) muBy.set(parseInt(rb.get("ReferencedBeamNumber"), 10), Number(rb.get("BeamMeterset")));
    const ppBy = new Map();
    for (const ps of ds.seq("PatientSetupSequence")) ppBy.set(parseInt(ps.get("PatientSetupNumber"), 10), strOr(ps, "PatientPosition", "HFS"));
    let rx = null;
    for (const dr of ds.seq("DoseReferenceSequence")) if (dr.has("TargetPrescriptionDose")) { rx = Number(dr.get("TargetPrescriptionDose")); break; }
    const beams = [];
    for (const b of ds.seq("BeamSequence")) {
      const num = parseInt(b.get("BeamNumber"), 10);
      const mu = muBy.has(num) ? muBy.get(num) : 0.0;
      const btype = strOr(b, "TreatmentDeliveryType", "TREATMENT").toUpperCase();
      let energy = null, fmode = "STANDARD";
      if (b.has("PrimaryFluenceModeSequence")) {
        const f = b.seq("PrimaryFluenceModeSequence")[0];
        if (f && strOr(f, "FluenceMode", "STANDARD").toUpperCase() === "NON_STANDARD")
          fmode = strOr(f, "FluenceModeID", "FFF").toUpperCase();
      }
      const cpsq = b.seq("ControlPointSequence");
      const cp0 = cpsq[0];
      if (cp0 && cp0.has("NominalBeamEnergy")) energy = `${M.fmtG(Number(cp0.get("NominalBeamEnergy")))}X`;
      let lb = null;
      for (const bld of b.seq("BeamLimitingDeviceSequence"))
        if (String(bld.get("RTBeamLimitingDeviceType")).toUpperCase() === "MLCX")
          lb = Float64Array.from(numList(bld.get("LeafPositionBoundaries")));
      const sad = Number(b.get("SourceAxisDistance", 1000.0));
      const pp = ppBy.has(parseInt(b.get("ReferencedPatientSetupNumber", 1), 10)) ?
        ppBy.get(parseInt(b.get("ReferencedPatientSetupNumber", 1), 10)) : "HFS";
      const cps = [];
      let prev = [NaN, NaN, NaN, NaN, null, null];
      let gantry = 0.0, coll = 0.0, couch = 0.0, iso = null, ssd = null;
      const final = Number(b.get("FinalCumulativeMetersetWeight", 1.0) || 1.0) || 1.0;
      cpsq.forEach((cp, i) => {
        if (cp.has("GantryAngle")) gantry = Number(cp.get("GantryAngle"));
        if (cp.has("BeamLimitingDeviceAngle")) coll = Number(cp.get("BeamLimitingDeviceAngle"));
        if (cp.has("PatientSupportAngle")) couch = Number(cp.get("PatientSupportAngle"));
        if (cp.has("IsocenterPosition")) iso = Float64Array.from(numList(cp.get("IsocenterPosition")));
        if (cp.has("BeamLimitingDevicePositionSequence")) prev = jawsFromSeq(cp.seq("BeamLimitingDevicePositionSequence"), prev);
        ssd = cp.has("SourceToSurfaceDistance") ? Number(cp.get("SourceToSurfaceDistance")) : ssd;
        const [x1, x2, y1, y2, a, bb] = prev;
        const cmw = Number(cp.get("CumulativeMetersetWeight", 0.0) || 0.0) / final;
        cps.push(new M.ControlPoint(i, cmw, gantry, coll, couch, iso, x1, x2, y1, y2, a ? Float64Array.from(a) : null,
                                    bb ? Float64Array.from(bb) : null, ssd));
      });
      for (const cp of cps) {
        if (cp.x1 !== cp.x1) { cp.x1 = -200.0; cp.x2 = 200.0; }
        if (cp.y1 !== cp.y1) { cp.y1 = -200.0; cp.y2 = 200.0; }
      }
      const wedges = b.seq("WedgeSequence").map(w => ({ type: strOr(w, "WedgeType", ""), angle: Number(w.get("WedgeAngle", 0)),
                                                       id: strOr(w, "WedgeID", "") }));
      const appl = b.seq("ApplicatorSequence");
      const applicator = appl.length ? (strOr(appl[0], "ApplicatorID", "") || "aplicador") : "";
      const beam = new M.Beam({
        number: num, name: strOr(b, "BeamName", String(num)), machine: strOr(b, "TreatmentMachineName", ""),
        energy: energy || "", fluence_mode: fmode, sad, mu, beam_type: btype,
        radiation_type: strOr(b, "RadiationType", "PHOTON").toUpperCase(),
        delivery_type: strOr(b, "BeamType", "STATIC").toUpperCase(), patient_position: pp, leaf_boundaries: lb, cps,
        wedges, blocks: parseInt(b.get("NumberOfBlocks", 0) || 0, 10) || 0, applicator });
      if (beam.wedges.length) beam.warnings.push("El haz tiene cuñas: no están modeladas");
      if (beam.blocks) beam.warnings.push("El haz tiene bloques: no están modelados");
      if (beam.applicator) beam.warnings.push("El haz tiene aplicador/cono: no está modelado");
      beams.push(beam);
    }
    const pos = beams.length ? beams[0].patient_position : "HFS";
    return new M.Plan({ label: strOr(ds, "RTPlanLabel", ""), sop_uid: strOr(ds, "SOPInstanceUID", ""), n_fractions: nfx,
                        beams, prescription_gy: rx, patient_position: pos,
                        frame_of_reference_uid: strOr(ds, "FrameOfReferenceUID", ""),
                        patient_id: strOr(ds, "PatientID", ""), patient_name: strOr(ds, "PatientName", "") });
  };

  // ------------------------------------------------------------------ índice de una carpeta
  // Orden de rutas como sorted(Path.rglob) en Windows (por componentes, sin distinguir mayúsculas)
  M.comparePaths = function (a, b) {
    const pa = a.split(/[\\/]/), pb = b.split(/[\\/]/);
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      const x = pa[i].toLowerCase(), y = pb[i].toLowerCase();
      if (x < y) return -1; if (x > y) return 1;
    }
    return pa.length - pb.length;
  };
  // files: [{path, read: async (start, end) -> Uint8Array}] ; progress(f)
  M.indexFolder = async function (files, progress) {
    const idx = { plans: [], structs: new Map(), cts: new Map(), doses: [], n_files: 0, unreadable: 0 };
    const list = files.slice().sort((a, b) => M.comparePaths(a.path, b.path));
    for (let n = 0; n < list.length; n++) {
      const f = list[n];
      if (progress && n % 50 === 0) progress(n / Math.max(list.length, 1));
      let ds;
      try {
        let head = await f.read(0, 262144);
        ds = await M.dcmread(head, { stopBeforePixels: true, force: true, allowTruncated: true });
        const mod0 = ds.get("Modality");
        if (ds.truncated && !ds.stoppedAtPixels && (f.size || 0) > head.byteLength) {
          head = await f.read();
          ds = await M.dcmread(head, { stopBeforePixels: true, force: true });
        } else if (mod0 && mod0 !== "CT" && (f.size || 0) > head.byteLength) {
          head = await f.read();
          ds = await M.dcmread(head, { stopBeforePixels: true, force: true });
        }
      } catch (e) { idx.unreadable += 1; continue; }
      const mod = ds.get("Modality");
      if (mod === undefined || mod === null) continue;
      idx.n_files += 1;
      if (mod === "CT") {
        const uid = strOr(ds, "SeriesInstanceUID", "");
        if (!idx.cts.has(uid)) idx.cts.set(uid, { files: [], station: strOr(ds, "StationName", ""),
          manufacturer: strOr(ds, "Manufacturer", ""), model: strOr(ds, "ManufacturerModelName", ""),
          description: strOr(ds, "SeriesDescription", ""), for_uid: strOr(ds, "FrameOfReferenceUID", "") });
        idx.cts.get(uid).files.push(f);
      } else if (mod === "RTSTRUCT") {
        let refSeries = null;
        try {
          refSeries = String(ds.seq("ReferencedFrameOfReferenceSequence")[0].seq("RTReferencedStudySequence")[0]
            .seq("RTReferencedSeriesSequence")[0].get("SeriesInstanceUID"));
        } catch (e) { refSeries = null; }
        idx.structs.set(strOr(ds, "SOPInstanceUID", ""), { path: f, label: strOr(ds, "StructureSetLabel", ""),
          series_uid: refSeries, n_rois: ds.seq("StructureSetROISequence").length });
      } else if (mod === "RTPLAN") {
        let structUid = "";
        try { structUid = String(ds.seq("ReferencedStructureSetSequence")[0].get("ReferencedSOPInstanceUID")); }
        catch (e) { structUid = ""; }
        let nfx = 1;
        const mu = new Map();
        try {
          const fg = ds.seq("FractionGroupSequence")[0];
          nfx = parseInt(fg.get("NumberOfFractionsPlanned", 1) || 1, 10) || 1;
          for (const r of fg.seq("ReferencedBeamSequence"))
            mu.set(parseInt(r.get("ReferencedBeamNumber"), 10), Number(r.get("BeamMeterset", 0) || 0));
        } catch (e) { /* sin fracciones */ }
        const beams = [];
        for (const b of ds.seq("BeamSequence")) {
          if (strOr(b, "TreatmentDeliveryType", "TREATMENT").toUpperCase() !== "TREATMENT") continue;
          const cps = b.seq("ControlPointSequence");
          let e = "";
          if (cps.length && cps[0].has("NominalBeamEnergy")) e = `${M.fmtG(Number(cps[0].get("NominalBeamEnergy")))}X`;
          beams.push([strOr(b, "BeamName", ""), strOr(b, "TreatmentMachineName", ""), e,
                      mu.get(parseInt(b.get("BeamNumber"), 10)) || 0.0]);
        }
        idx.plans.push({ path: f, uid: strOr(ds, "SOPInstanceUID", ""), label: strOr(ds, "RTPlanLabel", ""),
          name: strOr(ds, "RTPlanName", ""), date: strOr(ds, "RTPlanDate", "") || "",
          patient_id: strOr(ds, "PatientID", ""), patient_name: strOr(ds, "PatientName", ""),
          n_beams: beams.length, n_fractions: nfx, struct_uid: structUid, beams });
      } else if (mod === "RTDOSE") {
        let ref = "";
        try { ref = String(ds.seq("ReferencedRTPlanSequence")[0].get("ReferencedSOPInstanceUID")); } catch (e) { ref = ""; }
        idx.doses.push({ path: f, plan_uid: ref, summation: strOr(ds, "DoseSummationType", "").toUpperCase(),
                         description: strOr(ds, "SeriesDescription", "") });
      }
    }
    if (progress) progress(1.0);
    return idx;
  };
  M.describePlanEntry = function (e) {
    const d = e.date.length >= 8 ? ` · ${e.date.slice(0, 4)}-${e.date.slice(4, 6)}-${e.date.slice(6, 8)}` : "";
    return `${e.label} · ${e.n_beams} haces · ${e.patient_id}${d}`;
  };
  M.resolvePlan = function (idx, plan) {
    const problems = [];
    let st = idx.structs.get(plan.struct_uid) || null;
    if (!st) {
      if (idx.structs.size === 1) {
        st = idx.structs.values().next().value;
        if (plan.struct_uid) problems.push("El RTSTRUCT de la carpeta no es el que referencia el plan");
      } else if (!idx.structs.size) problems.push("No hay RTSTRUCT en la carpeta");
      else problems.push("Hay varios RTSTRUCT y ninguno coincide con el que referencia el plan");
    }
    let ctFiles = [];
    if (st && idx.cts.has(st.series_uid)) ctFiles = idx.cts.get(st.series_uid).files;
    else if (idx.cts.size === 1) ctFiles = idx.cts.values().next().value.files;
    else if (!idx.cts.size) problems.push("No hay CT en la carpeta");
    else problems.push("Hay varias series de CT y no se puede saber cuál usa el plan");
    const doses = idx.doses.filter(d => d.plan_uid === plan.uid);
    if (!doses.length) problems.push("No hay RTDOSE del TPS para este plan");
    const planD = doses.filter(d => d.summation === "PLAN" || d.summation === "FRACTION");
    let chosen = planD.length ? [planD[0].path] : doses.filter(d => d.summation === "BEAM").map(d => d.path);
    if (doses.length && !chosen.length) chosen = [doses[0].path];
    return [ctFiles, st ? st.path : null, chosen, problems];
  };

  // ------------------------------------------------------------------ escritura
  M.generateUID = function () {
    // "2.25." + entero de un UUID v4 (como pydicom.uid.generate_uid)
    const bytes = new Uint8Array(16);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let big = 0n;
    for (const b of bytes) big = (big << 8n) | BigInt(b);
    return "2.25." + big.toString();
  };
  // Escritor DICOM (VR explícito little endian). elems: [[keyword | tag, vr, value]]
  function encText(s) { return new TextEncoder().encode(s); }
  function padEven(bytes, padByte) {
    if (bytes.length % 2 === 0) return bytes;
    const out = new Uint8Array(bytes.length + 1);
    out.set(bytes); out[bytes.length] = padByte;
    return out;
  }
  function fmtDS(v) {
    // DS: como str(float) de Python (lo que escribe pydicom), con un máximo de 16 caracteres
    if (typeof v === "string" && v.trim().length <= 16) return v.trim();
    let s = M.pyFloat(+v);
    if (s.length > 16) { s = (+v).toPrecision(10).replace(/\.?0+(e|$)/, "$1"); if (s.length > 16) s = (+v).toExponential(8); }
    return s;
  }
  function encodeValue(vr, value) {
    if (vr === "SQ") return null;
    if (value instanceof Uint8Array) return padEven(value, 0);
    if (["US", "SS", "UL", "SL", "FL", "FD", "AT"].includes(vr)) {
      const vals = Array.isArray(value) ? value : [value];
      const size = { US: 2, SS: 2, UL: 4, SL: 4, FL: 4, FD: 8, AT: 4 }[vr];
      const b = new Uint8Array(vals.length * size);
      const dv = new DataView(b.buffer);
      vals.forEach((v, i) => {
        const o = i * size;
        if (vr === "US") dv.setUint16(o, v, true); else if (vr === "SS") dv.setInt16(o, v, true);
        else if (vr === "UL") dv.setUint32(o, v, true); else if (vr === "SL") dv.setInt32(o, v, true);
        else if (vr === "FL") dv.setFloat32(o, v, true); else if (vr === "FD") dv.setFloat64(o, v, true);
        else { dv.setUint16(o, v >>> 16, true); dv.setUint16(o + 2, v & 0xffff, true); }
      });
      return b;
    }
    let s;
    const vals = Array.isArray(value) ? value : [value];
    if (vr === "DS") s = vals.map(fmtDS).join("\\");
    else if (vr === "IS") s = vals.map(v => String(Math.trunc(v))).join("\\");
    else s = vals.map(v => (v === null || v === undefined) ? "" : String(v)).join("\\");
    return padEven(encText(s), vr === "UI" ? 0 : 0x20);
  }
  function writeElements(elems, chunks) {
    const sorted = elems.slice().sort((a, b) => tagOf(a[0]) - tagOf(b[0]));
    for (const [k, vr, value] of sorted) {
      const tag = tagOf(k);
      const g = tag >>> 16, e = tag & 0xffff;
      if (vr === "SQ") {
        const hdr = new Uint8Array(12);
        const dv = new DataView(hdr.buffer);
        dv.setUint16(0, g, true); dv.setUint16(2, e, true); hdr[4] = 83; hdr[5] = 81;
        dv.setUint32(8, 0xFFFFFFFF, true);
        chunks.push(hdr);
        for (const item of value) {
          const ih = new Uint8Array(8);
          const idv = new DataView(ih.buffer);
          idv.setUint16(0, 0xFFFE, true); idv.setUint16(2, 0xE000, true); idv.setUint32(4, 0xFFFFFFFF, true);
          chunks.push(ih);
          writeElements(item, chunks);
          const id = new Uint8Array(8);
          const ddv = new DataView(id.buffer);
          ddv.setUint16(0, 0xFFFE, true); ddv.setUint16(2, 0xE00D, true);
          chunks.push(id);
        }
        const sd = new Uint8Array(8);
        const sdv = new DataView(sd.buffer);
        sdv.setUint16(0, 0xFFFE, true); sdv.setUint16(2, 0xE0DD, true);
        chunks.push(sd);
        continue;
      }
      const val = encodeValue(vr, value);
      const long = EXPLICIT_LONG.has(vr);
      const hdr = new Uint8Array(long ? 12 : 8);
      const dv = new DataView(hdr.buffer);
      dv.setUint16(0, g, true); dv.setUint16(2, e, true);
      hdr[4] = vr.charCodeAt(0); hdr[5] = vr.charCodeAt(1);
      if (long) dv.setUint32(8, val.length, true); else dv.setUint16(6, val.length, true);
      chunks.push(hdr, val);
    }
  }
  function tagOf(k) { return typeof k === "number" ? k : DICT[k][0]; }
  // Construye un fichero DICOM Part 10 a partir de la lista de elementos del dataset
  M.writeDicom = function (sopClass, sopUid, elems) {
    const chunks = [];
    const metaElems = [
      ["FileMetaInformationVersion", "OB", new Uint8Array([0, 1])],
      ["MediaStorageSOPClassUID", "UI", sopClass], ["MediaStorageSOPInstanceUID", "UI", sopUid],
      ["TransferSyntaxUID", "UI", "1.2.840.10008.1.2.1"], ["ImplementationClassUID", "UI", "2.25.264837210594017293751420493201846539077"],
      ["ImplementationVersionName", "SH", "CALCINDEP_WEB"],
    ];
    const metaChunks = [];
    writeElements(metaElems, metaChunks);
    const metaLen = metaChunks.reduce((s, c) => s + c.length, 0);
    const pre = new Uint8Array(132);
    pre[128] = 0x44; pre[129] = 0x49; pre[130] = 0x43; pre[131] = 0x4D;
    const gl = new Uint8Array(12);
    const gdv = new DataView(gl.buffer);
    gdv.setUint16(0, 2, true); gdv.setUint16(2, 0, true); gl[4] = 85; gl[5] = 76; gdv.setUint16(6, 4, true);
    gdv.setUint32(8, metaLen, true);
    chunks.push(pre, gl, ...metaChunks);
    writeElements(elems, chunks);
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  };
  const RTDOSE_SOP = "1.2.840.10008.5.1.4.1.1.481.2", RTPLAN_SOP = "1.2.840.10008.5.1.4.1.1.481.5";
  function nowStrings() {
    const d = new Date();
    const p = (n, w) => String(n).padStart(w || 2, "0");
    return [`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`, `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`];
  }
  M.nowStrings = nowStrings;
  // RTDOSE con la dosis (Gy) en una rejilla; template: Dataset del RTDOSE del TPS
  M.writeRTDose = function (dose, grid, template, planUid, summation, description) {
    description = description || "Calculo independiente CCC";
    summation = summation || "PLAN";
    const sop = M.generateUID();
    const [dt, tm] = nowStrings();
    const elems = [["SOPClassUID", "UI", RTDOSE_SOP], ["SOPInstanceUID", "UI", sop], ["InstanceCreationDate", "DA", dt],
                   ["InstanceCreationTime", "TM", tm], ["SpecificCharacterSet", "CS", "ISO_IR 192"]];
    if (template) {
      for (const k of ["PatientName", "PatientID", "PatientBirthDate", "PatientSex", "StudyInstanceUID", "StudyID",
                       "StudyDate", "StudyTime", "ReferringPhysicianName", "AccessionNumber", "FrameOfReferenceUID",
                       "PositionReferenceIndicator"]) {
        const e = template.raw(k);
        if (e) {
          const v = template.get(k);
          elems.push([k, DICT[k][1], v === null || v === undefined ? "" : v]);
        }
      }
      if (!planUid && template.has("ReferencedRTPlanSequence")) {
        try { planUid = String(template.seq("ReferencedRTPlanSequence")[0].get("ReferencedSOPInstanceUID")); } catch (e) { /* */ }
      }
    }
    elems.push(["Modality", "CS", "RTDOSE"], ["SeriesInstanceUID", "UI", M.generateUID()], ["SeriesNumber", "IS", 99],
               ["SeriesDescription", "LO", description], ["DoseUnits", "CS", "GY"], ["DoseType", "CS", "PHYSICAL"],
               ["DoseSummationType", "CS", summation]);
    if (planUid) elems.push(["ReferencedRTPlanSequence", "SQ", [[["ReferencedSOPClassUID", "UI", RTPLAN_SOP],
                                                                 ["ReferencedSOPInstanceUID", "UI", planUid]]]]);
    const [x, y, z] = grid.axes();
    elems.push(["ImagePositionPatient", "DS", [x[0], y[0], z[0]]], ["ImageOrientationPatient", "DS", ["1", "0", "0", "0", "1", "0"]],
               ["PixelSpacing", "DS", [grid.spacing[1], grid.spacing[0]]], ["SliceThickness", "DS", grid.spacing[2]],
               ["GridFrameOffsetVector", "DS", Array.from(z, v => v - z[0])],
               ["FrameIncrementPointer", "AT", 0x3004000C], ["NumberOfFrames", "IS", grid.nz],
               ["Rows", "US", grid.ny], ["Columns", "US", grid.nx], ["SamplesPerPixel", "US", 1],
               ["PhotometricInterpretation", "CS", "MONOCHROME2"], ["BitsAllocated", "US", 32], ["BitsStored", "US", 32],
               ["HighBit", "US", 31], ["PixelRepresentation", "US", 0]);
    let mx = 0;
    for (let p = 0; p < dose.length; p++) { const v = dose[p] > 0 ? dose[p] : 0; if (v > mx) mx = v; }
    const scale = mx > 0 ? mx / (4294967296 - 2) : 1e-9;
    const scaleS = scale.toExponential(10);   // f"{scale:.10e}"
    const scaleV = Number(scaleS);
    elems.push(["DoseGridScaling", "DS", scaleV]);
    const px = new Uint8Array(dose.length * 4);
    const dv = new DataView(px.buffer);
    for (let p = 0; p < dose.length; p++) {
      const v = dose[p] > 0 ? dose[p] : 0;
      dv.setUint32(4 * p, Math.min(4294967295, M.rint(v / scaleV)), true);
    }
    elems.push(["PixelData", "OW", px]);
    return M.writeDicom(RTDOSE_SOP, sop, elems);
  };
});
