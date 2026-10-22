/* CalcIndep web · estructuras del plan (ControlPoint, Beam, Plan) y haces en agua (dicom_io.py, water.py). */
CI_MOTOR_MODULOS.push(function CIMod_plan(M) {
  "use strict";

  function allclose(a, b, rtol, atol) {
    rtol = rtol === undefined ? 1e-5 : rtol; atol = atol === undefined ? 1e-8 : atol;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!(Math.abs(a[i] - b[i]) <= atol + rtol * Math.abs(b[i]))) return false;
    return true;
  }
  M.allclose = allclose;
  function unwrap(p) {
    const up = Float64Array.from(p);
    let acc = 0;
    for (let i = 1; i < p.length; i++) {
      const dd = p[i] - p[i - 1];
      let ddmod = M.pymod(dd + Math.PI, 2 * Math.PI) - Math.PI;
      if (ddmod === -Math.PI && dd > 0) ddmod = Math.PI;
      let corr = ddmod - dd;
      if (Math.abs(dd) < Math.PI) corr = 0;
      acc += corr;
      up[i] = p[i] + acc;
    }
    return up;
  }
  M.unwrap = unwrap;

  class ControlPoint {
    constructor(index, cmw, gantry, coll, couch, iso, x1, x2, y1, y2, mlc_a, mlc_b, ssd) {
      this.index = index; this.cmw = cmw; this.gantry = gantry; this.coll = coll; this.couch = couch;
      this.iso = iso ? Float64Array.from(iso) : null;
      this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2;
      this.mlc_a = mlc_a ? Float64Array.from(mlc_a) : null;
      this.mlc_b = mlc_b ? Float64Array.from(mlc_b) : null;
      this.ssd = (ssd === undefined) ? null : ssd;
    }
    toObj() {
      return { index: this.index, cmw: this.cmw, gantry: this.gantry, coll: this.coll, couch: this.couch,
               iso: this.iso ? Array.from(this.iso) : null, x1: this.x1, x2: this.x2, y1: this.y1, y2: this.y2,
               mlc_a: this.mlc_a ? Array.from(this.mlc_a) : null, mlc_b: this.mlc_b ? Array.from(this.mlc_b) : null,
               ssd: this.ssd };
    }
    static from(o) {
      return o instanceof ControlPoint ? o : new ControlPoint(o.index, o.cmw, o.gantry, o.coll, o.couch, o.iso,
        o.x1, o.x2, o.y1, o.y2, o.mlc_a, o.mlc_b, o.ssd);
    }
  }
  M.ControlPoint = ControlPoint;

  class Beam {
    constructor(o) {
      this.number = o.number; this.name = o.name; this.machine = o.machine || ""; this.energy = o.energy || "";
      this.fluence_mode = o.fluence_mode || "STANDARD"; this.sad = o.sad; this.mu = o.mu;
      this.beam_type = o.beam_type; this.radiation_type = o.radiation_type; this.delivery_type = o.delivery_type;
      this.patient_position = o.patient_position || "HFS";
      this.leaf_boundaries = o.leaf_boundaries ? Float64Array.from(o.leaf_boundaries) : null;
      this.cps = (o.cps || []).map(ControlPoint.from);
      this.wedges = o.wedges || []; this.blocks = o.blocks || 0; this.applicator = o.applicator || "";
      this.warnings = (o.warnings || []).slice();
    }
    get is_arc() {
      if (this.cps.length <= 1) return false;
      const g = unwrap(Float64Array.from(this.cps, c => M.deg2rad(c.gantry)));
      return (M.max(g) - M.min(g)) > 1e-3;
    }
    get technique() {
      if (this.is_arc) return "VMAT/arco";
      if (this.mlc_moves) return "IMRT";
      return "Estático";
    }
    get mlc_moves() {
      if (!this.cps[0].mlc_a) return false;
      const a0 = this.cps[0].mlc_a, b0 = this.cps[0].mlc_b;
      return this.cps.some(cp => !(allclose(cp.mlc_a, a0) && allclose(cp.mlc_b, b0)));
    }
    toObj() {
      return { number: this.number, name: this.name, machine: this.machine, energy: this.energy,
               fluence_mode: this.fluence_mode, sad: this.sad, mu: this.mu, beam_type: this.beam_type,
               radiation_type: this.radiation_type, delivery_type: this.delivery_type,
               patient_position: this.patient_position,
               leaf_boundaries: this.leaf_boundaries ? Array.from(this.leaf_boundaries) : null,
               cps: this.cps.map(c => c.toObj()), wedges: this.wedges, blocks: this.blocks,
               applicator: this.applicator, warnings: this.warnings.slice() };
    }
    static from(o) { return o instanceof Beam ? o : new Beam(o); }
  }
  M.Beam = Beam;

  class Plan {
    constructor(o) {
      this.label = o.label; this.sop_uid = o.sop_uid; this.n_fractions = o.n_fractions;
      this.beams = (o.beams || []).map(Beam.from);
      this.prescription_gy = (o.prescription_gy === undefined) ? null : o.prescription_gy;
      this.patient_position = o.patient_position || "HFS";
      this.frame_of_reference_uid = o.frame_of_reference_uid || "";
      this.patient_id = o.patient_id || ""; this.patient_name = o.patient_name || "";
    }
    toObj() {
      return { label: this.label, sop_uid: this.sop_uid, n_fractions: this.n_fractions,
               beams: this.beams.map(b => b.toObj()), prescription_gy: this.prescription_gy,
               patient_position: this.patient_position, frame_of_reference_uid: this.frame_of_reference_uid,
               patient_id: this.patient_id, patient_name: this.patient_name };
    }
    static from(o) { return o instanceof Plan ? o : new Plan(o); }
  }
  M.Plan = Plan;

  // ---------------------------------------------------------------- water.py
  M.waterGrid = function (spacing, lateral, depth, lateralZ) {
    spacing = spacing === undefined ? 2.5 : spacing;
    lateral = lateral === undefined ? 300.0 : lateral;
    depth = depth === undefined ? 300.0 : depth;
    const lz = (lateralZ === undefined || lateralZ === null) ? lateral : lateralZ;
    let nx = Math.trunc(M.rint(lateral / spacing));
    let nz = Math.trunc(M.rint(lz / spacing));
    const ny = Math.trunc(M.rint(depth / spacing));
    nx += M.pymod(nx + 1, 2);
    nz += M.pymod(nz + 1, 2);
    const origin = [-(nx - 1) / 2 * spacing, spacing / 2, -(nz - 1) / 2 * spacing];
    return new M.Grid(origin, [spacing, spacing, spacing], [nz, ny, nx]);
  };
  M.squareBeam = function (fx, fy, opts) {
    opts = opts || {};
    fy = (fy === undefined || fy === null) ? fx : fy;
    const ssd = opts.ssd_mm === undefined ? 1000.0 : opts.ssd_mm;
    const mu = opts.mu === undefined ? 100.0 : opts.mu;
    const sad = opts.sad_mm === undefined ? 1000.0 : opts.sad_mm;
    const coll = opts.coll || 0.0;
    const iso = [0.0, sad - ssd, 0.0];
    let lb = null, a = null, b = null;
    if (opts.mlc) {
      lb = M.millennium120Boundaries();
      const n = lb.length - 1;
      if (opts.mlc === "retracted") { a = new Float64Array(n).fill(-200.0); b = new Float64Array(n).fill(200.0); }
      else { a = new Float64Array(n).fill(-fx / 2); b = new Float64Array(n).fill(fx / 2); }
    }
    const cps = [0.0, 1.0].map((w, i) => new ControlPoint(i, w, 0.0, coll, 0.0, iso, -fx / 2, fx / 2, -fy / 2, fy / 2,
                                                           a, b, ssd));
    return new Beam({ number: opts.number || 1, name: `${M.fmtG(fx / 10)}x${M.fmtG(fy / 10)}`, machine: "",
                      energy: opts.energy || "6X", fluence_mode: opts.fluence_mode || "STANDARD", sad, mu,
                      beam_type: "TREATMENT", radiation_type: "PHOTON", delivery_type: "STATIC",
                      patient_position: "HFS", leaf_boundaries: lb, cps });
  };
  // Curva en profundidad sobre el eje
  M.centralAxis = function (dose, grid) {
    const [x, y, z] = grid.axes();
    const i = M.argminAbs(x, 0), k = M.argminAbs(z, 0);
    const [nz, ny, nx] = grid.shape;
    const out = new Float64Array(ny);
    for (let j = 0; j < ny; j++) out[j] = dose[(k * ny + j) * nx + i];
    return [Float64Array.from(y), out];
  };
  M.profile = function (dose, grid, depth, direction) {
    const [x, y, z] = grid.axes();
    const [nz, ny, nx] = grid.shape;
    const jidx = M.arange(0, y.length, 1);
    const jf = M.interp1(depth, y, jidx);
    const j0 = Math.floor(jf);
    const j1 = Math.min(j0 + 1, y.length - 1);
    const t = jf - j0;
    const plane = (kk, ii) => (1 - t) * dose[(kk * ny + j0) * nx + ii] + t * dose[(kk * ny + j1) * nx + ii];
    const i = M.argminAbs(x, 0), k = M.argminAbs(z, 0);
    const d = direction.toUpperCase();
    if (d === "X") return [Float64Array.from(x), Float64Array.from(x, (_, ii) => plane(k, ii))];
    if (d === "Y") return [Float64Array.from(z), Float64Array.from(z, (_, kk) => plane(kk, i))];
    if (d === "D") {
      const n = Math.min(x.length, z.length);
      const off = Math.floor((n - 1) / 2);
      const pos = new Float64Array(2 * off + 1), vals = new Float64Array(2 * off + 1);
      for (let q = -off; q <= off; q++) {
        vals[q + off] = plane(k + q, i + q);
        pos[q + off] = M.sign(q) * M.hypot(x[i + q] - x[i], z[k + q] - z[k]);
      }
      return [pos, vals];
    }
    throw new Error(direction);
  };
  M.pointDose = function (dose, grid, depth, xmm, zmm) {
    const f = grid.worldToIndex([xmm || 0.0, depth, zmm || 0.0]);
    return M.mapCoord3(dose, grid.shape, f[0], f[1], f[2], "constant", 0.0);
  };
});
