/* CalcIndep web · motor de cálculo: densidad, TERMA, superposición y suma por haces (engine.py),
 * calibración (calibration.py). Las operaciones pesadas se piden a un "backend" asíncrono
 * (hilos en paralelo o GPU) con la interfaz:
 *   backend.superpose(T, rho, shape, spCm, dirs, A, a, mask, lineCm, stepCm) -> Promise<Float64Array>
 *   backend.termaMany([params...]) -> Promise<[{T, De}...]>
 */
CI_MOTOR_MODULOS.push(function CIMod_motor(M) {
  "use strict";
  const AIR_RED = 0.001;
  M.AIR_RED = AIR_RED;

  class Cancelled extends Error { constructor() { super("Cálculo cancelado"); this.cancelled = true; } }
  M.Cancelled = Cancelled;

  M.CalcOptions = function (o) {
    const d = {
      fluence_res_mm: 0.5, max_gantry_step_deg: 2.0, sector_deg: 10.0, ray_spacing_mm: null,
      line_spacing_mm: null, step_mm: null, density_supersampling: 3, outside_external: "air",
      keep_support_structures: true, apply_structure_overrides: true, margin_mm: 20.0,
      structure_overrides: {}, trace_full_ct: true, kernel_tilt: true, tilt_tile_deg: 10.0,
      tilt_min_halfangle_deg: 4.5, tilt_coarse_mm: 5.0, gpu: null,
    };
    return Object.assign(d, o || {});
  };
  M.CALC_OPTION_KEYS = Object.keys(M.CalcOptions());

  // backend síncrono (un hilo): para pruebas y como último recurso
  M.syncBackend = {
    describe: () => "CPU (JavaScript, 1 hilo)",
    superpose: async (T, rho, shape, sp, dirs, A, a, mask, lineCm, stepCm) =>
      M.superpose(T, rho, shape, sp, dirs, A, a, mask, lineCm, stepCm),
    termaMany: async list => list.map(p => M.computeTerma(p)),
    warnings: [],
  };

  // ------------------------------------------------------------------ densidad
  M.resampleRED = function (ct, curve, grid, supersampling) {
    supersampling = supersampling === undefined ? 3 : supersampling;
    const src = ct.data;
    const red = new Float32Array(src.length);
    for (let q = 0; q < src.length; q++) red[q] = curve.value(src[q]);
    const n = Math.max(1, Math.trunc(supersampling));
    const offs = [];
    for (let q = 0; q < n; q++) offs.push((q + 0.5) / n - 0.5);
    const [x, y, z] = grid.axes();
    const [nz, ny, nx] = grid.shape;
    const acc = new Float64Array(nz * ny * nx);
    const cg = ct.grid, cs = ct.grid.shape;
    const cval = Math.fround(AIR_RED);
    const fk = new Float64Array(nz), fj = new Float64Array(ny), fi = new Float64Array(nx);
    for (const oz of offs) for (const oy of offs) for (const ox of offs) {
      for (let k = 0; k < nz; k++) fk[k] = ((z[k] + oz * grid.spacing[2]) - cg.origin[2]) / cg.spacing[2];
      for (let j = 0; j < ny; j++) fj[j] = ((y[j] + oy * grid.spacing[1]) - cg.origin[1]) / cg.spacing[1];
      for (let i = 0; i < nx; i++) fi[i] = ((x[i] + ox * grid.spacing[0]) - cg.origin[0]) / cg.spacing[0];
      let p = 0;
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, p++) {
        const v = M.mapCoord3(red, cs, fk[k], fj[j], fi[i], "constant", cval);
        acc[p] += Math.fround(v);
      }
    }
    const den = n * n * n;
    for (let p = 0; p < acc.length; p++) acc[p] = acc[p] / den;
    return acc;
  };

  M.calcGridFrom = function (ref, extMask, margin) {
    margin = margin === undefined ? 20.0 : margin;
    const [nz, ny, nx] = ref.shape;
    let kmin = Infinity, kmax = -1, jmin = Infinity, jmax = -1, imin = Infinity, imax = -1;
    if (extMask) {
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
        const b = (k * ny + j) * nx;
        for (let i = 0; i < nx; i++) if (extMask[b + i]) {
          if (k < kmin) kmin = k; if (k > kmax) kmax = k; if (j < jmin) jmin = j; if (j > jmax) jmax = j;
          if (i < imin) imin = i; if (i > imax) imax = i;
        }
      }
    }
    if (!extMask || kmax < 0) return [ref, [0, nz, 0, ny, 0, nx]];
    const m = [Math.ceil(margin / ref.spacing[0]), Math.ceil(margin / ref.spacing[1]), Math.ceil(margin / ref.spacing[2])];
    const k0 = Math.max(0, kmin - m[2]), k1 = Math.min(nz, kmax + m[2] + 1);
    const j0 = Math.max(0, jmin - m[1]), j1 = Math.min(ny, jmax + m[1] + 1);
    const i0 = Math.max(0, imin - m[0]), i1 = Math.min(nx, imax + m[0] + 1);
    return [ref.crop(k0, k1, j0, j1, i0, i1), [k0, k1, j0, j1, i0, i1]];
  };

  // rasterize: función (estructura, rejilla) -> Uint8Array; se puede sustituir por una versión en paralelo
  async function applyOverrides(rho, grid, structures, curve, o, info, rast) {
    const byName = new Map(structures.map(s => [s.name, s]));
    const ovr = o.structure_overrides || {};
    if (o.apply_structure_overrides) {
      for (const s of structures) {
        if (s.rel_elec_density !== null && s.rel_elec_density !== undefined && s.type !== "EXTERNAL" &&
            !(s.name in ovr)) {
          const sm = await rast(s, grid);
          for (let p = 0; p < sm.length; p++) if (sm[p]) rho[p] = s.rel_elec_density;
          info.overrides.push([s.name, s.rel_elec_density]);
        }
      }
    }
    for (const name of Object.keys(ovr)) {
      const val = ovr[name];
      const s = byName.get(name);
      if (!s) { (info.missing_overrides = info.missing_overrides || []).push(name); continue; }
      const red = ("red" in val) ? Number(val.red) : curve.value(Number(val.hu));
      const sm = await rast(s, grid);
      for (let p = 0; p < sm.length; p++) if (sm[p]) rho[p] = red;
      info.overrides.push([name, red]);
    }
  }
  M.buildDensity = async function (ct, curve, grid, structures, options, rast) {
    const o = options || M.CalcOptions();
    rast = rast || (async (s, g) => M.rasterize(s, g));
    const rho = M.resampleRED(ct, curve, grid, o.density_supersampling);
    const info = { overrides: [], external: null, support: [] };
    let calcMask = new Uint8Array(grid.size).fill(1);
    if (structures && structures.length) {
      const ext = structures.filter(s => s.type === "EXTERNAL");
      if (ext.length) {
        const em = await rast(ext[0], grid);
        info.external = ext[0].name;
        const keep = Uint8Array.from(em);
        if (o.keep_support_structures) {
          for (const s of structures) if (s.type === "SUPPORT") {
            const sm = await rast(s, grid);
            for (let p = 0; p < keep.length; p++) keep[p] = keep[p] | sm[p];
            info.support.push(s.name);
          }
        }
        if (o.outside_external === "air") for (let p = 0; p < keep.length; p++) if (!keep[p]) rho[p] = AIR_RED;
        calcMask = keep;
      }
      await applyOverrides(rho, grid, structures, curve, o, info, rast);
    }
    return { rho, mask: calcMask, info };
  };
  M.buildTraceDensity = async function (ct, curve, structures, spacing, options, rast) {
    const o = options || M.CalcOptions();
    rast = rast || (async (s, g) => M.rasterize(s, g));
    const [x0, x1, y0, y1, z0, z1] = ct.grid.extent();
    const sp = [spacing, spacing, spacing];
    const n = [Math.floor((x1 - x0) / sp[0]) + 1, Math.floor((y1 - y0) / sp[1]) + 1, Math.floor((z1 - z0) / sp[2]) + 1];
    const g = new M.Grid([x0, y0, z0], sp, [n[2], n[1], n[0]]);
    const rho = M.resampleRED(ct, curve, g, 1);
    const info = { overrides: [] };
    if (structures && structures.length) {
      const ext = structures.filter(s => s.type === "EXTERNAL");
      if (ext.length && o.outside_external === "air") {
        const keep = Uint8Array.from(await rast(ext[0], g));
        if (o.keep_support_structures) for (const s of structures) if (s.type === "SUPPORT") {
          const sm = await rast(s, g);
          for (let p = 0; p < keep.length; p++) keep[p] = keep[p] | sm[p];
        }
        for (let p = 0; p < keep.length; p++) if (!keep[p]) rho[p] = AIR_RED;
      }
      await applyOverrides(rho, g, structures, curve, o, info, rast);
    }
    return { rho, grid: g };
  };

  // ------------------------------------------------------------------ cálculo
  function frame(axis, refU) {
    const n = M.norm3(axis);
    const w = [axis[0] / n, axis[1] / n, axis[2] / n];
    const dw = M.dot3(refU, w);
    let u = [refU[0] - dw * w[0], refU[1] - dw * w[1], refU[2] - dw * w[2]];
    if (M.norm3(u) < 1e-6) u = M.cross3(w, [1.0, 0.0, 0.0]);
    const nu = M.norm3(u);
    u = [u[0] / nu, u[1] / nu, u[2] / nu];
    const v = M.cross3(w, u);
    return [u, v, w];
  }
  M.frame = frame;
  // directions @ column_stack([u, v, w]).T
  function rotateDirs(dirs, u, v, w) {
    return dirs.map(d => [d[0] * u[0] + d[1] * v[0] + d[2] * w[0], d[0] * u[1] + d[1] * v[1] + d[2] * w[1],
                          d[0] * u[2] + d[1] * v[2] + d[2] * w[2]]);
  }
  M.rotateDirs = rotateDirs;

  // Reducción por bloques f x f x f (pad "edge"): media o "any"
  function down(a, shape, f, how) {
    if (f === 1) return { arr: a, shape: shape.slice() };
    const [nz, ny, nx] = shape;
    const cz = Math.ceil(nz / f), cy = Math.ceil(ny / f), cx = Math.ceil(nx / f);
    const isAny = how === "any";
    const out = isAny ? new Uint8Array(cz * cy * cx) : new Float64Array(cz * cy * cx);
    const cnt = f * f * f;
    for (let kc = 0; kc < cz; kc++) for (let jc = 0; jc < cy; jc++) for (let ic = 0; ic < cx; ic++) {
      let s = 0.0, any = 0;
      for (let ka = 0; ka < f; ka++) {
        const k = Math.min(kc * f + ka, nz - 1);
        for (let jb = 0; jb < f; jb++) {
          const base = (k * ny + Math.min(jc * f + jb, ny - 1)) * nx;
          for (let ic2 = 0; ic2 < f; ic2++) {
            const v = a[base + Math.min(ic * f + ic2, nx - 1)];
            if (isAny) { if (v) any = 1; } else s += v;
          }
        }
      }
      const q = (kc * cy + jc) * cx + ic;
      out[q] = isAny ? any : s / cnt;
    }
    return { arr: out, shape: [cz, cy, cx] };
  }
  M.downBlocks = down;

  class DoseEngine {
    constructor(models, options, edk, backend) {
      if (models instanceof M.BeamModel) models = new M.BeamModelLibrary([models]);
      this.library = models;
      this.options = options || M.CalcOptions();
      this.cones = new M.ConeCache(edk);
      this.assignments = new Map();
      this.step_callback = null;
      this.backend = backend || M.syncBackend;
      this.cancel = null;   // función que lanza Cancelled si se ha pedido cancelar
    }
    modelFor(beam) {
      if (this.assignments.has(beam.number)) return this.assignments.get(beam.number);
      return this.library.find(beam.machine, beam.energy, beam.fluence_mode);
    }
    groupKey(beam, gantry, coll, couch) {
      const o = this.options;
      const k = beam.is_arc ? Math.floor(M.pymod(gantry + 0.5 * o.sector_deg, 360.0) / o.sector_deg) : 0;
      return [k, M.pyRound(couch, 1), M.pyRound(coll, 1)];
    }
    countGroups(beam) {
      const ang = M.subbeamAngles(beam, this.options.max_gantry_step_deg);
      return new Set(ang.map(([g, c, t]) => JSON.stringify(this.groupKey(beam, g, c, t)))).size;
    }
    async superposeGroup(rho, grid, model, group, mask, trace) {
      const o = this.options;
      const cs = this.cones.get(model);
      const e = model.energies, w = model.weights, mu = M.muRhoWater(e);
      const n = grid.size;
      const T = new Float64Array(n), De = new Float64Array(n);
      const axis = [0, 0, 0];
      const params = group.map(sb => ({
        rho, grid, rho_t: trace ? trace.rho : null, grid_t: trace ? trace.grid : null, geom: sb.geom,
        fluence: sb.fluence, fshape: sb.fshape, axes: sb.axes, efluence: sb.efluence, energies: e, weights: w, mu,
        softening: model.softening_per_cm, softening_rmax_cm: model.softening_rmax_cm,
        softening_power: model.softening_power === undefined ? 1.0 : model.softening_power,
        ke: model.econt_k_per_cm, ray_spacing_mm: o.ray_spacing_mm, step_mm: null,
      }));
      const res = await this.backend.termaMany(params);
      group.forEach((sb, q) => {
        const t = res[q].T, de = res[q].De;
        for (let p = 0; p < n; p++) { T[p] += t[p]; De[p] += de[p]; }
        const ax = sb.geom.axis, wmu = Math.max(sb.mu, 1e-9);
        axis[0] += ax[0] * wmu; axis[1] += ax[1] * wmu; axis[2] += ax[2] * wmu;
      });
      if (this.cancel) this.cancel();
      const [u, v, wv] = frame(axis, group[0].geom.u);
      const spCm = [grid.spacing[0] / 10.0, grid.spacing[1] / 10.0, grid.spacing[2] / 10.0];
      const lineCm = o.line_spacing_mm === null || o.line_spacing_mm === undefined ? null : o.line_spacing_mm / 10;
      const stepCm = o.step_mm === null || o.step_mm === undefined ? null : o.step_mm / 10;
      const tilt = o.kernel_tilt && (model.kernel_tilt === undefined ? true : model.kernel_tilt);
      const tiles = tilt ? this.tiltTiles(T, grid, group[Math.floor(group.length / 2)].geom.source, u, v, wv) : null;
      const D = await this.backend.superpose(T, rho, grid.shape, spCm, rotateDirs(cs.directions, u, v, wv), cs.A, cs.a,
                                             mask, lineCm, stepCm);
      if (tiles) {
        const corr = await this.tiltCorrection(T, rho, grid, mask, tiles, cs, [u, v, wv], lineCm, stepCm);
        for (let p = 0; p < n; p++) D[p] += corr[p] * (mask ? mask[p] : 1);
      }
      for (let p = 0; p < n; p++) D[p] = D[p] + De[p] * (mask ? mask[p] : 1);
      return D;
    }
    async tiltCorrection(T, rho, grid, mask, tiles, cs, fr, lineCm, stepCm) {
      const o = this.options;
      const [u, v, w] = fr;
      const f = Math.max(1, Math.trunc(Math.floor(o.tilt_coarse_mm / grid.minSpacing() + 1e-6)));
      const rc = down(rho, grid.shape, f, "mean");
      const mc = mask ? down(mask, grid.shape, f, "any") : null;
      const spc = [grid.spacing[0] * f / 10.0, grid.spacing[1] * f / 10.0, grid.spacing[2] * f / 10.0];
      let lc = lineCm, sc = stepCm;
      if (f > 1) { lc = lineCm === null ? null : lineCm * f; sc = stepCm === null ? null : stepCm * f; }
      const Tc = down(T, grid.shape, f, "mean");
      const base = await this.backend.superpose(Tc.arr, rc.arr, rc.shape, spc, rotateDirs(cs.directions, u, v, w),
                                                cs.A, cs.a, mc ? mc.arr : null, lc, sc);
      const diff = new Float64Array(base.length);
      for (let p = 0; p < base.length; p++) diff[p] = -base[p];
      const Tw = new Float64Array(grid.size);
      for (const [idx, wts, d] of tiles) {
        if (this.cancel) this.cancel();
        const [tu, tv, tw] = frame(d, u);
        Tw.fill(0.0);
        for (let q = 0; q < idx.length; q++) Tw[idx[q]] = wts[q];
        const Twc = down(Tw, grid.shape, f, "mean");
        const part = await this.backend.superpose(Twc.arr, rc.arr, rc.shape, spc, rotateDirs(cs.directions, tu, tv, tw),
                                                  cs.A, cs.a, mc ? mc.arr : null, lc, sc);
        for (let p = 0; p < diff.length; p++) diff[p] += part[p];
      }
      if (f === 1) return diff;
      const [nz, ny, nx] = grid.shape;
      const out = new Float64Array(grid.size);
      const ck = new Float64Array(nz), cj = new Float64Array(ny), ci = new Float64Array(nx);
      for (let k = 0; k < nz; k++) ck[k] = (k - (f - 1) / 2.0) / f;
      for (let j = 0; j < ny; j++) cj[j] = (j - (f - 1) / 2.0) / f;
      for (let i = 0; i < nx; i++) ci[i] = (i - (f - 1) / 2.0) / f;
      let p = 0;
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, p++)
        out[p] = M.mapCoord3(diff, rc.shape, ck[k], cj[j], ci[i], "nearest");
      return out;
    }
    tiltTiles(T, grid, src, u, v, w) {
      const o = this.options;
      let tmax = -Infinity;
      for (let p = 0; p < T.length; p++) if (T[p] > tmax) tmax = T[p];
      if (tmax <= 0) return null;
      const [x, y, z] = grid.axes();
      const [nz, ny, nx] = grid.shape;
      const flat = [], tv = [], axv = [], ayv = [], core = [];
      const td = o.tilt_tile_deg;
      let angMax = -Infinity;
      let axMin = Infinity, axMax = -Infinity, ayMin = Infinity, ayMax = -Infinity;
      let p = 0;
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, p++) {
        const t = T[p];
        if (!(t > 0)) continue;
        const r0 = x[i] - src[0], r1 = y[j] - src[1], r2 = z[k] - src[2];
        const rw = r0 * w[0] + r1 * w[1] + r2 * w[2];
        const ru = r0 * u[0] + r1 * u[1] + r2 * u[2];
        const rv = r0 * v[0] + r1 * v[1] + r2 * v[2];
        const ax = M.rad2deg(Math.atan2(ru, rw)) / td, ay = M.rad2deg(Math.atan2(rv, rw)) / td;
        flat.push(p); tv.push(t); axv.push(ax); ayv.push(ay);
        const c = t > 0.05 * tmax;
        core.push(c);
        if (c) {
          const ang = M.rad2deg(Math.atan2(M.hypot(ru, rv), rw));
          if (ang > angMax) angMax = ang;
          if (ax < axMin) axMin = ax; if (ax > axMax) axMax = ax;
          if (ay < ayMin) ayMin = ay; if (ay > ayMax) ayMax = ay;
        }
      }
      if (angMax <= o.tilt_min_halfangle_deg) return null;
      const nx0 = M.rint(axMin), nx1 = M.rint(axMax), ny0 = M.rint(ayMin), ny1 = M.rint(ayMax);
      if (nx0 === nx1 && ny0 === ny1) return null;
      const N = flat.length;
      const ixA = new Int32Array(N), iyA = new Int32Array(N), fxA = new Float64Array(N), fyA = new Float64Array(N);
      const capX = Math.max(nx1 - 1, nx0), capY = Math.max(ny1 - 1, ny0);
      for (let q = 0; q < N; q++) {
        const ax = Math.min(Math.max(axv[q], nx0), nx1), ay = Math.min(Math.max(ayv[q], ny0), ny1);
        const ix = Math.min(Math.floor(ax), capX), iy = Math.min(Math.floor(ay), capY);
        ixA[q] = ix; iyA[q] = iy;
        fxA[q] = nx1 > nx0 ? ax - ix : 0.0;
        fyA[q] = ny1 > ny0 ? ay - iy : 0.0;
      }
      // acc[(nx, ny)] -> wsum por punto (sumando las partes en el orden de los bucles dx, dy)
      const acc = new Map();
      for (const dx of [0, 1]) for (const dy of [0, 1]) {
        for (let q = 0; q < N; q++) {
          const wx = dx === 0 ? 1.0 - fxA[q] : fxA[q];
          const wy = dy === 0 ? 1.0 - fyA[q] : fyA[q];
          const wt = wx * wy;
          if (!(wt > 0)) continue;
          const kx = ixA[q] + dx, ky = iyA[q] + dy;
          const key = kx + "," + ky;
          let e = acc.get(key);
          if (!e) { e = { kx, ky, w: new Float64Array(N) }; acc.set(key, e); }
          e.w[q] += wt;
        }
      }
      const keys = Array.from(acc.values()).sort((a, b) => (a.kx - b.kx) || (a.ky - b.ky));
      const tiles = [];
      for (const e of keys) {
        const idx = [], wts = [];
        for (let q = 0; q < N; q++) if (e.w[q] > 0) { idx.push(flat[q]); wts.push(tv[q] * e.w[q]); }
        const tx = Math.tan(M.deg2rad(e.kx * td)), ty = Math.tan(M.deg2rad(e.ky * td));
        const d = [tx * u[0] + ty * v[0] + w[0], tx * u[1] + ty * v[1] + w[1], tx * u[2] + ty * v[2] + w[2]];
        const dn = M.norm3(d);
        tiles.push([Int32Array.from(idx), Float64Array.from(wts), [d[0] / dn, d[1] / dn, d[2] / dn]]);
      }
      return tiles;
    }
    // Grupos de incidencias de un haz (las fluencias se calculan al superponer cada grupo)
    async computeBeamRaw(beam, model, rho, grid, mask, trace) {
      const o = this.options;
      const plan = M.subbeamPlan(beam, model, o.fluence_res_mm, o.max_gantry_step_deg);
      const groups = new Map();
      for (const spec of plan.specs) {
        const key = this.groupKey(beam, spec.gantry, spec.coll, spec.couch);
        const ks = JSON.stringify(key);
        if (!groups.has(ks)) groups.set(ks, { key, specs: [] });
        groups.get(ks).specs.push(spec);
      }
      const D = new Float64Array(grid.size);
      const sorted = Array.from(groups.values()).sort((a, b) =>
        (a.key[0] - b.key[0]) || (a.key[1] - b.key[1]) || (a.key[2] - b.key[2]));
      const n = sorted.length;
      if (this.step_callback) this.step_callback(beam, 0, n);
      for (let i = 0; i < n; i++) {
        if (this.cancel) this.cancel();
        const group = sorted[i].specs.map(sp => M.subbeamFluence(plan, sp));
        const Dg = await this.superposeGroup(rho, grid, model, group, mask, trace);
        for (let p = 0; p < D.length; p++) D[p] += Dg[p];
        if (this.step_callback) this.step_callback(beam, i + 1, n);
      }
      return [D, plan.specs.length, n];
    }
    async computeBeam(beam, rho, grid, mask, trace) {
      const t0 = Date.now();
      const model = this.modelFor(beam);
      const [D, nsb, ngr] = await this.computeBeamRaw(beam, model, rho, grid, mask, trace);
      const cal = model.calibration;
      if (cal.cgy_per_unit <= 0)
        throw new Error(`El modelo '${model.name}' no está calibrado (calibration.cgy_per_unit)`);
      const warn = beam.warnings.slice();
      if (Math.abs(cal.grid_mm - grid.minSpacing()) > 0.6)
        warn.push(`La calibración del modelo se hizo con rejilla de ${M.pyFloat(+cal.grid_mm)} mm ` +
                  `y el cálculo usa ${M.fmtF(grid.minSpacing(), 2)} mm`);
      if (!model.commissioned) warn.push("Modelo de haz no comisionado: resultado no válido para uso clínico");
      const doseGy = new Float64Array(D.length);
      for (let p = 0; p < D.length; p++) doseGy[p] = D[p] * cal.cgy_per_unit / 100.0;
      const [mlcName, mp] = model.mlcForBeam(beam);
      const mlcTxt = mlcName === null ? "" : `${M.mlcDisplayName(mlcName)} (T ${M.fmtG(mp.transmission)}, ` +
        `DLG ${M.fmtG(mp.dlg_mm)} mm, ` + (mp.tg_width_mm > 0 ? `LR ${M.fmtG(mp.tg_width_mm)} mm)` : "sin LR)");
      return { number: beam.number, name: beam.name, mu: beam.mu, technique: beam.technique, model: model.name,
               dose_gy: doseGy, n_subbeams: nsb, n_superpositions: ngr, seconds: (Date.now() - t0) / 1000,
               warnings: warn, mlc: mlcTxt };
    }
    checkPlan(plan) {
      const errors = [];
      for (const b of DoseEngine.treatmentBeams(plan)) {
        try { this.modelFor(b).mlcForBeam(b); }
        catch (e) { errors.push(`Haz ${b.name}: ${e.isKeyError ? e.message : e.message}`); }
      }
      if (errors.length) throw new Error("No se puede calcular el plan:\n" + errors.join("\n"));
    }
    static treatmentBeams(plan) {
      return plan.beams.filter(b => b.beam_type === "TREATMENT" && b.mu > 0 && b.radiation_type === "PHOTON");
    }
    async computePlan(plan, rho, grid, mask, progress, trace) {
      const results = [];
      this.checkPlan(plan);
      const treat = DoseEngine.treatmentBeams(plan);
      for (let i = 0; i < treat.length; i++) {
        const b = treat[i];
        if (progress) progress(`Haz ${i + 1}/${treat.length}: ${b.name} (${b.technique}, ${M.fmtF(b.mu, 1)} UM)`);
        results.push(await this.computeBeam(b, rho, grid, mask, trace));
      }
      const total = new Float64Array(grid.size);
      for (const r of results) for (let p = 0; p < total.length; p++) total[p] += r.dose_gy[p];
      return [total, results];
    }
  }
  M.DoseEngine = DoseEngine;

  // ------------------------------------------------------------------ calibración
  M.computeWater = async function (engine, model, beam, grid) {
    const rho = new Float64Array(grid.size).fill(1.0);
    const mask = new Uint8Array(grid.size).fill(1);
    const [D] = await engine.computeBeamRaw(beam, model, rho, grid, mask);
    return D;
  };
  M.calibrate = async function (model, spacing, engine) {
    spacing = spacing === undefined ? 2.5 : spacing;
    const cal = model.calibration;
    const lateral = Math.max(250.0, cal.field_mm * 1.6 + 100.0);
    const grid = M.waterGrid(spacing, lateral, Math.max(250.0, cal.depth_mm + 150.0));
    const mu = 100.0;
    const beam = M.squareBeam(cal.field_mm, null, { ssd_mm: cal.ssd_mm, mu, energy: model.energy,
                                                    fluence_mode: model.fluence_mode });
    const D = await M.computeWater(engine, model, beam, grid);
    const d = M.pointDose(D, grid, cal.depth_mm);
    if (!isFinite(d) || d <= 0) throw new Error("Dosis de referencia no válida en la calibración");
    cal.cgy_per_unit = cal.dose_per_mu_cgy * mu / d;
    cal.grid_mm = +spacing;
    return cal.cgy_per_unit;
  };
});
