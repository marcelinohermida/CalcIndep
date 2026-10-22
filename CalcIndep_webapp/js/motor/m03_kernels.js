/* CalcIndep web · kernels de deposición de energía y conos (kernels.py). */
CI_MOTOR_MODULOS.push(function CIMod_kernels(M) {
  "use strict";
  M.DEFAULT_BAND_EDGES = [0.0, 3.75, 11.25, 18.75, 30.0, 45.0, 60.0, 75.0, 90.0, 105.0, 120.0, 135.0, 157.5, 180.0];
  M.DEFAULT_N_PHI = [1, 6, 8, 10, 10, 10, 10, 10, 8, 8, 6, 6, 1];

  function b64ToF64(s) {
    let bin;
    if (typeof atob === "function") bin = atob(s);
    else bin = Buffer.from(s, "base64").toString("binary");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float64Array(bytes.buffer);
  }
  M.b64ToF64 = b64ToF64;
  // EDK: {energies, angle_edges, radius_edges, total (Float64Array nE*48*24), shape}
  M.loadEDK = function (datos) {
    const d = datos.edk;
    return {
      energies: Float64Array.from(d.energies), angle_edges: Float64Array.from(d.angle_edges),
      radius_edges: Float64Array.from(d.radius_edges),
      total: d.total instanceof Float64Array ? d.total : b64ToF64(d.total_b64), shape: d.shape.slice(),
    };
  };

  M.termaWeights = function (energies, w, depthCm) {
    const mu = M.muRhoWater(energies);
    const t = new Float64Array(energies.length);
    for (let i = 0; i < t.length; i++) t[i] = w[i] * energies[i] * mu[i] * Math.exp(-mu[i] * depthCm);
    const s = M.npsum(t);
    return s > 0 ? t.map(v => v / s) : t;
  };
  // Kernel polienergético (48 x 24) ponderado por TERMA
  M.polyenergeticKernel = function (edk, energies, weights, depthCm) {
    const [nE, nA, nR] = edk.shape;
    const idx = Array.from(energies, e => M.argminAbs(edk.energies, e));
    const tw = M.termaWeights(energies, weights, depthCm === undefined ? 10.0 : depthCm);
    const k = new Float64Array(nA * nR);
    for (let q = 0; q < idx.length; q++) {
      const off = idx[q] * nA * nR, w = tw[q];
      for (let p = 0; p < nA * nR; p++) k[p] += w * edk.total[off + p];
    }
    return k;
  };
  function geomspace(a, b, n) {
    if (n === 1) return [a];
    const la = Math.log10(a), lb = Math.log10(b);
    const ls = M.linspace(la, lb, n);
    const out = Array.from(ls, v => Math.pow(10, v));
    out[0] = a; out[n - 1] = b;
    return out;
  }
  // Ajuste K(r) = sum c_j (1 - exp(-a_j r)); devuelve [A = c a, a]
  M.fitExponentials = function (rEdges, kCum, nComp) {
    nComp = nComp || 2;
    const r = rEdges.slice(1);
    const k = kCum;
    const kmax = Math.max(M.max(k), 1e-30);
    if (kmax <= 1e-12) return [new Float64Array(nComp), new Float64Array(nComp).fill(1)];
    const a0 = geomspace(8.0, 0.08, nComp);
    const p0 = new Float64Array(2 * nComp);
    for (let j = 0; j < nComp; j++) { p0[j] = Math.log(kmax / nComp); p0[nComp + j] = Math.log(a0[j]); }
    const wts = Float64Array.from(k, v => 1.0 / (v + 0.02 * kmax));
    const nr = r.length;
    function resid(p) {
      const c = new Float64Array(nComp), a = new Float64Array(nComp);
      for (let j = 0; j < nComp; j++) { c[j] = Math.exp(p[j]); a[j] = Math.exp(p[nComp + j]); }
      const out = new Float64Array(nr);
      for (let i = 0; i < nr; i++) {
        let s = 0.0;
        for (let j = 0; j < nComp; j++) s += c[j] * (1.0 - Math.exp(-(r[i] * a[j])));
        out[i] = (s - k[i]) * wts[i];
      }
      return out;
    }
    const sol = M.leastSquaresTRF(resid, p0, { max_nfev: 4000 });
    const c = [], a = [];
    for (let j = 0; j < nComp; j++) { c.push(Math.exp(sol.x[j])); a.push(Math.exp(sol.x[nComp + j])); }
    const order = M.argsort(a.map(v => -v));
    const A = new Float64Array(nComp), aa = new Float64Array(nComp);
    order.forEach((o, j) => { A[j] = c[o] * a[o]; aa[j] = a[o]; });
    return [A, aa];
  };

  // Conjunto de direcciones: {directions (n x 3), A (n x ncomp), a (n x ncomp), band, ...}
  M.buildConeSet = function (kernel, angleEdges, radiusEdges, bandEdges, nPhi, nComp) {
    bandEdges = bandEdges || M.DEFAULT_BAND_EDGES;
    nPhi = nPhi || M.DEFAULT_N_PHI;
    nComp = nComp || 2;
    if (nPhi.length !== bandEdges.length - 1) throw new Error("n_phi debe tener una entrada por banda");
    const nA = angleEdges.length - 1, nR = radiusEdges.length - 1;
    const dirs = [], As = [], as_ = [], bands = [], fracs = [], errs = [];
    let phase = 0.0;
    for (let b = 0; b < bandEdges.length - 1; b++) {
      const lo = bandEdges[b], hi = bandEdges[b + 1];
      const sel = [];
      for (let q = 0; q < nA; q++) if (angleEdges[q] >= lo - 1e-6 && angleEdges[q + 1] <= hi + 1e-6) sel.push(q);
      if (!sel.length) throw new Error(`La banda ${lo}-${hi} no contiene conos EDK`);
      const kb = new Float64Array(nR);
      for (let r = 0; r < nR; r++) {
        let s = kernel[sel[0] * nR + r];
        for (let t = 1; t < sel.length; t++) s += kernel[sel[t] * nR + r];
        kb[r] = s;
      }
      const kcum = new Float64Array(nR);
      let acc = 0;
      for (let r = 0; r < nR; r++) { acc += kb[r]; kcum[r] = acc; }
      const [A, a] = M.fitExponentials(radiusEdges, kcum, nComp);
      let maxRel = 0;
      const denom = Math.max(kcum[nR - 1], 1e-30);
      for (let r = 0; r < nR; r++) {
        let s = 0.0;
        for (let j = 0; j < nComp; j++) s += (A[j] / a[j]) * (1 - Math.exp(-(radiusEdges[r + 1] * a[j])));
        maxRel = Math.max(maxRel, Math.abs(s - kcum[r]) / denom);
      }
      errs.push(maxRel);
      fracs.push(kcum[nR - 1]);
      const centers = new Float64Array(sel.length), wsum = new Float64Array(sel.length);
      for (let t = 0; t < sel.length; t++) {
        centers[t] = 0.5 * (angleEdges[sel[t]] + angleEdges[sel[t] + 1]);
        wsum[t] = M.npsum(kernel.subarray(sel[t] * nR, sel[t] * nR + nR));
      }
      let theta;
      if (lo === 0.0) theta = 0.0;
      else if (hi >= 180.0 - 1e-6) theta = 180.0;
      else theta = M.npsum(centers.map((c, t) => c * wsum[t])) / Math.max(M.npsum(wsum), 1e-30);
      let npb = nPhi[b];
      if (theta === 0.0 || theta === 180.0) npb = 1;
      const th = M.deg2rad(theta);
      for (let j = 0; j < npb; j++) {
        const ph = 2 * Math.PI * (j + phase) / npb;
        dirs.push([Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)]);
        As.push(Array.from(A, v => v / npb));
        as_.push(Array.from(a));
        bands.push(b);
      }
      phase = 0.5 - phase;
    }
    return { directions: dirs, A: As, a: as_, band: bands, band_edges: Array.from(bandEdges),
             band_fraction: fracs, fit_rel_error: errs, n: dirs.length, ncomp: nComp };
  };

  class ConeCache {
    constructor(edk) { this.edk = edk; this._c = new Map(); }
    get(model) {
      const key = JSON.stringify([Array.from(model.weights, v => M.npRound(v, 6)), model.kernel_weight_depth_cm,
                                  model.kernel_components]);
      if (!this._c.has(key)) {
        const k = M.polyenergeticKernel(this.edk, model.energies, model.weights, model.kernel_weight_depth_cm);
        this._c.set(key, M.buildConeSet(k, this.edk.angle_edges, this.edk.radius_edges, null, null,
                                         model.kernel_components));
      }
      return this._c.get(key);
    }
  }
  M.ConeCache = ConeCache;
});
