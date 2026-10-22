/* CalcIndep web · índice gamma 3D (gamma.py) e histogramas dosis-volumen (dvh.py). */
CI_MOTOR_MODULOS.push(function CIMod_gamma(M) {
  "use strict";

  function triNaN(D, nz, ny, nx, fz, fy, fx) {
    if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) return NaN;
    const i0 = nx > 1 ? Math.min(Math.trunc(fx), nx - 2) : 0;
    const j0 = ny > 1 ? Math.min(Math.trunc(fy), ny - 2) : 0;
    const k0 = nz > 1 ? Math.min(Math.trunc(fz), nz - 2) : 0;
    const tx = fx - i0, ty = fy - j0, tz = fz - k0;
    const i1 = nx > 1 ? i0 + 1 : 0, j1 = ny > 1 ? j0 + 1 : 0, k1 = nz > 1 ? k0 + 1 : 0;
    const s1 = nx, s2 = nx * ny;
    const a = k0 * s2, b = k1 * s2, c0 = j0 * s1, c1 = j1 * s1;
    return ((1 - tz) * ((1 - ty) * ((1 - tx) * D[a + c0 + i0] + tx * D[a + c0 + i1])
                        + ty * ((1 - tx) * D[a + c1 + i0] + tx * D[a + c1 + i1]))
            + tz * ((1 - ty) * ((1 - tx) * D[b + c0 + i0] + tx * D[b + c0 + i1])
                    + ty * ((1 - tx) * D[b + c1 + i0] + tx * D[b + c1 + i1])));
  }

  M.gammaOffsets = function (dta, maxGamma, step) {
    const R = dta * maxGamma;
    const n = Math.ceil(R / step);
    const r = [];
    for (let q = -n; q <= n; q++) r.push(q * step);
    const o = [], d2 = [];
    for (const X of r) for (const Y of r) for (const Z of r) {
      const v = X * X + Y * Y + Z * Z;
      if (v <= R * R + 1e-9) { o.push([X, Y, Z]); d2.push(v); }
    }
    const order = M.argsort(d2);
    const offs = new Float64Array(order.length * 3), dd = new Float64Array(order.length);
    order.forEach((q, i) => { offs[3 * i] = o[q][0]; offs[3 * i + 1] = o[q][1]; offs[3 * i + 2] = o[q][2]; dd[i] = d2[q]; });
    return [offs, dd];
  };

  // Gamma de una lista de puntos (pts: Float64Array 3*n, dref: Float64Array n)
  M.gammaPoints = function (pts, dref, De, eShape, eOrg, eSp, offs, d2, dta, ddAbs, local, ddFrac, gcap2, out, p0, p1) {
    const [nz, ny, nx] = eShape;
    const m = d2.length;
    const invDta2 = 1.0 / (dta * dta);
    p0 = p0 || 0; p1 = p1 === undefined ? dref.length : p1;
    for (let p = p0; p < p1; p++) {
      const x = pts[3 * p], y = pts[3 * p + 1], z = pts[3 * p + 2];
      const dr = dref[p];
      let ddv;
      if (local) { ddv = ddFrac * dr; if (ddv <= 0) ddv = 1e-12; }
      else ddv = ddAbs;
      const invDd2 = 1.0 / (ddv * ddv);
      let best = gcap2;
      for (let q = 0; q < m; q++) {
        const dist2 = d2[q] * invDta2;
        if (dist2 >= best) break;
        const fx = (x + offs[3 * q] - eOrg[0]) / eSp[0];
        const fy = (y + offs[3 * q + 1] - eOrg[1]) / eSp[1];
        const fz = (z + offs[3 * q + 2] - eOrg[2]) / eSp[2];
        const de = triNaN(De, nz, ny, nx, fz, fy, fx);
        if (de !== de) continue;
        const g2 = dist2 + (de - dr) * (de - dr) * invDd2;
        if (g2 < best) best = g2;
      }
      out[p] = Math.sqrt(best);
    }
    return out;
  };

  M.GammaSettings = function (o) {
    return Object.assign({ dose_pct: 3.0, dta_mm: 2.0, local: false, threshold_pct: 10.0, normalization: "max",
                           normalization_gy: null, max_gamma: 2.0, interp_fraction: 10, reference: "tps" }, o || {});
  };
  M.describeGamma = function (s) {
    const tipo = s.local ? "local" : "global";
    return `${M.fmtG(s.dose_pct)}%/${M.fmtG(s.dta_mm)} mm, ${tipo}, umbral ${M.fmtG(s.threshold_pct)}%, ` +
      `referencia: ${s.reference === "tps" ? "TPS" : "cálculo independiente"}`;
  };

  // Preparación de la gamma 3D: normalización, puntos y desplazamientos
  M.gammaPrepare = function (ref, refGrid, settings, mask, prescriptionGy) {
    const s = settings;
    let norm;
    if (s.normalization === "max") {
      let mx = -Infinity;
      for (let p = 0; p < ref.length; p++) { const v = (!mask || mask[p]) ? ref[p] : -Infinity; if (v > mx) mx = v; }
      norm = mx;
    } else if (s.normalization === "prescription") {
      if (!prescriptionGy) throw new Error("No hay dosis de prescripción para normalizar la gamma");
      norm = +prescriptionGy;
    } else norm = +s.normalization_gy;
    const thr = s.threshold_pct / 100.0 * norm;
    const [x, y, z] = refGrid.axes();
    const [nz, ny, nx] = refGrid.shape;
    const sel = new Uint8Array(ref.length);
    const idx = [];
    for (let k = 0, p = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, p++)
      if (ref[p] >= thr && (!mask || mask[p])) { sel[p] = 1; idx.push(p); }
    const n = idx.length;
    const pts = new Float64Array(3 * n), dref = new Float64Array(n);
    idx.forEach((p, q) => {
      const i = p % nx, j = Math.floor(p / nx) % ny, k = Math.floor(p / (nx * ny));
      pts[3 * q] = x[i]; pts[3 * q + 1] = y[j]; pts[3 * q + 2] = z[k]; dref[q] = ref[p];
    });
    const [offs, d2] = M.gammaOffsets(s.dta_mm, s.max_gamma, s.dta_mm / s.interp_fraction);
    return { norm, sel, idx: Int32Array.from(idx), pts, dref, offs, d2 };
  };
  M.gammaFinish = function (prep, out, size, settings) {
    const g = new Float64Array(size).fill(NaN);
    prep.idx.forEach((p, q) => { g[p] = out[q]; });
    const res = { gamma: g, evaluated: prep.sel, norm_gy: prep.norm, settings };
    res.stats = M.gammaStats(g, prep.sel);
    return res;
  };
  M.gamma3D = function (ref, refGrid, ev, evGrid, settings, mask, prescriptionGy) {
    const s = settings;
    const prep = M.gammaPrepare(ref, refGrid, s, mask, prescriptionGy);
    const out = new Float64Array(prep.dref.length);
    M.gammaPoints(prep.pts, prep.dref, ev, evGrid.shape, evGrid.origin, evGrid.spacing, prep.offs, prep.d2, +s.dta_mm,
                  s.dose_pct / 100.0 * prep.norm, !!s.local, s.dose_pct / 100.0, s.max_gamma ** 2, out);
    return M.gammaFinish(prep, out, ref.length, s);
  };
  M.gammaStats = function (g, mask) {
    const v = [];
    for (let p = 0; p < g.length; p++) if (mask[p] && isFinite(g[p])) v.push(g[p]);
    if (!v.length) return { n: 0, pass_pct: NaN, mean: NaN, median: NaN, p95: NaN, max: NaN };
    const a = Float64Array.from(v);
    let pass = 0;
    for (const x of a) if (x <= 1.0) pass++;
    const s = M.sortedCopy(a);
    return { n: a.length, pass_pct: 100.0 * (pass / a.length), mean: M.npsum(a) / a.length, median: M.median(a),
             p95: M.percentileSorted(s, 95), max: s[s.length - 1] };
  };
  M.gammaByStructure = function (result, masks) {
    const out = {};
    for (const [name, m] of masks) {
      const em = new Uint8Array(m.length);
      let nv = 0;
      for (let p = 0; p < m.length; p++) { em[p] = result.evaluated[p] & m[p]; nv += m[p]; }
      out[name] = M.gammaStats(result.gamma, em);
      out[name].n_voxels = nv;
    }
    return out;
  };

  // ------------------------------------------------------------------ dvh.py
  M.cumulativeDVH = function (dose, mask, binGy, dmax) {
    binGy = binGy === undefined ? 0.01 : binGy;
    const v = [];
    for (let p = 0; p < dose.length; p++) if (mask[p]) v.push(dose[p]);
    if (!v.length) return [new Float64Array([0.0]), new Float64Array([0.0])];
    const top = (dmax !== undefined && dmax !== null ? +dmax : M.max(v)) * 1.02 + binGy;
    const edges = M.arange(0.0, top + binGy, binGy);
    const h = M.histogram(v, edges);
    const nb = h.length;
    const cum = new Float64Array(nb);
    let acc = 0;
    for (let q = nb - 1; q >= 0; q--) { acc += h[q]; cum[q] = acc / v.length * 100.0; }
    return [edges.subarray(0, nb), cum];
  };
  function doseAtPct(vs, pct) {
    const n = vs.length;
    if (!n) return NaN;
    const idx = Math.min(Math.max(Math.ceil(pct / 100.0 * n) - 1, 0), n - 1);
    return vs[idx];
  }
  function doseAtCC(vs, cc, voxelCC) {
    const n = vs.length;
    if (!n) return NaN;
    const k = Math.min(Math.max(Math.ceil(cc / voxelCC) - 1, 0), n - 1);
    return vs[k];
  }
  M.dvhMetrics = function (dose, mask, voxelCC) {
    const v = [];
    for (let p = 0; p < dose.length; p++) if (mask[p]) v.push(dose[p]);
    if (!v.length) return { volume_cc: 0.0 };
    const s = Float64Array.from(v).sort().reverse();
    return { volume_cc: s.length * voxelCC, Dmean: M.npsum(s) / s.length, "Dmax_0.03cc": doseAtCC(s, 0.03, voxelCC),
             D2: doseAtPct(s, 2), D50: doseAtPct(s, 50), D95: doseAtPct(s, 95), D98: doseAtPct(s, 98),
             Dmin: s[s.length - 1] };
  };
});
