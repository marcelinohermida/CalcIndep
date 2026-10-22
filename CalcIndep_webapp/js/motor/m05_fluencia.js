/* CalcIndep web · fluencia en el plano del isocentro (fluence.py). */
CI_MOTOR_MODULOS.push(function CIMod_fluencia(M) {
  "use strict";

  // Intervalo de t en [t0, t1] donde c0 + c1 t > 0 (versión escalar de _igt)
  function igt(c0, c1, t0, t1, out) {
    let lo = t0, hi = t1;
    if (c1 > 0) { const tc = -c0 / c1; lo = Math.max(lo, tc); }
    else if (c1 < 0) { const tc = -c0 / c1; hi = Math.min(hi, tc); }
    else if (c0 <= 0) hi = lo;
    out[0] = lo; out[1] = hi;
  }
  // np.maximum/np.minimum con NaN se propagan; aquí no aparecen NaN salvo -c0/c1 con c1 != 0
  const mx = (a, b) => (a > b || a !== a) ? a : b;
  const mn = (a, b) => (a < b || a !== a) ? a : b;

  // Apertura relativa del segmento [t0, t1] (leaf_fractions + aperture_from_fractions)
  M.apertureFast = function (cpa, cpb, t0, t1, xg, yg, rows, dlg, tg, tMlc, tJaw) {
    const ny = yg.length, nx = xg.length;
    const out = new Float64Array(ny * nx);
    const jaws = [cpa.x1, cpb.x1, cpa.x2, cpb.x2, cpa.y1, cpb.y1, cpa.y2, cpb.y2];
    const hasMlc = !!(cpa.mlc_a && rows);
    const la0 = hasMlc ? cpa.mlc_a : null, la1 = hasMlc ? cpb.mlc_a : null;
    const lb0 = hasMlc ? cpa.mlc_b : null, lb1 = hasMlc ? cpb.mlc_b : null;
    const hasTg = !!tg;
    const dt = t1 - t0;
    const hd = 0.5 * dlg;
    const r1 = [0, 0], r2 = [0, 0], r3 = [0, 0], r4 = [0, 0], r5 = [0, 0], r6 = [0, 0], r7 = [0, 0], r8 = [0, 0];
    for (let j = 0; j < ny; j++) {
      const Y = yg[j];
      igt(Y - jaws[4], -(jaws[5] - jaws[4]), t0, t1, r3);
      igt(jaws[6] - Y, (jaws[7] - jaws[6]), t0, t1, r4);
      const r = hasMlc ? rows[j] : -1;
      const valid = r >= 0;
      let sel = false;
      if (valid && hasTg) sel = tg[0][j] >= 0 && tg[1][j] > 0;
      let a0 = 0, a1 = 0, b0 = 0, b1 = 0, na0 = 0, na1 = 0, nb0 = 0, nb1 = 0, w = 0;
      if (valid) { a0 = la0[r] - hd; a1 = la1[r] - hd; b0 = lb0[r] + hd; b1 = lb1[r] + hd; }
      if (sel) {
        const q = tg[0][j];
        na0 = la0[q] - hd; na1 = la1[q] - hd; nb0 = lb0[q] + hd; nb1 = lb1[q] + hd; w = tg[1][j];
      }
      const base = j * nx;
      for (let i = 0; i < nx; i++) {
        const X = xg[i];
        igt(X - jaws[0], -(jaws[1] - jaws[0]), t0, t1, r1);
        igt(jaws[2] - X, (jaws[3] - jaws[2]), t0, t1, r2);
        const loJ = Math.max(Math.max(r1[0], r2[0]), Math.max(r3[0], r4[0]));
        const hiJ = Math.min(Math.min(r1[1], r2[1]), Math.min(r3[1], r4[1]));
        const fj = Math.max(hiJ - loJ, 0.0);
        let fo, fm;
        if (!hasMlc || !valid) { fo = fj; fm = dt; }
        else {
          igt(X - a0, -(a1 - a0), t0, t1, r5);
          igt(b0 - X, (b1 - b0), t0, t1, r6);
          const loM = Math.max(r5[0], r6[0]), hiM = Math.min(r5[1], r6[1]);
          fm = Math.max(hiM - loM, 0.0);
          fo = Math.max(Math.min(hiM, hiJ) - Math.max(loM, loJ), 0.0);
          if (sel) {
            igt(X - na0, -(na1 - na0), t0, t1, r7);
            igt(nb0 - X, (nb1 - nb0), t0, t1, r8);
            const loN = Math.max(r7[0], r8[0]), hiN = Math.min(r7[1], r8[1]);
            const lo2 = Math.max(loM, loN), hi2 = Math.min(hiM, hiN);
            const fm2 = Math.max(hi2 - lo2, 0.0);
            const fo2 = Math.max(Math.min(hi2, hiJ) - Math.max(lo2, loJ), 0.0);
            fo = (1.0 - w) * fo + w * fo2;
            fm = (1.0 - w) * fm + w * fm2;
          }
        }
        const both = Math.max(dt - fj - fm + fo, 0.0);
        const jawOnly = Math.max(fm - fo, 0.0);
        const mlcOnly = Math.max(fj - fo, 0.0);
        out[base + i] = fo + tMlc * mlcOnly + tJaw * jawOnly + tJaw * tMlc * both;
      }
    }
    return out;
  };

  function beamExtent(beam) {
    let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
    for (const cp of beam.cps) {
      x1 = Math.min(x1, cp.x1); x2 = Math.max(x2, cp.x2); y1 = Math.min(y1, cp.y1); y2 = Math.max(y2, cp.y2);
    }
    return [Math.max(x1, -200.0), Math.min(x2, 200.0), Math.max(y1, -200.0), Math.min(y2, 200.0)];
  }

  // Interpolación bilineal de c (ny x nx) en la red (jj, ii); fuera del borde, valor del borde
  function upsampleLin(c, cny, cnx, jj, ii) {
    const out = new Float64Array(jj.length * ii.length);
    for (let j = 0; j < jj.length; j++) {
      const fy = Math.min(Math.max(jj[j], 0.0), cny - 1.0);
      let j0 = Math.trunc(fy);
      if (j0 > cny - 2) j0 = Math.max(cny - 2, 0);
      const j1 = Math.min(j0 + 1, cny - 1);
      const ty = fy - j0;
      for (let i = 0; i < ii.length; i++) {
        const fx = Math.min(Math.max(ii[i], 0.0), cnx - 1.0);
        let i0 = Math.trunc(fx);
        if (i0 > cnx - 2) i0 = Math.max(cnx - 2, 0);
        const i1 = Math.min(i0 + 1, cnx - 1);
        const tx = fx - i0;
        out[j * ii.length + i] = ((1.0 - ty) * ((1.0 - tx) * c[j0 * cnx + i0] + tx * c[j0 * cnx + i1])
          + ty * ((1.0 - tx) * c[j1 * cnx + i0] + tx * c[j1 * cnx + i1]));
      }
    }
    return out;
  }
  // Filtro gaussiano (σ escalar o [σ_filas, σ_columnas] en píxeles); para σ grandes, en malla reducida
  function broadBlur(A, ny, nx, sigmaPx) {
    const sig = Array.isArray(sigmaPx) ? sigmaPx.map(Number) : [sigmaPx, sigmaPx];
    const smin = Math.min(sig[0], sig[1]);
    if (smin < 6.0) return M.gaussianFilter(A, [ny, nx], sig);
    const f = Math.max(1, Math.trunc(Math.floor(smin / 6)));
    const py = M.pymod(-ny, f), px = M.pymod(-nx, f);
    const NY = ny + py, NX = nx + px;
    const cny = NY / f, cnx = NX / f;
    const c = new Float64Array(cny * cnx);
    // media por bloques (np.pad con ceros + reshape + mean(axis=(1, 3)))
    const blk = new Float64Array(f * f);
    for (let cj = 0; cj < cny; cj++) {
      for (let ci = 0; ci < cnx; ci++) {
        let n = 0;
        for (let a = 0; a < f; a++) {
          const jj = cj * f + a;
          for (let b = 0; b < f; b++) {
            const ii = ci * f + b;
            blk[n++] = (jj < ny && ii < nx) ? A[jj * nx + ii] : 0.0;
          }
        }
        let s = 0.0;
        for (let q = 0; q < n; q++) s += blk[q];
        c[cj * cnx + ci] = s / (f * f);
      }
    }
    const cf = M.gaussianFilter(c, [cny, cnx], [sig[0] / f, sig[1] / f]);
    const jj = new Float64Array(ny), ii = new Float64Array(nx);
    for (let j = 0; j < ny; j++) jj[j] = (j + 0.5) / f - 0.5;
    for (let i = 0; i < nx; i++) ii[i] = (i + 0.5) / f - 0.5;
    return upsampleLin(cf, cny, cnx, jj, ii);
  }
  M.broadBlur = broadBlur;

  // Apertura integrada -> fluencia de energía (psi) y mapa de contaminación electrónica (e)
  function applyModel(A, ny, nx, model, xg, yg, res, cache) {
    const sp = model.primary_sigma_mm / res;
    let prim = sp > 0.05 ? M.gaussianFilter(A, [ny, nx], sp) : Float64Array.from(A);
    let oa, pc;
    if (cache && cache.oa) { oa = cache.oa; pc = cache.pc; }
    else {
      oa = new Float64Array(ny * nx);
      pc = null;
      const rpc = model.primary_collimator_radius_mm;
      if (rpc > 0) pc = new Float64Array(ny * nx);
      const sg = Math.max(model.primary_collimator_sigma_mm, 0.1);
      const den = Math.sqrt(2.0) * sg;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const R = M.hypot(xg[i], yg[j]);
        oa[j * nx + i] = model.oa(R);
        if (pc) pc[j * nx + i] = M.erfc((R - rpc) / den);
      }
      if (cache) { cache.oa = oa; cache.pc = pc; }
    }
    const pw = model.primary_weight;
    for (let p = 0; p < prim.length; p++) {
      let v = prim[p] * oa[p] * pw;
      if (pc) v = v * 0.5 * pc[p];
      prim[p] = v;
    }
    let psi = prim;
    if (model.extrafocal_weight > 0) {
      const [sx, sy] = model.ef_sigmas;
      const bb = broadBlur(A, ny, nx, [sy / res, sx / res]);
      const w = model.extrafocal_weight;
      psi = new Float64Array(prim.length);
      for (let p = 0; p < prim.length; p++) psi[p] = prim[p] + w * bb[p];
    }
    let e;
    if (model.econt_weight > 0) {
      const bb = broadBlur(A, ny, nx, model.econt_sigma_mm / res);
      e = new Float64Array(bb.length);
      for (let p = 0; p < bb.length; p++) e[p] = model.econt_weight * bb[p];
    } else e = new Float64Array(A.length);
    return [psi, e];
  }

  // Preparación de las incidencias de un haz (fluence.subbeams sin calcular aún los mapas):
  // devuelve el contexto común y la lista ordenada de incidencias.
  M.subbeamPlan = function (beam, model, resMm, maxGantryStep, marginMm) {
    resMm = resMm === undefined ? 0.5 : resMm;
    maxGantryStep = maxGantryStep === undefined ? 2.0 : maxGantryStep;
    if (marginMm === undefined || marginMm === null)
      marginMm = Math.min(120.0, 3 * Math.max(Math.max(...model.ef_sigmas), model.econt_sigma_mm, model.primary_sigma_mm) + 5);
    const [x1, x2, y1, y2] = beamExtent(beam);
    let xg = M.arange(Math.floor((x1 - marginMm) / resMm) * resMm, x2 + marginMm + resMm, resMm);
    let yg = M.arange(Math.floor((y1 - marginMm) / resMm) * resMm, y2 + marginMm + resMm, resMm);
    xg = xg.map(v => v + 0.5 * resMm);
    yg = yg.map(v => v + 0.5 * resMm);
    const ny = yg.length, nx = xg.length;
    let rows = null, tg = null, tm = 0.0, dlg = 0.0;
    if (beam.leaf_boundaries) {
      const mp = model.mlcForBeam(beam)[1];
      tm = mp.transmission; dlg = mp.dlg_mm;
      const lb = beam.leaf_boundaries;
      rows = new Int32Array(ny);
      for (let j = 0; j < ny; j++) {
        rows[j] = M.searchsorted(lb, yg[j]) - 1;
        if (yg[j] < lb[0] || yg[j] > lb[lb.length - 1]) rows[j] = -1;
      }
      if (mp.tg_width_mm > 0) tg = M.tgRows(yg, resMm, lb, rows, mp.tg_width_mm);
    }
    let cps = beam.cps;
    if (cps.length === 1) cps = [cps[0], cps[0]];
    const ctx = { beam, model, cps, xg, yg, ny, nx, resMm, axes: [xg[0], resMm, yg[0], resMm], rows, tg, tm, dlg,
                  tj: model.jaw_transmission, radial: {}, specs: [] };
    if (!beam.is_arc) {
      const cp = cps[0];
      ctx.specs.push({ static: true, gantry: cp.gantry, coll: cp.coll, couch: cp.couch });
      return ctx;
    }
    for (let i = 0; i < cps.length - 1; i++) {
      const cpa = cps[i], cpb = cps[i + 1];
      const dmu = (cpb.cmw - cpa.cmw) * beam.mu;
      if (dmu <= 0) continue;
      const dg = M.pymod(cpb.gantry - cpa.gantry + 180.0, 360.0) - 180.0;
      const n = Math.max(1, Math.ceil(Math.abs(dg) / maxGantryStep));
      for (let s = 0; s < n; s++) {
        const t0 = s / n, t1 = (s + 1) / n;
        const tm_ = 0.5 * (t0 + t1);
        ctx.specs.push({ static: false, i, t0, t1, dmu, gantry: M.pymod(cpa.gantry + dg * tm_, 360.0),
                         coll: cpa.coll + (cpb.coll - cpa.coll) * tm_,
                         couch: cpa.couch + (cpb.couch - cpa.couch) * tm_ });
      }
    }
    return ctx;
  };
  function mbs(model, cpa, cpb) {
    if (model.monitor_backscatter_k === 0) return 1.0;
    const sx = 0.5 * ((cpa.x2 - cpa.x1) + (cpb.x2 - cpb.x1));
    const sy = 0.5 * ((cpa.y2 - cpa.y1) + (cpb.y2 - cpb.y1));
    return 1.0 / (1.0 + model.monitor_backscatter_k * (Math.sqrt(Math.max(sx * sy, 1.0)) / 100.0 - 1.0));
  }
  function aperture(ctx, cpa, cpb, t0, t1, dmu) {
    const ap = M.apertureFast(cpa, cpb, t0, t1, ctx.xg, ctx.yg, ctx.rows, ctx.dlg, ctx.tg, ctx.tm, ctx.tj);
    const f = dmu * mbs(ctx.model, cpa, cpb);
    for (let p = 0; p < ap.length; p++) ap[p] = f * ap[p];
    return ap;
  }
  // Fluencia de una incidencia (SubBeam)
  M.subbeamFluence = function (ctx, spec) {
    const { beam, model, cps, ny, nx } = ctx;
    const pp = beam.patient_position;
    if (spec.static) {
      const A = new Float64Array(ny * nx);
      let muTot = 0.0;
      for (let i = 0; i < cps.length - 1; i++) {
        const dmu = (cps[i + 1].cmw - cps[i].cmw) * beam.mu;
        if (dmu <= 0) continue;
        const ap = aperture(ctx, cps[i], cps[i + 1], 0.0, 1.0, dmu);
        for (let p = 0; p < A.length; p++) A[p] += ap[p];
        muTot += dmu;
      }
      const [psi, e] = applyModel(A, ny, nx, model, ctx.xg, ctx.yg, ctx.resMm, ctx.radial);
      const cp = cps[0];
      const geom = new M.BeamGeometry(cp.iso, beam.sad, cp.gantry, cp.coll, cp.couch, pp);
      return { geom, fluence: psi, efluence: e, fshape: [ny, nx], axes: ctx.axes, mu: muTot,
               beam_number: beam.number, gantry: cp.gantry };
    }
    const cpa = cps[spec.i], cpb = cps[spec.i + 1];
    const A = aperture(ctx, cpa, cpb, spec.t0, spec.t1, spec.dmu);
    const [psi, e] = applyModel(A, ny, nx, model, ctx.xg, ctx.yg, ctx.resMm, ctx.radial);
    const geom = new M.BeamGeometry(cpa.iso, beam.sad, spec.gantry, spec.coll, spec.couch, pp);
    return { geom, fluence: psi, efluence: e, fshape: [ny, nx], axes: ctx.axes, mu: spec.dmu * (spec.t1 - spec.t0),
             beam_number: beam.number, gantry: spec.gantry };
  };
  // Todas las incidencias de un haz (fluence.subbeams)
  M.subbeams = function (beam, model, resMm, maxGantryStep, marginMm) {
    const ctx = M.subbeamPlan(beam, model, resMm, maxGantryStep, marginMm);
    return ctx.specs.map(sp => M.subbeamFluence(ctx, sp));
  };

  // (gantry, colimador, mesa) de cada incidencia sin calcular la fluencia
  M.subbeamAngles = function (beam, maxGantryStep) {
    maxGantryStep = maxGantryStep === undefined ? 2.0 : maxGantryStep;
    let cps = beam.cps;
    if (cps.length === 1) cps = [cps[0], cps[0]];
    if (!beam.is_arc) { const cp = cps[0]; return [[cp.gantry, cp.coll, cp.couch]]; }
    const out = [];
    for (let i = 0; i < cps.length - 1; i++) {
      const cpa = cps[i], cpb = cps[i + 1];
      if ((cpb.cmw - cpa.cmw) * beam.mu <= 0) continue;
      const dg = M.pymod(cpb.gantry - cpa.gantry + 180.0, 360.0) - 180.0;
      const n = Math.max(1, Math.ceil(Math.abs(dg) / maxGantryStep));
      for (let s = 0; s < n; s++) {
        const tm_ = (s + 0.5) / n;
        out.push([M.pymod(cpa.gantry + dg * tm_, 360.0), cpa.coll + (cpb.coll - cpa.coll) * tm_,
                  cpa.couch + (cpb.couch - cpa.couch) * tm_]);
      }
    }
    return out;
  };
});
