/* CalcIndep web · comisionado del modelo de haz (commissioning/measured.py y commissioning/fit.py). */
CI_MOTOR_MODULOS.push(function CIMod_comisionado(M) {
  "use strict";
  const NUM_RE = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g;
  const NUM_RE_SIMPLE = /[-+]?\d*\.?\d+/g;

  // ------------------------------------------------------------------ measured.py
  class Curve {
    constructor(kind, fx, fy, ssd, pos, value, depth, axis, source, meta) {
      this.kind = kind; this.field_x_mm = +fx; this.field_y_mm = +fy; this.ssd_mm = +ssd;
      this.pos_mm = Float64Array.from(pos); this.value = Float64Array.from(value);
      this.depth_mm = (depth === undefined || depth === null) ? null : +depth;
      this.axis = axis || "Z"; this.source = source || ""; this.meta = meta || {};
    }
    get label() {
      const f = `${M.fmtG(this.field_x_mm / 10)}x${M.fmtG(this.field_y_mm / 10)}`;
      if (this.kind === "pdd") return `PDD ${f} DFS ${M.fmtG(this.ssd_mm / 10)}`;
      return `Perfil ${this.axis} ${f} prof. ${M.fmtG(this.depth_mm / 10)} cm DFS ${M.fmtG(this.ssd_mm / 10)}`;
    }
    normalized() {
      const v = this.value;
      if (this.kind === "pdd") { const mx = M.max(v); return [this.pos_mm, v.map(x => x / mx * 100.0)]; }
      const c = M.interp1(0.0, this.pos_mm, v);
      return [this.pos_mm, v.map(x => x / c * 100.0)];
    }
    get is_half() {
      if (this.kind !== "profile") return false;
      const x = this.pos_mm;
      return M.min(x) > -0.1 * Math.max(Math.abs(M.max(x)), 1.0);
    }
    normalizedSym() {
      const [x, v] = this.normalized();
      if (this.kind !== "profile") return [x, v];
      if (this.is_half) {
        const xp = [], vp = [];
        for (let i = 0; i < x.length; i++) if (x[i] >= 0) { xp.push(x[i]); vp.push(v[i]); }
        return [Float64Array.from([...xp.slice().reverse().map(a => -a), ...xp]),
                Float64Array.from([...vp.slice().reverse(), ...vp])];
      }
      if (M.max(x) < 0.1 * Math.abs(M.min(x))) {
        const xn = [], vn = [];
        for (let i = 0; i < x.length; i++) if (x[i] <= 0) { xn.push(x[i]); vn.push(v[i]); }
        return [Float64Array.from([...xn, ...xn.slice().reverse().map(a => -a)]),
                Float64Array.from([...vn, ...vn.slice().reverse()])];
      }
      return [x, v];
    }
    toObj() {
      return { kind: this.kind, field_x_mm: this.field_x_mm, field_y_mm: this.field_y_mm, ssd_mm: this.ssd_mm,
               pos_mm: Array.from(this.pos_mm), value: Array.from(this.value), depth_mm: this.depth_mm, axis: this.axis,
               source: this.source, label: this.label, is_half: this.is_half };
    }
  }
  M.Curve = Curve;

  function parseFlsz(s) {
    const m = (s || "").match(NUM_RE_SIMPLE) || [];
    if (m.length >= 2) return [parseFloat(m[0]), parseFloat(m[1])];
    if (m.length === 1) return [parseFloat(m[0]), parseFloat(m[0])];
    return [NaN, NaN];
  }
  const PDD_TYPES = new Set(["OPD", "PDD"]), PROFILE_TYPES = new Set(["OPP", "PRO", "PRF"]);
  const DIAG_TYPES = new Set(["DPR", "DPP", "OPD_DIAG"]);
  function argsortQ(a) { return M.argsort(a); }
  M.readW2CAD = function (text, name, skipped) {
    const curves = [];
    const blocks = text.split("$STOM").slice(1);
    for (const blk of blocks) {
      const body = blk.split("$ENOM")[0];
      const hdr = {};
      const pts = [];
      for (let line of body.split(/\r\n|\n|\r/)) {
        line = line.trim();
        if (line.startsWith("%")) {
          const rest = line.slice(1).trim();
          if (!rest) continue;
          const sp = rest.search(/\s/);
          const key = (sp < 0 ? rest : rest.slice(0, sp)).toUpperCase();
          hdr[key] = sp < 0 ? "" : rest.slice(sp).trim();
        } else if (line.startsWith("<")) {
          const nums = line.match(NUM_RE) || [];
          if (nums.length >= 4) pts.push(nums.slice(0, 4).map(parseFloat));
        }
      }
      if (!pts.length) continue;
      const typ = (hdr.TYPE || "").toUpperCase();
      const [fx, fy] = parseFlsz(hdr.FLSZ || "");
      const ssd = parseFloat(((hdr.SSD === undefined ? "1000" : hdr.SSD).match(NUM_RE_SIMPLE) || ["1000"])[0]);
      let axis = (hdr.AXIS || "").toUpperCase().slice(0, 1);
      const wedge = ("WDGL" in hdr && ["", "0", "00"].indexOf((hdr.WDGL || "").trim()) < 0) || typ.startsWith("W");
      if (wedge) { if (skipped) skipped.push([name, typ, "cuña"]); continue; }
      const dp = hdr.DPTH;
      const col = c => Float64Array.from(pts, r => r[c]);
      if (PDD_TYPES.has(typ) || (typ === "" && axis === "Z")) {
        const depth = col(2), val = col(3);
        const o = argsortQ(depth);
        curves.push(new Curve("pdd", fx, fy, ssd, o.map(i => depth[i]), o.map(i => val[i]), null, "Z", name, hdr));
        continue;
      }
      if (PROFILE_TYPES.has(typ) || DIAG_TYPES.has(typ) || (typ === "" && (axis === "X" || axis === "Y"))) {
        const depth = dp ? parseFloat((dp.match(NUM_RE_SIMPLE) || ["0"])[0]) : M.median(col(2));
        const a0 = col(0), a1 = col(1), val = col(3);
        let pos;
        if (DIAG_TYPES.has(typ) || axis === "D") {
          const z0 = a => M.allclose(a, new Float64Array(a.length));
          if (z0(a1)) pos = a0;
          else if (z0(a0)) pos = a1;
          else pos = Float64Array.from(a0, (v, i) => M.sign(v + a1[i]) * M.hypot(v, a1[i]));
          axis = "D";
        } else if (axis === "Y") pos = a1;
        else { axis = "X"; pos = a0; }
        const o = argsortQ(pos);
        curves.push(new Curve("profile", fx, fy, ssd, o.map(i => pos[i]), o.map(i => val[i]), depth, axis, name, hdr));
        continue;
      }
      if (skipped) skipped.push([name, typ || "?", "tipo no reconocido"]);
    }
    return curves;
  };
  M.readTwoColumn = function (text, scalePos) {
    scalePos = scalePos === undefined ? 1.0 : scalePos;
    text = M.stripBOM(text);
    const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim());
    const delim = M.sniffDelimiter(lines[0], [",", ";", "\t", " "]);
    const x = [], y = [];
    for (let row of M.csvRows(lines.join("\n"), delim)) {
      row = row.filter(r => r.trim() !== "");
      if (row.length < 2) continue;
      const a = M.pyParseFloat(row[0]), b = M.pyParseFloat(row[1]);
      if (a === null || b === null) continue;
      x.push(a * scalePos); y.push(b);
    }
    const o = argsortQ(x);
    return [Float64Array.from(o, i => x[i]), Float64Array.from(o, i => y[i])];
  };
  function floats(line) {
    const out = [];
    for (const t of line.trim().split(/[,;\t ]+/)) {
      if (!t) continue;
      const v = M.pyParseFloat(t.replace(",", "."));
      if (v === null) return null;
      out.push(v);
    }
    return out;
  }
  M.readOutputFactors = function (text) {
    text = M.stripBOM(text);
    const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim());
    let meta = { format: "csv" };
    const numeric = lines.map(floats).filter(v => v && v.length);
    if (numeric.length >= 3) {
      const head = numeric[0];
      const body = numeric.slice(1).filter(v => v.length === head.length + 1);
      if (head.length >= 3 && body.length >= 2) {
        const cols = head;
        const unit = Math.max(M.max(cols), Math.max(...body.map(r => r[0]))) <= 60 ? 10.0 : 1.0;
        const rows = [];
        for (const r of body) {
          const fy = r[0] * unit;
          cols.forEach((fx, i) => rows.push([fx * unit, fy, r[i + 1]]));
        }
        meta = { format: "tabla_2d", units_cm: unit === 10.0 };
        const hdr = lines[0].split(",");
        const f0 = floats(lines[0]);
        if ((!f0 || !f0.length) && hdr.length >= 4) {
          const ssdCm = M.pyParseFloat(hdr[2]), sadCm = M.pyParseFloat(hdr[3]);
          if (ssdCm !== null && sadCm !== null) {
            meta.ssd_mm = ssdCm * 10.0; meta.depth_mm = (sadCm - ssdCm) * 10.0; meta.header = lines[0].trim();
            if (hdr.length >= 6) {
              const a = M.pyParseFloat(hdr[4]), b = M.pyParseFloat(hdr[5]);
              if (a !== null && b !== null) meta.ref_field_mm = [a * 10.0, b * 10.0];
            }
          }
        }
        return [rows, meta];
      }
    }
    const rows = [];
    for (const v of numeric) {
      if (v.length === 2) rows.push([v[0], v[0], v[1]]);
      else if (v.length === 3) rows.push([v[0], v[1], v[2]]);
    }
    return [rows, meta];
  };
  M.selectOutputFactors = function (rows, maxRect) {
    maxRect = maxRect || 8;
    const sq = rows.filter(r => Math.abs(r[0] - r[1]) < 1e-6);
    const rect = rows.filter(r => Math.abs(r[0] - r[1]) >= 1e-6);
    if (!rect.length) return sq;
    const pick = [];
    for (const longX of [true, false]) {
      const cand = rect.filter(r => (r[0] > r[1]) === longX)
        .map((r, i) => [r, i]).sort((a, b) => ((-Math.max(a[0][0], a[0][1]) / Math.min(a[0][0], a[0][1])) -
          (-Math.max(b[0][0], b[0][1]) / Math.min(b[0][0], b[0][1]))) || (a[1] - b[1])).map(x => x[0]);
      const seen = new Set();
      for (const r of cand) {
        const short = Math.min(r[0], r[1]);
        if (seen.has(short)) continue;
        seen.add(short);
        pick.push(r);
        if (pick.filter(p => (p[0] > p[1]) === longX).length >= Math.floor(maxRect / 2)) break;
      }
    }
    return sq.concat(pick);
  };
  function curveKey(c) {
    const v = c.value;
    return JSON.stringify([c.kind, M.pyRound(c.field_x_mm, 1), M.pyRound(c.field_y_mm, 1), M.pyRound(c.ssd_mm, 1),
                           c.depth_mm === null ? null : M.pyRound(c.depth_mm, 1), c.axis, v.length,
                           M.pyRound(v[0], 3), M.pyRound(v[v.length - 1], 3)]);
  }
  // cfg: sección "measured"; files: {nombre: texto}
  M.loadMeasured = function (cfg, files, info) {
    const getText = f => {
      if (!(f in files)) throw new Error(`No se encuentra el fichero ${f}`);
      return files[f];
    };
    let curves = [];
    const skipped = [], seen = [];
    for (const f of cfg.w2cad || []) {
      if (seen.indexOf(String(f)) >= 0) continue;
      seen.push(String(f));
      curves = curves.concat(M.readW2CAD(getText(f), f, skipped));
    }
    for (const p of cfg.pdd || []) {
      const sc = (p.units || "mm") === "cm" ? 10.0 : 1.0;
      const [x, y] = M.readTwoColumn(getText(p.file), sc);
      const fx = p.field_x_mm !== undefined ? p.field_x_mm : p.field_mm;
      const fy = p.field_y_mm !== undefined ? p.field_y_mm : p.field_mm;
      curves.push(new Curve("pdd", fx, fy, p.ssd_mm === undefined ? 1000.0 : p.ssd_mm, x, y, null, "Z", p.file));
    }
    for (const p of cfg.profiles || []) {
      const sc = (p.units || "mm") === "cm" ? 10.0 : 1.0;
      const [x, y] = M.readTwoColumn(getText(p.file), sc);
      const fx = p.field_x_mm !== undefined ? p.field_x_mm : p.field_mm;
      const fy = p.field_y_mm !== undefined ? p.field_y_mm : p.field_mm;
      curves.push(new Curve("profile", fx, fy, p.ssd_mm === undefined ? 1000.0 : p.ssd_mm, x, y, p.depth_mm,
                            (p.axis || "X").toUpperCase(), p.file));
    }
    const unique = [], keys = new Set();
    let dup = 0;
    for (const c of curves) {
      const k = curveKey(c);
      if (keys.has(k)) { dup++; continue; }
      keys.add(k); unique.push(c);
    }
    let of = null, ofMeta = {};
    if (cfg.output_factors) {
      const o = cfg.output_factors;
      const r = M.readOutputFactors(getText(o.file));
      ofMeta = r[1];
      of = { rows: r[0], ssd_mm: o.ssd_mm === undefined ? 1000.0 : o.ssd_mm, depth_mm: o.depth_mm === undefined ? 100.0 : o.depth_mm,
             ref_field_mm: o.ref_field_mm === undefined ? 100.0 : o.ref_field_mm, meta: ofMeta };
    }
    if (info) {
      info.skipped = skipped; info.duplicates = dup; info.repeated_files = (cfg.w2cad || []).length - seen.length;
      info.of_meta = ofMeta; info.n_of = of ? of.rows.length : 0;
    }
    return [unique, of];
  };

  // ------------------------------------------------------------------ fit.py
  M.gamma1D = function (xRef, dRef, xEv, dEv, dd, dta, threshold) {
    dd = dd === undefined ? 2.0 : dd; dta = dta === undefined ? 2.0 : dta; threshold = threshold === undefined ? 10.0 : threshold;
    const xmin = M.min(xEv), xmax = M.max(xEv);
    const xf = M.arange(xmin, xmax, 0.1);
    const df = M.interp(xf, xEv, dEv);
    const norm = Math.max(M.max(dRef), 1e-9);
    const g = new Float64Array(dRef.length).fill(NaN);
    const den = dd / 100 * norm;
    for (let i = 0; i < dRef.length; i++) {
      const x = xRef[i], d = dRef[i];
      if (d < threshold / 100 * norm || x < xmin || x > xmax) continue;
      let best = Infinity, any = false;
      for (let q = 0; q < xf.length; q++) {
        if (!(Math.abs(xf[q] - x) <= 3 * dta)) continue;
        any = true;
        const a = (xf[q] - x) / dta, b = (df[q] - d) / den;
        const v = a ** 2 + b ** 2;
        if (v < best) best = v;
      }
      g[i] = any ? Math.sqrt(best) : NaN;
    }
    return g;
  };
  function softLabel(s, pw) {
    if (s === 0) return "s = 0 (sin ablandamiento)";
    if (pw === 1) return `lineal, s = ${M.fmtG(s)} cm⁻¹`;
    if (pw === 2) return `cuadrática, s = ${M.fmtG(s)} cm⁻²`;
    return `potencia ${M.fmtG(pw)}, s = ${M.fmtG(s)}`;
  }
  M.CommissioningConfig = function (d) {
    d = Object.assign({}, d || {});
    const tOld = d.mlc_transmission, dOld = d.mlc_dlg_mm;
    delete d.mlc_transmission; delete d.mlc_dlg_mm;
    if (!("mlc" in d) && (tOld !== undefined || dOld !== undefined)) {
      const p = new M.MLCParams();
      if (tOld !== undefined) p.transmission = +tOld;
      if (dOld !== undefined) p.dlg_mm = +dOld;
      d.mlc = { Millennium120: p.toDict() };
    }
    const def = {
      machine: "", energy: "6X", fluence_mode: "STANDARD", name: "", measured: {},
      mlc: { Millennium120: new M.MLCParams().toDict() }, jaw_transmission: 0.001, calibration: {},
      start_model: null, kernel_tilt: true, grid_mm: 2.5,
      steps: { spectrum: true, econt: true, horns: true, softening: true, source: true, output_factors: true },
      reference_field_mm: 100.0, output_model: "modelo_comisionado.json", report: "informe_comisionado.html",
      source_sigma_grid_mm: [0.3, 0.6, 0.9, 1.2, 1.5, 2.0, 2.5], softening_grid: [0.0, 0.003, 0.006],
      softening_fields_mm: [100.0, 150.0, 250.0], softening_max: 0.02, softening_powers: [1.0, 2.0],
      softening_grid_quad: [0.0, 0.00015, 0.0003, 0.00045], softening_max_quad: 0.0015,
      extrafocal_sigma_grid_mm: [6.0, 8.0, 10.0, 12.0, 15.0, 18.0, 22.0, 26.0, 30.0, 35.0, 40.0],
      extrafocal_ratio_grid: [1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0], spectrum_smoothing: 1e-3,
      spectrum_smoothing_grid: [1e-3, 3e-3, 1e-2, 3e-2, 0.1, 0.3], spectrum_rms_tolerance: 0.15,
      spectrum_fields_mm: [30.0, 200.0], spectrum_refinements: 2, softening_horn_iterations: 2,
    };
    for (const k of Object.keys(d)) if (k in def) def[k] = d[k];
    return def;
  };
  M.COMM_CONFIG_KEYS = Object.keys(M.CommissioningConfig());

  class Commissioner {
    constructor(cfg, files, hooks) {
      this.cfg = cfg;
      this.hooks = hooks || {};
      this.progress = this.hooks.progress || (() => {});
      this.fraction = this.hooks.fraction || (() => {});
      this.loadInfo = {};
      const [curves, of] = M.loadMeasured(cfg.measured, files, this.loadInfo);
      this.curves = curves; this.of = of;
      if (!this.curves.length) throw new Error("No se han encontrado curvas de campo abierto");
      if (this.of) this.ofFitRows = M.selectOutputFactors(this.of.rows);
      const m = cfg.start_model && files[cfg.start_model] ? M.BeamModel.fromJSON(files[cfg.start_model])
        : M.BeamModel.fromJSON(M.DATOS_MODELO_GENERICO);
      m.machine = cfg.machine; m.energy = cfg.energy; m.fluence_mode = cfg.fluence_mode;
      m.name = cfg.name || `${cfg.machine} ${cfg.energy}${cfg.fluence_mode === "STANDARD" ? "" : " " + cfg.fluence_mode}`;
      const mlc = {};
      for (const k of Object.keys(cfg.mlc || {})) mlc[k] = M.MLCParams.fromDict(cfg.mlc[k]).toDict();
      m.mlc = mlc;
      m.jaw_transmission = cfg.jaw_transmission;
      m.calibration = new M.Calibration(cfg.calibration && Object.keys(cfg.calibration).length ? cfg.calibration : {});
      m.commissioned = false;
      m.kernel_tilt = !!cfg.kernel_tilt;
      this.model = m;
      this.engine = new M.DoseEngine(m, M.CalcOptions(), M.EDK, this.hooks.backend);
      this.engine.cancel = this.hooks.cancel || null;
      this.log = [];
      this.timing = {};
    }
    note(msg) { this.log.push(msg); this.progress(msg); }
    geometryFor(fx, fy, ssd, curves, spacing) {
      const sp = spacing || this.cfg.grid_mm;
      let dmax = 150.0;
      for (const c of curves) {
        if (c.kind === "pdd") dmax = Math.max(dmax, M.max(c.pos_mm) + 30.0);
        else dmax = Math.max(dmax, c.depth_mm + 80.0);
      }
      const deep = Math.min(dmax, 350.0);
      const mag = (ssd + Math.min(deep, 300.0)) / this.model.sad_mm;
      let lateral = Math.max(fx, fy) * mag + 2 * 55.0;
      for (const c of curves) if (c.kind === "profile") {
        let am = 0;
        for (const v of c.pos_mm) am = Math.max(am, Math.abs(v));
        lateral = Math.max(lateral, 2 * am / (c.axis === "D" ? Math.sqrt(2) : 1.0) + 10);
      }
      lateral = Math.max(lateral, 150.0);
      return M.waterGrid(sp, lateral, deep);
    }
    async calc(model, fx, fy, ssd, curves, grid, mlc) {
      const g = grid || this.geometryFor(fx, fy, ssd, curves || []);
      const b = M.squareBeam(fx, fy, { ssd_mm: ssd, mu: 100.0, energy: model.energy, fluence_mode: model.fluence_mode, mlc });
      const rho = new Float64Array(g.size).fill(1.0);
      const [D] = await this.engine.computeBeamRaw(b, model, rho, g, null);
      // cada maniquí se usa una sola vez: se liberan sus datos en los subhilos
      if (this.engine.backend && this.engine.backend.release) this.engine.backend.release();
      return [D, g];
    }
    pddRef() {
      const pdds = this.curves.filter(c => c.kind === "pdd");
      if (!pdds.length) throw new Error("Hace falta al menos una PDD");
      const f = this.cfg.reference_field_mm;
      let best = null, bk = null;
      for (const c of pdds) {
        const k = [Math.abs(Math.sqrt(c.field_x_mm * c.field_y_mm) - f), Math.abs(c.ssd_mm - 1000)];
        if (!bk || k[0] < bk[0] || (k[0] === bk[0] && k[1] < bk[1])) { best = c; bk = k; }
      }
      return best;
    }
    spectrumCurves() {
      const ref = this.pddRef();
      const pdds = this.curves.filter(c => c.kind === "pdd" && Math.abs(c.ssd_mm - ref.ssd_mm) < 1);
      const out = [ref];
      for (const f of this.cfg.spectrum_fields_mm) {
        if (!pdds.length) break;
        let c = null, bd = Infinity;
        for (const q of pdds) { const d = Math.abs(Math.sqrt(q.field_x_mm * q.field_y_mm) - f); if (d < bd) { bd = d; c = q; } }
        if (out.every(o => o !== c) && Math.abs(Math.sqrt(c.field_x_mm * c.field_y_mm) - f) <= 0.25 * f) out.push(c);
      }
      return out;
    }
    async fitSpectrum(withEcont) {
      withEcont = withEcont === undefined ? true : withEcont;
      const curves = this.spectrumCurves();
      this.note("Espectro: PDD usadas " + curves.map(c => c.label).join(", "));
      const m0 = this.model;
      const E = m0.energies;
      const n = E.length;
      const useE = withEcont && (this.cfg.steps.econt === undefined ? true : this.cfg.steps.econt);
      const kvals = useE ? [0.25, 0.35, 0.5, 0.7, 1.0, 1.4, 2.0] : [null];
      const data = [];
      for (const c of curves) {
        const g = this.geometryFor(c.field_x_mm, c.field_y_mm, c.ssd_mm, [c]);
        const mE = m0.clone();
        mE.econt_weight = 0.0;
        const cols = [];
        let y = null;
        for (let i = 0; i < n; i++) {
          const mi = mE.clone();
          const w = new Array(n).fill(0.0);
          w[i] = 1.0 / E[i];
          mi.spectrum_weights = w;
          const [D] = await this.calc(mi, c.field_x_mm, c.field_y_mm, c.ssd_mm, null, g);
          const ca = M.centralAxis(D, g);
          y = ca[0];
          cols.push(ca[1]);
        }
        this.progress(`  ${c.label}: dosis por energía calculadas`);
        const ec = {};
        for (const k of kvals) {
          if (k === null) continue;
          const mk = m0.clone();
          mk.econt_weight = 1.0;
          mk.econt_k_per_cm = k;
          const b = M.squareBeam(c.field_x_mm, c.field_y_mm, { ssd_mm: c.ssd_mm, mu: 100.0 });
          const sb = M.subbeams(b, mk)[0];
          const r = (await this.engine.backend.termaMany([{
            rho: new Float64Array(g.size).fill(1.0), grid: g, geom: sb.geom, fluence: sb.fluence, fshape: sb.fshape,
            axes: sb.axes, efluence: sb.efluence, energies: mk.energies, weights: mk.weights, mu: M.muRhoWater(mk.energies),
            softening: 0.0, softening_rmax_cm: 20.0, softening_power: 1.0, ke: k }]))[0];
          ec[k] = M.centralAxis(r.De, g)[1];
        }
        const [zm, pm] = c.normalized();
        const P = M.interp(y, zm, pm, NaN, NaN);
        const zmax = zm[M.argmax(pm)];
        const zlo = useE ? 3.0 : zmax + 10.0;
        const sel = [];
        const zmMax = M.max(zm);
        for (let j = 0; j < y.length; j++) if (isFinite(P[j]) && y[j] >= zlo && y[j] <= Math.min(zmMax, 300.0)) sel.push(j);
        const Asel = sel.map(j => Float64Array.from(cols, col => col[j]));
        const ecs = {};
        for (const k of Object.keys(ec)) ecs[k] = Float64Array.from(sel, j => ec[k][j]);
        data.push({ A: Asel, P: Float64Array.from(sel, j => P[j]), ec: ecs, label: c.label, curve: c, grid: g, sel });
      }
      // regularización: segunda diferencia del número de fotones
      const L = [];
      for (let i = 0; i < n - 2; i++) {
        const r = new Float64Array(n);
        r[i] = 1 / E[i]; r[i + 1] = -2 / E[i + 1]; r[i + 2] = 1 / E[i + 2];
        // L @ diag(1/E): L[i, j] * (1/E[j])
        r[i] = 1 * (1.0 / E[i]); r[i + 1] = -2 * (1.0 / E[i + 1]); r[i + 2] = 1 * (1.0 / E[i + 2]);
        L.push(r);
      }
      const nf = data.length;
      const meanE = M.npsum(E) / n;
      let lamSel = this.cfg.spectrum_smoothing;
      const solve = (k, deltas, lam) => {
        lam = lam === undefined ? lamSel : lam;
        const ne = k !== null ? 1 : 0;
        const ncol = n + ne + (nf - 1);
        const rows = [], rhs = [];
        data.forEach((d, fi) => {
          d.A.forEach((arow, r) => {
            const row = new Float64Array(ncol);
            row.set(arow, 0);
            if (ne) row[n] = d.ec[k][r];
            if (fi === 0) rhs.push(d.P[r] - deltas[fi][r]);
            else { row[n + ne + fi - 1] = -d.P[r]; rhs.push(-deltas[fi][r]); }
            rows.push(row);
          });
        });
        // scale = media de las normas de las columnas de energía
        const norms = new Float64Array(n);
        for (let j = 0; j < n; j++) { let s = 0; for (const row of rows) s += row[j] * row[j]; norms[j] = Math.sqrt(s); }
        const scale = M.npsum(norms) / n;
        const Lrows = L.map(lr => { const row = new Float64Array(ncol); for (let j = 0; j < n; j++) row[j] = lr[j] * lam * scale * meanE; return row; });
        const x = M.nnls(rows.concat(Lrows), Float64Array.from(rhs.concat(new Array(L.length).fill(0))), 10000);
        const errs = data.map((d, fi) => {
          const sf = fi === 0 ? 1.0 : x[n + ne + fi - 1];
          if (!(sf > 0)) return Infinity;
          let s = 0;
          d.A.forEach((arow, r) => {
            let pred = 0;
            for (let j = 0; j < n; j++) pred += arow[j] * x[j];
            if (ne) pred += x[n] * d.ec[k][r];
            pred += deltas[fi][r];
            s += (pred / sf - d.P[r]) ** 2;
          });
          return Math.sqrt(s / d.A.length);
        });
        return [x, errs];
      };
      const apply = (x, k) => {
        const c = x.slice(0, n);
        const S = M.npsum(c);
        const w = Float64Array.from(c, (v, i) => v / E[i]);
        const ws = M.npsum(w);
        this.model.spectrum_weights = Array.from(w, v => v / ws);
        if (k !== null) { this.model.econt_k_per_cm = +k; this.model.econt_weight = x[n] / S; }
        return S;
      };
      const zero = data.map(d => new Float64Array(d.P.length));
      const results = [];
      for (const lam of this.cfg.spectrum_smoothing_grid) {
        let best = null;
        for (const k of kvals) {
          const [x, errs] = solve(k, zero, lam);
          const tot = Math.sqrt(M.npsum(Float64Array.from(errs, e => e * e)) / errs.length);
          if (best === null || tot < best[2]) best = [x, k, tot, errs, lam];
        }
        results.push(best);
      }
      const tmin = Math.min(...results.map(r => r[2]));
      const ok = results.filter(r => r[2] <= tmin + this.cfg.spectrum_rms_tolerance);
      let [x, k, , errs, lam] = ok.reduce((a, b) => (b[4] > a[4] ? b : a));
      lamSel = lam;
      this.progress("  suavizado del espectro: " + results.map(r => `λ=${M.fmtG(r[4])} RMS ${M.fmtF(r[2], 2)}%`).join(", ") +
                    ` → λ=${M.fmtG(lam)}`);
      let S = apply(x, k);
      let deltas = zero;
      for (let it = 0; it < this.cfg.spectrum_refinements; it++) {
        const nw = [];
        for (let fi = 0; fi < data.length; fi++) {
          const d = data[fi], c = d.curve;
          const [D] = await this.calc(this.model, c.field_x_mm, c.field_y_mm, c.ssd_mm, null, d.grid);
          const ca = M.centralAxis(D, d.grid)[1];
          const pe = Float64Array.from(d.sel, j => ca[j]);
          const nd = new Float64Array(d.P.length);
          d.A.forEach((arow, r) => {
            let mono = 0;
            for (let j = 0; j < n; j++) mono += arow[j] * x[j];
            if (k !== null) mono += x[n] * d.ec[k][r];
            mono = mono / S;
            nd[r] = deltas[fi][r] + S * (pe[r] - (mono + deltas[fi][r] / S));
          });
          nw.push(nd);
        }
        deltas = nw;
        [x, errs] = solve(k, deltas);
        S = apply(x, k);
        this.progress(`  refinamiento ${it + 1}: RMS ` + errs.map(e => `${M.fmtF(e, 2)} %`).join(", "));
      }
      const w = this.model.weights;
      const emean = M.npsum(Float64Array.from(w, (v, i) => v * E[i]));
      this.note(`Espectro ajustado: energía media ${M.fmtF(emean, 2)} MeV; RMS por PDD: ` +
                data.map((d, i) => `${d.label} ${M.fmtF(errs[i], 2)} %`).join(", ") +
                `; contaminación electrónica w = ${M.fmtF(this.model.econt_weight, 4)}, k = ${M.fmtG(this.model.econt_k_per_cm)} cm⁻¹`);
    }
    largestFieldProfiles() {
      const prof = this.curves.filter(c => c.kind === "profile" && Math.abs(c.ssd_mm - 1000) < 1);
      if (!prof.length) return [null, []];
      const fmax = Math.max(...prof.map(c => Math.max(c.field_x_mm, c.field_y_mm)));
      return [fmax, prof.filter(c => Math.max(c.field_x_mm, c.field_y_mm) === fmax)];
    }
    async fitHorns(iterations, quiet) {
      iterations = iterations === undefined ? 3 : iterations;
      const [fmax, curves] = this.largestFieldProfiles();
      if (!curves.length) { this.note("Cuernos: no hay perfiles a DFS 100; se omite"); return; }
      const depths = Array.from(new Set(curves.map(c => c.depth_mm))).sort((a, b) => a - b);
      const cand = depths.filter(d => d >= 10.0);
      const d0 = Math.min(...(cand.length ? cand : depths));
      const sel = curves.filter(c => c.depth_mm === d0);
      if (!quiet) this.note(`Perfil radial: campo ${M.fmtG(fmax / 10)} cm, profundidad ${M.fmtG(d0 / 10)} cm, ` +
                            `${sel.length} perfiles (${sel.map(c => c.axis).join(", ")})`);
      const m = this.model;
      let rmax = 0;
      for (const c of sel) for (const v of c.pos_mm) rmax = Math.max(rmax, Math.abs(v));
      rmax = rmax * m.sad_mm / (1000.0 + d0);
      const nodes = M.arange(0.0, Math.max(rmax, 50.0) + 20.0, 20.0);
      const f0 = Array.from(nodes, r => m.oa(r));
      m.oa_radius_mm = Array.from(nodes);
      m.oa_factor = f0;
      let g = null;
      for (let it = 0; it < iterations; it++) {
        const r0 = await this.calc(m, fmax, fmax, 1000.0, curves, g);
        const D = r0[0]; g = r0[1];
        const ratios = [];
        for (const c of sel) {
          const [xm, vm] = c.normalizedSym();
          const pr = M.profile(D, g, d0, c.axis);
          const xc = pr[0];
          const c0 = M.interp1(0.0, xc, pr[1]);
          const vc = pr[1].map(v => v / c0 * 100.0);
          let half = 0.5 * ((c.axis === "X" || c.axis === "D") ? c.field_x_mm : c.field_y_mm) * (1000.0 + d0) / m.sad_mm;
          if (c.axis === "D") half *= Math.sqrt(2);
          const rr = [];
          const rpc = m.primary_collimator_radius_mm;
          for (const r of nodes) {
            const p = r * (1000.0 + d0) / m.sad_mm;
            let lim = half - 15.0;
            if (rpc > 0) lim = Math.min(lim, (rpc - 2.5 * m.primary_collimator_sigma_mm) * (1000.0 + d0) / m.sad_mm);
            if (p > lim) { rr.push(NaN); continue; }
            const a = [-1, 1].map(s => M.interp1(s * p, xm, vm) / Math.max(M.interp1(s * p, xc, vc), 1e-9));
            rr.push((a[0] + a[1]) / 2);
          }
          ratios.push(rr);
        }
        const nn = nodes.length;
        const R = new Float64Array(nn);
        for (let q = 0; q < nn; q++) {
          let s = 0, cnt = 0;
          for (const rr of ratios) if (isFinite(rr[q])) { s += rr[q]; cnt++; }
          R[q] = cnt > 0 ? s / Math.max(cnt, 1) : NaN;
        }
        const okIdx = [];
        for (let q = 0; q < nn; q++) if (isFinite(R[q])) okIdx.push(q);
        if (!okIdx.length) break;
        const last = okIdx[okIdx.length - 1];
        for (let q = 0; q < nn; q++) if (!isFinite(R[q])) R[q] = R[last];
        const R0 = R[0];
        for (let q = 0; q < nn; q++) R[q] = R[q] / R0;
        const f = Float64Array.from(m.oa_factor, (v, q) => v * R[q]);
        const ff0 = f[0];
        m.oa_factor = Array.from(f, v => v / ff0);
        if (!quiet) {
          let mx = 0;
          for (const v of R) if (isFinite(v)) mx = Math.max(mx, Math.abs(v - 1));
          this.progress(`  iteración ${it + 1}: corrección máxima ${M.fmtF(mx * 100, 2)} %`);
        }
      }
      if (!quiet) this.note("Perfil radial ajustado: " + m.oa_radius_mm.map((r, i) => `${M.fmtF(r, 0)} mm: ${M.fmtF(m.oa_factor[i], 3)}`).join(", "));
    }
    async fitPrimaryCollimator() {
      const m = this.model;
      const est = [];
      for (const c of this.curves) {
        if (c.kind !== "profile" || c.axis !== "D") continue;
        let [x, v] = c.normalizedSym();
        const xs = [], vs = [];
        for (let i = 0; i < x.length; i++) if (x[i] >= 0) { xs.push(x[i]); vs.push(v[i]); }
        x = xs; v = vs;
        const mag = (c.ssd_mm + c.depth_mm) / m.sad_mm;
        const corner = 0.5 * M.hypot(c.field_x_mm, c.field_y_mm) * mag;
        const below = [];
        for (let i = 0; i < v.length; i++) if (v[i] < 50.0) below.push(i);
        if (!below.length || below[0] === 0) continue;
        const i = below[0];
        const x50 = M.interp1(50.0, [v[i], v[i - 1]], [x[i], x[i - 1]]);
        if (x50 > 0.95 * corner) continue;
        const cross = level => {
          const jj = [];
          for (let q = 0; q < v.length; q++) if (v[q] < level) jj.push(q);
          const j = jj.length ? jj[0] : v.length - 1;
          return j > 0 ? M.interp1(level, [v[j], v[j - 1]], [x[j], x[j - 1]]) : NaN;
        };
        const w8020 = cross(20.0) - cross(80.0);
        est.push([c.depth_mm, x50 / mag, w8020 / mag]);
      }
      if (!est.length) { this.note("Colimador primario: no hay perfiles diagonales de campos grandes; no se modela"); return; }
      est.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));
      const radii = est.map(e => e[1]);
      const rpc = M.median(Float64Array.from(radii));
      const sTot = est[0][2] / 1.683;
      const spc = Math.sqrt(Math.max(sTot ** 2 - 3.5 ** 2, 1.0));
      m.primary_collimator_radius_mm = M.pyRound(rpc, 1);
      m.primary_collimator_sigma_mm = M.pyRound(spc, 1);
      this.note(`Colimador primario: radio ${M.fmtF(rpc, 1)} mm en el isocentro (dispersión entre profundidades ` +
                `${M.fmtF(Math.min(...radii), 1)}–${M.fmtF(Math.max(...radii), 1)} mm), σ de penumbra ${M.fmtF(spc, 1)} mm; ` +
                `${est.length} perfiles diagonales`);
    }
    profileError(D, g, curves, core, edge) {
      core = core === undefined ? 0.8 : core;
      const errs = [];
      for (const c of curves) {
        const [xm, vm] = c.normalized();
        const pr = M.profile(D, g, c.depth_mm, c.axis);
        const c0 = M.interp1(0.0, pr[0], pr[1]);
        const vc = pr[1].map(v => v / c0 * 100.0);
        const fs = (c.axis === "X" || c.axis === "D") ? c.field_x_mm : c.field_y_mm;
        let half = 0.5 * fs * (c.ssd_mm + c.depth_mm) / this.model.sad_mm;
        if (c.axis === "D") half *= Math.sqrt(2);
        const idx = [];
        for (let i = 0; i < xm.length; i++) {
          const ok = edge ? Math.abs(Math.abs(xm[i]) - half) <= 12.0 : Math.abs(xm[i]) <= core * half;
          if (ok) idx.push(i);
        }
        if (idx.length < 3) continue;
        let s = 0;
        for (const i of idx) { const d = M.interp1(xm[i], pr[0], vc) - vm[i]; s += d * d; }
        errs.push(Math.sqrt(s / idx.length));
      }
      return errs.length ? M.npsum(Float64Array.from(errs)) / errs.length : NaN;
    }
    async fitSoftening() {
      const [fmax, curves] = this.largestFieldProfiles();
      if (!curves.length) return;
      const deep = curves.filter(c => c.depth_mm >= 150.0);
      if (!deep.length) { this.note("Ablandamiento: no hay perfiles profundos del campo mayor; se mantiene el valor inicial"); return; }
      const prof = this.curves.filter(c => c.kind === "profile" && Math.abs(c.ssd_mm - 1000) < 1 && c.depth_mm >= 150.0 &&
                                          (c.axis === "X" || c.axis === "Y"));
      const sets = [[fmax, fmax, curves, deep]];
      for (const f of this.cfg.softening_fields_mm) {
        const cand = prof.filter(c => Math.abs(c.field_x_mm - c.field_y_mm) < 1);
        if (!cand.length) break;
        const fxs = Array.from(new Set(cand.map(c => c.field_x_mm)));
        let fx = fxs[0];
        for (const v of fxs) if (Math.abs(v - f) < Math.abs(fx - f)) fx = v;
        if (Math.abs(fx - f) > 0.25 * f || sets.some(st => Math.abs(fx - st[0]) < 1)) continue;
        const sel = cand.filter(c => c.field_x_mm === fx);
        sets.push([fx, fx, sel, sel]);
      }
      if (sets.length > 1) this.note("Ablandamiento: perfiles profundos de los campos " +
                                     sets.map(st => `${M.fmtG(st[0] / 10)}x${M.fmtG(st[1] / 10)}`).join(", "));
      const grids = new Map();
      const base = this.model.clone();
      const tried = new Map();   // "pw|s" -> [error, modelo]
      const keyOf = (pw, sv) => (sv === 0.0 ? [1.0, 0.0] : [pw, sv]);
      const evaluate = async (pw, sv) => {
        sv = M.pyRound(+sv, 8);
        const key = keyOf(pw, sv);
        const ks = key.join("|");
        if (tried.has(ks)) return tried.get(ks)[0];
        this.model = base.clone();
        this.model.softening_per_cm = sv;
        this.model.softening_power = key[0];
        await this.fitHorns(this.cfg.softening_horn_iterations, true);
        const errs = [];
        for (const [fx, fy, cv, ev] of sets) {
          const [D, g] = await this.calc(this.model, fx, fy, 1000.0, cv, grids.get(fx));
          grids.set(fx, g);
          errs.push(this.profileError(D, g, ev));
        }
        const fin = errs.filter(e => isFinite(e));
        const e = fin.length ? M.npsum(Float64Array.from(fin)) / fin.length : NaN;
        const detail = sets.map((st, i) => `${M.fmtG(st[0] / 10)}: ${M.fmtF(errs[i], 2)}`).join(", ");
        this.progress(`  ${softLabel(sv, key[0])}: RMS perfiles profundos ${M.fmtF(e, 2)} % (${detail})`);
        tried.set(ks, [e, this.model.clone(), key]);
        return e;
      };
      const search = async (pw, grid, smax) => {
        grid = grid.map(Number).sort((a, b) => a - b);
        for (const sv of grid) await evaluate(pw, sv);
        const mine = () => {
          const ks = [];
          for (const [, v] of tried) if (v[2][0] === pw || (v[2][0] === 1.0 && v[2][1] === 0.0)) ks.push(v[2][1]);
          ks.sort((a, b) => a - b);
          const vals = new Map();
          for (const k of ks) vals.set(k, tried.get(keyOf(pw, k).join("|"))[0]);
          return [ks, vals];
        };
        const step = grid.length > 1 ? grid[grid.length - 1] - grid[grid.length - 2] : grid[grid.length - 1];
        for (;;) {
          const [ks, vals] = mine();
          let kb = ks[0];
          for (const k of ks) if (vals.get(k) < vals.get(kb)) kb = k;
          if (kb !== ks[ks.length - 1] || ks[ks.length - 1] + step > smax + 1e-12) break;
          await evaluate(pw, ks[ks.length - 1] + step);
        }
        const [ks, vals] = mine();
        let ib = 0;
        for (let i = 0; i < ks.length; i++) if (vals.get(ks[i]) < vals.get(ks[ib])) ib = i;
        if (ib > 0 && ib < ks.length - 1) {
          const [x0, x1, x2] = ks.slice(ib - 1, ib + 2);
          const y0 = vals.get(x0), y1 = vals.get(x1), y2 = vals.get(x2);
          const den = (x0 - x1) * (x0 - x2) * (x1 - x2);
          const a = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / den;
          const b = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / den;
          if (a > 0) {
            const xv = -b / (2 * a);
            if (x0 < xv && xv < x2 && Math.abs(xv - x1) > 0.1 * step) await evaluate(pw, Number(M.fmtG(xv, 2)));
          }
        }
      };
      const forms = { 1: [this.cfg.softening_grid, this.cfg.softening_max], 2: [this.cfg.softening_grid_quad, this.cfg.softening_max_quad] };
      for (const pw of this.cfg.softening_powers) if (+pw in forms) await search(+pw, ...forms[+pw]);
      let kbest = null;
      for (const [ks, v] of tried) if (kbest === null || v[0] < tried.get(kbest)[0]) kbest = ks;
      const bestRec = tried.get(kbest);
      this.model = bestRec[1];
      const byForm = new Map();
      for (const [, v] of tried) {
        const [pw, s] = v[2];
        if (s > 0 && (!byForm.has(pw) || v[0] < byForm.get(pw)[1])) byForm.set(pw, [s, v[0]]);
      }
      const cmpTxt = Array.from(byForm.entries()).sort((a, b) => a[0] - b[0])
        .map(([pw, [v, e]]) => `mejor ${pw === 1 ? "lineal" : "cuadrática"}: ${softLabel(v, pw)} (${M.fmtF(e, 2)} %)`).join("; ");
      this.note(`Ablandamiento fuera de eje: ${softLabel(bestRec[2][1], bestRec[2][0])} (RMS perfiles profundos ` +
                `${M.fmtF(bestRec[0], 2)} %); perfil radial reajustado` + (byForm.size > 1 ? `. ${cmpTxt}` : ""));
    }
    async fitSource() {
      const f = this.cfg.reference_field_mm;
      const prof = this.curves.filter(c => c.kind === "profile" && Math.abs(c.ssd_mm - 1000) < 1 && (c.axis === "X" || c.axis === "Y"));
      if (!prof.length) return;
      const fxs = Array.from(new Set(prof.map(c => c.field_x_mm)));
      let fsel = fxs[0];
      for (const v of fxs) if (Math.abs(v - f) < Math.abs(fsel - f)) fsel = v;
      const sel = prof.filter(c => c.field_x_mm === fsel);
      let best = null, g = null;
      for (const s of this.cfg.source_sigma_grid_mm) {
        const m = this.model.clone();
        m.primary_sigma_mm = +s;
        const r = await this.calc(m, fsel, sel[0].field_y_mm, 1000.0, sel, g);
        g = r[1];
        const e = this.profileError(r[0], g, sel, 0.8, true);
        this.progress(`  sigma = ${M.fmtG(+s)} mm: RMS penumbra ${M.fmtF(e, 2)} %`);
        if (best === null || e < best[1]) best = [+s, e];
      }
      this.model.primary_sigma_mm = best[0];
      this.note(`Tamaño de fuente primaria: sigma = ${M.fmtG(best[0])} mm en el isocentro ` +
                `(RMS en penumbra ${M.fmtF(best[1], 2)} %, campo ${M.fmtG(fsel / 10)} cm)`);
    }
    async ofDose(model, fx, fy, ssd, depth, spacing) {
      const sp = spacing || this.cfg.grid_mm;
      const g = M.waterGrid(sp, fx * 1.2 + 100.0, depth + 100.0, fy * 1.2 + 100.0);
      const [D] = await this.calc(model, fx, fy, ssd, null, g);
      return M.pointDose(D, g, depth);
    }
    async fitOutputFactors() {
      if (!this.of) { this.note("Factores de campo: no hay datos; se mantiene la fuente extrafocal inicial"); return; }
      const ssd = this.of.ssd_mm, depth = this.of.depth_mm;
      const fref = this.of.ref_field_mm === undefined ? 100.0 : this.of.ref_field_mm;
      const rows = this.ofFitRows.slice();
      const kk = (a, b) => `${a}|${b}`;
      const allm = new Map(this.of.rows.map(r => [kk(r[0], r[1]), r[2]]));
      const mref = allm.has(kk(fref, fref)) ? allm.get(kk(fref, fref)) : 1.0;
      const meas = new Map();
      for (const r of rows) meas.set(kk(r[0], r[1]), [r[0], r[1], r[2] / mref]);
      const fieldMap = new Map(meas);
      fieldMap.set(kk(fref, fref), [fref, fref]);
      const fields = Array.from(fieldMap.values()).map(v => [v[0], v[1]]).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
      this.note(`Factores de campo: ${this.of.rows.length} campos en la tabla, ${meas.size} usados en el ajuste ` +
                `(DFS ${M.fmtG(ssd / 10)} cm, profundidad ${M.fmtG(depth / 10)} cm)`);
      const mp = this.model.clone();
      mp.extrafocal_weight = 0.0;
      const Dp = new Map();
      for (let i = 0; i < fields.length; i++) {
        const [fx, fy] = fields[i];
        Dp.set(kk(fx, fy), await this.ofDose(mp, fx, fy, ssd, depth));
        this.progress(`  campo ${M.fmtG(fx / 10)}x${M.fmtG(fy / 10)}: dosis sin fuente extrafocal (${i + 1}/${fields.length})`);
      }
      const keys = Array.from(meas.keys());
      const gfac = (fx, fy, sx, sy) => M.erf(fx / (2 * Math.sqrt(2) * sx)) * M.erf(fy / (2 * Math.sqrt(2) * sy));
      const rmsFor = (w, De) => {
        const ref = Dp.get(kk(fref, fref)) + w * De.get(kk(fref, fref));
        const d = keys.map(k => ((Dp.get(k) + w * De.get(k)) / ref - meas.get(k)[2]) / meas.get(k)[2]);
        return Math.sqrt(M.npsum(Float64Array.from(d, v => v * v)) / d.length);
      };
      let best = null;
      for (const sx of this.cfg.extrafocal_sigma_grid_mm) {
        for (const ratio of this.cfg.extrafocal_ratio_grid) {
          const sy = sx * ratio;
          const De = new Map(fields.map(([fx, fy]) => [kk(fx, fy), Dp.get(kk(fx, fy)) * gfac(fx, fy, sx, sy)]));
          const r = M.fminbound(w => rmsFor(w, De), 0.0, 0.5);
          if (best === null || r.fun < best[3]) best = [sx, sy, r.x, r.fun];
        }
      }
      const [sx, sy, w0, e0] = best;
      this.progress(`  aproximación: σx = ${M.fmtG(sx)} mm, σy = ${M.fmtG(sy)} mm, w = ${M.fmtF(w0, 4)}, RMS ${M.fmtF(e0 * 100, 2)} %`);
      const me = this.model.clone();
      me.primary_weight = 0.0;
      me.extrafocal_weight = 1.0;
      me.extrafocal_sigma_mm = +sx;
      me.extrafocal_sigma_y_mm = +sy;
      const De = new Map();
      for (let i = 0; i < fields.length; i++) {
        const [fx, fy] = fields[i];
        De.set(kk(fx, fy), await this.ofDose(me, fx, fy, ssd, depth, 5.0));
        this.progress(`  campo ${M.fmtG(fx / 10)}x${M.fmtG(fy / 10)}: dosis de la fuente extrafocal (${i + 1}/${fields.length})`);
      }
      const r = M.fminbound(w => rmsFor(w, De), 0.0, 0.5);
      this.model.extrafocal_sigma_mm = +sx;
      this.model.extrafocal_sigma_y_mm = +sy;
      this.model.extrafocal_weight = +r.x;
      this.note(`Fuente extrafocal: w = ${M.fmtF(r.x, 4)}, σx = ${M.fmtG(sx)} mm, σy = ${M.fmtG(sy)} mm ` +
                `(RMS factores de campo ${M.fmtF(r.fun * 100, 2)} %)`);
    }
    async validate() {
      const groups = new Map();
      for (const c of this.curves) {
        const k = [c.field_x_mm, c.field_y_mm, c.ssd_mm];
        const ks = k.join("|");
        if (!groups.has(ks)) groups.set(ks, { k, cs: [] });
        groups.get(ks).cs.push(c);
      }
      const results = [];
      const sorted = Array.from(groups.values()).sort((a, b) => (a.k[0] - b.k[0]) || (a.k[1] - b.k[1]) || (a.k[2] - b.k[2]));
      for (const { k: [fx, fy, ssd], cs } of sorted) {
        this.progress(`Validación: campo ${M.fmtG(fx / 10)}x${M.fmtG(fy / 10)} DFS ${M.fmtG(ssd / 10)}`);
        const [D, g] = await this.calc(this.model, fx, fy, ssd, cs);
        for (const c of cs) {
          const [xm, vm] = c.normalized();
          let xc, vc;
          if (c.kind === "pdd") {
            [xc, vc] = M.centralAxis(D, g);
            const mx = M.max(vc);
            vc = vc.map(v => v / mx * 100.0);
          } else {
            [xc, vc] = M.profile(D, g, c.depth_mm, c.axis);
            const c0 = M.interp1(0.0, xc, vc);
            vc = vc.map(v => v / c0 * 100.0);
          }
          const gm = M.gamma1D(xm, vm, xc, vc, 2.0, 2.0);
          const diff = M.interp(xm, xc, vc).map((v, i) => v - vm[i]);
          let core;
          if (c.kind === "pdd") { const zmax = xm[M.argmax(vm)]; core = Array.from(xm, x => x >= zmax); }
          else {
            const fsz = (c.axis === "X" || c.axis === "D") ? c.field_x_mm : c.field_y_mm;
            const half = 0.5 * fsz * (c.ssd_mm + c.depth_mm) / this.model.sad_mm * (c.axis === "D" ? Math.sqrt(2) : 1);
            core = Array.from(xm, x => Math.abs(x) <= 0.8 * half);
          }
          const gf = Array.from(gm).filter(v => isFinite(v));
          let mxd = NaN;
          if (core.some(Boolean)) {
            for (let i = 0; i < core.length; i++) if (core[i]) {
              const a = Math.abs(diff[i]);
              if (a === a && (mxd !== mxd || a > mxd)) mxd = a;
            }
          }
          results.push({
            curve: c, x_calc: Array.from(xc), v_calc: Array.from(vc),
            gamma_pass: gf.length ? gf.filter(v => v <= 1).length / gf.length * 100 : NaN,
            max_abs_diff_core: mxd,
            pdd10_meas: c.kind === "pdd" ? M.interp1(100.0, xm, vm) : null,
            pdd10_calc: c.kind === "pdd" ? M.interp1(100.0, xc, vc) : null,
          });
        }
      }
      const ofRes = [];
      if (this.of) {
        const ssd = this.of.ssd_mm, depth = this.of.depth_mm;
        const fref = this.of.ref_field_mm === undefined ? 100.0 : this.of.ref_field_mm;
        const vals = new Map();
        const vrows = this.ofFitRows;
        for (const [fx, fy] of vrows.concat([[fref, fref, null]])) {
          const k = `${fx}|${fy}`;
          if (vals.has(k)) continue;
          this.progress(`Validación: factor de campo ${M.fmtG(fx / 10)}x${M.fmtG(fy / 10)}`);
          vals.set(k, await this.ofDose(this.model, fx, fy, ssd, depth));
        }
        const allm = new Map(this.of.rows.map(r => [`${r[0]}|${r[1]}`, r[2]]));
        const mref = allm.has(`${fref}|${fref}`) ? allm.get(`${fref}|${fref}`) : 1.0;
        for (const [fx, fy, v] of vrows) {
          const calc = vals.get(`${fx}|${fy}`) / vals.get(`${fref}|${fref}`);
          const meas = v / mref;
          ofRes.push({ fx, fy, meas, calc, diff_pct: (calc - meas) / meas * 100 });
        }
      }
      return [results, ofRes];
    }
    async run() {
      const t0 = Date.now();
      const st = this.cfg.steps;
      const on = k => st[k] === undefined ? true : !!st[k];
      const steps = [["primary_collimator", () => this.fitPrimaryCollimator(), 0.0],
                     ["spectrum", () => this.fitSpectrum(), 0.35], ["output_factors", () => this.fitOutputFactors(), 0.12],
                     ["horns", () => this.fitHorns(), 0.08], ["softening", () => this.fitSoftening(), 0.15],
                     ["source", () => this.fitSource(), 0.10]];
      const finalW = 0.08, endW = 0.12;
      const total = steps.filter(s => on(s[0])).reduce((a, s) => a + s[2], 0) + finalW + endW;
      let acc = 0.0;
      this.fraction(0.0);
      const li = this.loadInfo;
      const npdd = this.curves.filter(c => c.kind === "pdd").length;
      this.note(`Curvas de campo abierto: ${this.curves.length} (${npdd} PDD, ${this.curves.length - npdd} perfiles; ` +
                `${this.curves.filter(c => c.is_half).length} perfiles medidos a un solo lado)`);
      if (li.skipped && li.skipped.length) {
        const cnt = new Map();
        for (const [, t] of li.skipped) cnt.set(t, (cnt.get(t) || 0) + 1);
        this.note("Curvas descartadas (cuñas u otros tipos): " + Array.from(cnt.entries()).map(([k, v]) => `${k} ${v}`).join(", "));
      }
      if (li.repeated_files) this.note(`Ficheros repetidos en la lista: ${li.repeated_files} (se leen una vez)`);
      if (li.duplicates) this.note(`Curvas repetidas descartadas: ${li.duplicates}`);
      const om = li.of_meta || {};
      if (om.format === "tabla_2d") {
        this.note(`Factores de campo: tabla 2D de Varian (${li.n_of || 0} combinaciones X×Y, cabecera «${om.header || ""}»)`);
        if ("ssd_mm" in om && (Math.abs(om.ssd_mm - this.of.ssd_mm) > 1 || Math.abs(om.depth_mm - this.of.depth_mm) > 1)) {
          this.note(`Aviso: la cabecera indica DFS ${M.fmtG(om.ssd_mm / 10)} cm y profundidad ${M.fmtG(om.depth_mm / 10)} cm, ` +
                    "distintas de las de la configuración; se usan las de la cabecera");
          this.of.ssd_mm = om.ssd_mm; this.of.depth_mm = om.depth_mm;
        }
      }
      for (const [key, fn, w] of steps) {
        if (!on(key)) continue;
        const t = Date.now();
        await fn();
        this.timing[key] = (Date.now() - t) / 1000;
        acc += w;
        this.fraction(acc / total);
      }
      if (on("horns") && on("source")) {
        this.note("Reajuste final del perfil radial");
        await this.fitHorns(2);
        if (on("output_factors") && this.of) {
          this.note("Reajuste final de la fuente extrafocal");
          await this.fitOutputFactors();
        }
      }
      acc += finalW;
      this.fraction(acc / total);
      this.note("Calibración de UM");
      await M.calibrate(this.model, this.cfg.grid_mm, this.engine);
      this.note(`cGy por unidad interna: ${M.fmtG(this.model.calibration.cgy_per_unit, 5)}`);
      const [val, ofRes] = await this.validate();
      this.fraction(1.0);
      this.model.commissioned = true;
      const d = new Date();
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      this.model.notes = `Comisionado automático ${iso} con ${this.curves.length} curvas medidas. Revise el informe de comisionado.`;
      this.timing.total = (Date.now() - t0) / 1000;
      return [val, ofRes];
    }
  }
  M.Commissioner = Commissioner;

  // Comisionado completo para el coordinador. msg: {cfg, files}
  M.runCommissioning = async function (msg, hooks) {
    const cfg = M.CommissioningConfig(msg.cfg);
    const comm = new Commissioner(cfg, msg.files, hooks);
    const [val, ofRes] = await comm.run();
    if (hooks.cancel) hooks.cancel();
    return {
      model: comm.model.toJSON(), modelDict: comm.model.toDict(), log: comm.log, timing: comm.timing,
      val: val.map(v => Object.assign({}, v, { curve: v.curve.toObj() })), of: ofRes,
      cfg, options: { tilt_tile_deg: comm.engine.options.tilt_tile_deg, tilt_min_halfangle_deg: comm.engine.options.tilt_min_halfangle_deg,
                      kernel_tilt: comm.engine.options.kernel_tilt },
      n_curves: comm.curves.length,
    };
  };
});
