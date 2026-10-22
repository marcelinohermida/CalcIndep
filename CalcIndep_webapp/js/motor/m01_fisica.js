/* CalcIndep web · física básica, curva HU–densidad, MLC y modelo de haz
 * (physics.py, hu_ed.py, mlc.py, beam_model.py). */
CI_MOTOR_MODULOS.push(function CIMod_fisica(M) {
  "use strict";

  // ---------------------------------------------------------------- physics.py
  const MU_WATER = [
    [1.00000E-02, 5.329E+00], [1.50000E-02, 1.673E+00], [2.00000E-02, 8.096E-01], [3.00000E-02, 3.756E-01],
    [4.00000E-02, 2.683E-01], [5.00000E-02, 2.269E-01], [6.00000E-02, 2.059E-01], [8.00000E-02, 1.837E-01],
    [1.00000E-01, 1.707E-01], [1.50000E-01, 1.505E-01], [2.00000E-01, 1.370E-01], [3.00000E-01, 1.186E-01],
    [4.00000E-01, 1.061E-01], [5.00000E-01, 9.687E-02], [6.00000E-01, 8.956E-02], [8.00000E-01, 7.865E-02],
    [1.00000E+00, 7.072E-02], [1.25000E+00, 6.323E-02], [1.50000E+00, 5.754E-02], [2.00000E+00, 4.942E-02],
    [3.00000E+00, 3.969E-02], [4.00000E+00, 3.403E-02], [5.00000E+00, 3.031E-02], [6.00000E+00, 2.770E-02],
    [8.00000E+00, 2.429E-02], [1.00000E+01, 2.219E-02], [1.50000E+01, 1.941E-02], [2.00000E+01, 1.813E-02]];
  const LE = Float64Array.from(MU_WATER, r => Math.log(r[0]));
  const LM = Float64Array.from(MU_WATER, r => Math.log(r[1]));
  M.muRhoWater = function (e) {
    if (typeof e === "number") return Math.exp(M.interp1(Math.log(e), LE, LM));
    return Float64Array.from(e, v => Math.exp(M.interp1(Math.log(v), LE, LM)));
  };

  // ---------------------------------------------------------------- lectura de números (float() de Python)
  const FLOAT_RE = /^[+-]?((\d(_?\d)*)?\.?\d(_?\d)*([eE][+-]?\d(_?\d)*)?|(\d(_?\d)*)\.([eE][+-]?\d(_?\d)*)?|inf(inity)?|nan)$/i;
  M.pyParseFloat = function (s) {
    if (typeof s === "number") return s;
    const t = String(s).trim();
    if (!FLOAT_RE.test(t)) return null;
    const u = t.replace(/_/g, "").toLowerCase();
    if (/inf/.test(u)) return u[0] === "-" ? -Infinity : Infinity;
    if (/nan/.test(u)) return NaN;
    const v = Number(u);
    return isNaN(v) ? null : v;
  };
  // csv.Sniffer().sniff(línea, delimiters) simplificado: delimitador preferido presente en la línea
  M.sniffDelimiter = function (line, delims) {
    const preferred = [",", "\t", ";", " ", ":"];
    const present = delims.filter(d => line.indexOf(d) >= 0);
    if (!present.length) throw new Error("Could not determine delimiter");
    for (const p of preferred) if (present.indexOf(p) >= 0) return p;
    return present[0];
  };
  // csv.reader básico (comillas dobles)
  M.csvRows = function (text, delim) {
    const rows = [];
    for (const line of text.split(/\r\n|\n|\r/)) {
      if (line === "") { rows.push([]); continue; }
      const out = [];
      let cur = "", q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
          if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
          else cur += c;
        } else if (c === '"' && cur === "") q = true;
        else if (c === delim) { out.push(cur); cur = ""; }
        else cur += c;
      }
      out.push(cur);
      rows.push(out);
    }
    return rows;
  };
  M.stripBOM = function (t) { return t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t; };

  // ---------------------------------------------------------------- hu_ed.py
  class HUEDCurve {
    constructor(hu, red, name) {
      const o = M.argsort(hu);
      this.hu = Float64Array.from(o, i => +hu[i]);
      this.red = Float64Array.from(o, i => +red[i]);
      if (this.hu.length < 2) throw new Error("La curva HU-RED necesita al menos dos puntos");
      for (let i = 1; i < this.hu.length; i++)
        if (this.hu[i] - this.hu[i - 1] <= 0) throw new Error("Valores de HU repetidos en la curva");
      for (let i = 1; i < this.red.length; i++)
        if (this.red[i] - this.red[i - 1] < 0) throw new Error("La curva HU-RED debe ser monótona creciente");
      this.name = name || "";
    }
    static fromCSV(text, name) {
      text = M.stripBOM(text);
      const lines = text.split(/\r\n|\n|\r/);
      const delim = M.sniffDelimiter(text ? lines[0] : ",", [",", ";", "\t"]);
      const hu = [], red = [];
      for (const row of M.csvRows(text, delim)) {
        if (row.length < 2) continue;
        const h = M.pyParseFloat(row[0]), r = M.pyParseFloat(row[1]);
        if (h === null || r === null) continue;
        hu.push(h); red.push(r);
      }
      return new HUEDCurve(hu, red, name);
    }
    value(h) {
      const n = this.hu.length;
      let out;
      if (h < this.hu[0]) {
        const s = (this.red[1] - this.red[0]) / (this.hu[1] - this.hu[0]);
        out = this.red[0] + s * (h - this.hu[0]);
      } else if (h > this.hu[n - 1]) {
        const s = (this.red[n - 1] - this.red[n - 2]) / (this.hu[n - 1] - this.hu[n - 2]);
        out = this.red[n - 1] + s * (h - this.hu[n - 1]);
      } else out = M.interp1(h, this.hu, this.red);
      return out < 0 ? 0.0 : out;
    }
    // Aplica la curva a un array (devuelve Float64Array)
    apply(arr) {
      const out = new Float64Array(arr.length);
      for (let i = 0; i < arr.length; i++) out[i] = this.value(arr[i]);
      return out;
    }
    table() { return Array.from(this.hu, (h, i) => [h, this.red[i]]); }
    toCSV() {
      return "HU,RED\n" + this.table().map(([h, r]) => `${M.fmtG(h)},${M.fmtF(r, 4)}`).join("\n") + "\n";
    }
  }
  M.HUEDCurve = HUEDCurve;

  // ---------------------------------------------------------------- mlc.py
  function boundaries(start, widths) {
    const b = [start];
    for (const [n, w] of widths) for (let i = 0; i < n; i++) b.push(b[b.length - 1] + w);
    return Float64Array.from(b);
  }
  M.millennium120Boundaries = () => boundaries(-200.0, [[10, 10.0], [40, 5.0], [10, 10.0]]);
  M.hd120Boundaries = () => boundaries(-110.0, [[14, 5.0], [32, 2.5], [14, 5.0]]);
  M.MLC_TYPES = {
    Millennium120: ["Millennium 120", M.millennium120Boundaries],
    HD120: ["HD120", M.hd120Boundaries],
  };
  M.mlcDisplayName = key => (M.MLC_TYPES[key] ? M.MLC_TYPES[key][0] : key);
  M.identifyMLC = function (lb, atol) {
    atol = atol === undefined ? 0.05 : atol;
    for (const key of Object.keys(M.MLC_TYPES)) {
      const ref = M.MLC_TYPES[key][1]();
      if (lb.length === ref.length) {
        let ok = true;
        for (let i = 0; i < lb.length; i++)
          if (!(Math.abs(lb[i] - ref[i]) <= atol + 1e-5 * Math.abs(ref[i]))) { ok = false; break; }
        if (ok) return key;
      }
    }
    const w = M.diff(lb);
    throw new Error(`MLC no reconocido: ${lb.length - 1} pares de láminas entre ${M.fmtG(lb[0])} y ` +
      `${M.fmtG(lb[lb.length - 1])} mm (anchos de ${M.fmtG(M.min(w))} a ${M.fmtG(M.max(w))} mm). MLC admitidos: ` +
      Object.values(M.MLC_TYPES).map(v => v[0]).join(", "));
  };
  class MLCParams {
    constructor(t, dlg, tg) {
      this.transmission = t === undefined ? 0.013 : t;
      this.dlg_mm = dlg === undefined ? 1.3 : dlg;
      this.tg_width_mm = tg === undefined ? 0.0 : tg;
    }
    static fromDict(d) {
      const g = (k, def) => (d && d[k] !== undefined && d[k] !== null) ? Number(d[k]) : def;
      return new MLCParams(g("transmission", 0.013), g("dlg_mm", 1.3), g("tg_width_mm", 0.0));
    }
    toDict() { return { transmission: +this.transmission, dlg_mm: +this.dlg_mm, tg_width_mm: +this.tg_width_mm }; }
    validate(name) {
      const lab = name ? ` (${M.mlcDisplayName(name)})` : "";
      if (!(this.transmission >= 0 && this.transmission <= 0.2))
        throw new Error(`Transmisión del MLC${lab} fuera de rango (0-0.2): ${M.fmtG(this.transmission)}`);
      if (!(this.dlg_mm >= 0 && this.dlg_mm <= 5.0))
        throw new Error(`DLG${lab} fuera de rango (0-5 mm): ${M.fmtG(this.dlg_mm)}`);
      if (!(this.tg_width_mm >= 0 && this.tg_width_mm <= 2.0))
        throw new Error(`Ancho lengüeta-ranura${lab} fuera de rango (0-2 mm): ${M.fmtG(this.tg_width_mm)}`);
    }
  }
  M.MLCParams = MLCParams;
  // Franja lengüeta-ranura por fila del mapa de fluencia
  M.tgRows = function (yg, res, lb, rows, width) {
    const n = yg.length;
    const nbr = new Int32Array(n).fill(-1);
    const frac = new Float64Array(n);
    if (!(width > 0) || !rows) return [nbr, frac];
    const nleaf = lb.length - 1;
    const h = 0.5 * width;
    for (let j = 0; j < n; j++) {
      const r = rows[j];
      if (r < 0) continue;
      const p0 = yg[j] - 0.5 * res, p1 = yg[j] + 0.5 * res;
      let bestOv = 0.0, bestNb = -1;
      for (const [nb, yb] of [[r - 1, lb[r]], [r + 1, lb[r + 1]]]) {
        if (nb < 0 || nb >= nleaf) continue;
        const ov = Math.min(p1, yb + h) - Math.max(p0, yb - h);
        if (ov > bestOv) { bestOv = ov; bestNb = nb; }
      }
      if (bestNb >= 0) { nbr[j] = bestNb; frac[j] = Math.min(bestOv / res, 1.0); }
    }
    return [nbr, frac];
  };

  // ---------------------------------------------------------------- beam_model.py
  const CAL_FIELDS = ["dose_per_mu_cgy", "ssd_mm", "depth_mm", "field_mm", "cgy_per_unit", "grid_mm"];
  class Calibration {
    constructor(d) {
      d = d || {};
      this.dose_per_mu_cgy = 1.0; this.ssd_mm = 1000.0; this.depth_mm = 15.0; this.field_mm = 100.0;
      this.cgy_per_unit = 0.0; this.grid_mm = 2.5;
      for (const k of Object.keys(d)) {
        if (CAL_FIELDS.indexOf(k) < 0) throw new Error(`Calibration() got an unexpected keyword argument '${k}'`);
        this[k] = d[k];
      }
    }
    toDict() { const o = {}; for (const k of CAL_FIELDS) o[k] = this[k]; return o; }
  }
  M.Calibration = Calibration;
  const MODEL_DEFAULTS = () => ({
    name: "Genérico 6X", machine: "", energy: "6X", fluence_mode: "STANDARD", commissioned: false,
    notes: "", commissioning_report: "", sad_mm: 1000.0,
    spectrum_energies_mev: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0],
    spectrum_weights: [0.0820, 0.1239, 0.1061, 0.0831, 0.0588, 0.0391, 0.0213, 0.0243, 0.0050, 0.0088, 0.0030, 0.0050],
    kernel_weight_depth_cm: 10.0, kernel_components: 2,
    oa_radius_mm: [0.0, 50.0, 100.0, 150.0, 200.0, 250.0, 300.0],
    oa_factor: [1.0, 1.01, 1.03, 1.045, 1.05, 1.05, 1.05],
    softening_per_cm: 0.0025, softening_rmax_cm: 20.0, softening_power: 1.0,
    primary_sigma_mm: 0.8, primary_weight: 1.0,
    primary_collimator_radius_mm: 0.0, primary_collimator_sigma_mm: 8.0,
    extrafocal_weight: 0.06, extrafocal_sigma_mm: 20.0, extrafocal_sigma_y_mm: 0.0,
    econt_weight: 0.0, econt_k_per_cm: 0.6, econt_sigma_mm: 15.0,
    mlc: { Millennium120: new MLCParams().toDict() },
    jaw_transmission: 0.001, monitor_backscatter_k: 0.0, kernel_tilt: true,
  });
  M.MODEL_FIELDS = Object.keys(MODEL_DEFAULTS());
  class BeamModel {
    constructor(d) {
      Object.assign(this, MODEL_DEFAULTS());
      if (d) for (const k of Object.keys(d)) if (k !== "calibration") this[k] = d[k];
      this.calibration = (d && d.calibration instanceof Calibration) ? d.calibration : new Calibration(d && d.calibration);
    }
    get ef_sigmas() {
      const sy = this.extrafocal_sigma_y_mm > 0 ? this.extrafocal_sigma_y_mm : this.extrafocal_sigma_mm;
      return [+this.extrafocal_sigma_mm, +sy];
    }
    mlcParams(name) {
      if (!(name in this.mlc)) {
        const have = Object.keys(this.mlc).map(M.mlcDisplayName).join(", ") || "ninguno";
        throw new Error(`El modelo de haz '${this.name}' no tiene parámetros para el MLC ` +
          `${M.mlcDisplayName(name)} (tiene: ${have}). Añádalos en la pestaña «Modelos de haz».`);
      }
      const p = MLCParams.fromDict(this.mlc[name]);
      p.validate(name);
      return p;
    }
    mlcForBeam(beam) {
      if (!beam.leaf_boundaries) return [null, null];
      const name = M.identifyMLC(beam.leaf_boundaries);
      return [name, this.mlcParams(name)];
    }
    oa(r) { return M.interp1(r, this.oa_radius_mm, this.oa_factor); }
    get energies() { return Float64Array.from(this.spectrum_energies_mev, Number); }
    get weights() {
      const w = Float64Array.from(this.spectrum_weights, Number);
      const s = M.npsum(w);
      return w.map(v => v / s);
    }
    toDict() {
      const o = {};
      for (const k of M.MODEL_FIELDS) {
        let v = this[k];
        if (k === "mlc") { const m = {}; for (const kk of Object.keys(v)) m[kk] = Object.assign({}, v[kk]); v = m; }
        else if (Array.isArray(v) || ArrayBuffer.isView(v)) v = Array.from(v);
        o[k] = v;
      }
      o.calibration = this.calibration.toDict();
      return o;
    }
    toJSON() { return M.pyJSON(this.toDict(), new Set(["kernel_components"])); }
    clone() { return BeamModel.fromDict(JSON.parse(JSON.stringify(this.toDict()))); }
    static fromDict(d0) {
      const d = Object.assign({}, d0);
      const cal = new Calibration(d.calibration || {});
      delete d.calibration;
      if (!("kernel_tilt" in d)) d.kernel_tilt = false;
      const tOld = d.mlc_transmission, dOld = d.mlc_dlg_mm;
      delete d.mlc_transmission; delete d.mlc_dlg_mm;
      if (!("mlc" in d)) {
        const p = new MLCParams();
        if (tOld !== undefined && tOld !== null) p.transmission = Number(tOld);
        if (dOld !== undefined && dOld !== null) p.dlg_mm = Number(dOld);
        d.mlc = { Millennium120: p.toDict() };
      }
      const mlc = {};
      for (const k of Object.keys(d.mlc)) mlc[k] = MLCParams.fromDict(d.mlc[k]).toDict();
      d.mlc = mlc;
      const known = {};
      for (const k of Object.keys(d)) if (M.MODEL_FIELDS.indexOf(k) >= 0) known[k] = d[k];
      known.calibration = cal;
      return new BeamModel(known);
    }
    static fromJSON(text) { return BeamModel.fromDict(JSON.parse(M.stripBOM(text))); }
  }
  M.BeamModel = BeamModel;
  class BeamModelLibrary {
    constructor(models) { this.models = Array.from(models); }
    find(machine, energy, fluenceMode) {
      energy = (energy || "").toUpperCase();
      const fm = (fluenceMode || "STANDARD").toUpperCase();
      const cand = this.models.filter(m => m.energy.toUpperCase() === energy && m.fluence_mode.toUpperCase() === fm);
      const exact = cand.filter(m => m.machine && machine && m.machine.toUpperCase() === machine.toUpperCase());
      if (exact.length) return exact[0];
      const generic = cand.filter(m => !m.machine);
      if (generic.length) return generic[0];
      if (cand.length) return cand[0];
      const e = new Error(`'No hay modelo de haz para máquina=${machine}, energía=${energy}, modo=${fm}'`);
      e.isKeyError = true;
      throw e;
    }
  }
  M.BeamModelLibrary = BeamModelLibrary;
});
