/* CalcIndep web · superposición collapsed cone (ccc.py). */
CI_MOTOR_MODULOS.push(function CIMod_ccc(M) {
  "use strict";

  function slab(bx, by, bz, d, lo, hi, out) {
    let smin = -1e30, smax = 1e30;
    const b = [bx, by, bz];
    for (let a = 0; a < 3; a++) {
      const dd = d[a];
      if (Math.abs(dd) < 1e-12) {
        if (b[a] < lo[a] || b[a] > hi[a]) { out[0] = 1e30; out[1] = -1e30; return; }
      } else {
        let t1 = (lo[a] - b[a]) / dd, t2 = (hi[a] - b[a]) / dd;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > smin) smin = t1;
        if (t2 < smax) smax = t2;
      }
    }
    out[0] = smin; out[1] = smax;
  }

  function basis(d0) {
    const n = M.norm3(d0);
    const d = [d0[0] / n, d0[1] / n, d0[2] / n];
    const ref = Math.abs(d[0]) < 0.9 ? [1.0, 0.0, 0.0] : [0.0, 1.0, 0.0];
    let e1 = M.cross3(d, ref);
    const n1 = M.norm3(e1);
    e1 = [e1[0] / n1, e1[1] / n1, e1[2] / n1];
    const e2 = M.cross3(d, e1);
    return [d, e1, e2];
  }
  M.cccBasis = basis;

  // Geometría común de una superposición (ccc.superpose antes del bucle de direcciones).
  // terma: array de TERMA (float64 o float32), shape (nz, ny, nx), sp (cm)
  M.cccPrepare = function (terma, shape, sp, directions, lineSpacingCm, stepCm, marginVox) {
    marginVox = marginVox === undefined ? 2 : marginVox;
    const [nz, ny, nx] = shape;
    const spMin = Math.min(sp[0], sp[1], sp[2]);
    const h = +(lineSpacingCm || spMin);
    const ds = +(stepCm || spMin);
    const m = [marginVox * sp[0], marginVox * sp[1], marginVox * sp[2]];
    const boxLo = [-0.5 * sp[0] - m[0], -0.5 * sp[1] - m[1], -0.5 * sp[2] - m[2]];
    const boxHi = [(nx - 0.5) * sp[0] + m[0], (ny - 0.5) * sp[1] + m[1], (nz - 0.5) * sp[2] + m[2]];
    const corners = [];
    for (const x of [boxLo[0], boxHi[0]]) for (const y of [boxLo[1], boxHi[1]]) for (const z of [boxLo[2], boxHi[2]])
      corners.push([x, y, z]);
    let kmin = Infinity, kmax = -1, jmin = Infinity, jmax = -1, imin = Infinity, imax = -1;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      const base = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++) if (terma[base + i] > 0) {
        if (k < kmin) kmin = k; if (k > kmax) kmax = k; if (j < jmin) jmin = j; if (j > jmax) jmax = j;
        if (i < imin) imin = i; if (i > imax) imax = i;
      }
    }
    if (kmax < 0) return null;
    const tLo = [(imin - 1.0) * sp[0], (jmin - 1.0) * sp[1], (kmin - 1.0) * sp[2]];
    const tHi = [(imax + 1.0) * sp[0], (jmax + 1.0) * sp[1], (kmax + 1.0) * sp[2]];
    const geo = directions.map(dir => {
      const [d, e1, e2] = basis(dir);
      let pu0 = Infinity, pu1 = -Infinity, pv0 = Infinity, pv1 = -Infinity, ps0 = Infinity, ps1 = -Infinity;
      for (const c of corners) {
        const pu = M.dot3(c, e1), pv = M.dot3(c, e2), ps = M.dot3(c, d);
        if (pu < pu0) pu0 = pu; if (pu > pu1) pu1 = pu;
        if (pv < pv0) pv0 = pv; if (pv > pv1) pv1 = pv;
        if (ps < ps0) ps0 = ps; if (ps > ps1) ps1 = ps;
      }
      const nu = Math.ceil((pu1 - pu0) / h) + 1, nv = Math.ceil((pv1 - pv0) / h) + 1, ns = Math.ceil((ps1 - ps0) / ds) + 1;
      return { d, e1, e2, u0: pu0, v0: pv0, s0: ps0, nu, nv, ns };
    });
    return { shape: shape.slice(), sp: Array.from(sp), h, ds, boxLo, boxHi, tLo, tHi, geo };
  };

  // Barrido de una dirección: red lat (nu, nv, ns) en float32
  function sweep(T, R, shape, sp, g, h, ds, A, a, boxLo, boxHi, tLo, tHi, lat, F) {
    const nz = shape[0], ny = shape[1], nx = shape[2];
    const d = g.d, e1 = g.e1, e2 = g.e2, u0 = g.u0, v0 = g.v0, s0 = g.s0, nu = g.nu, nv = g.nv, ns = g.ns;
    const dx = d[0], dy = d[1], dz = d[2];
    const e1x = e1[0], e1y = e1[1], e1z = e1[2], e2x = e2[0], e2y = e2[1], e2z = e2[2];
    const spx = sp[0], spy = sp[1], spz = sp[2];
    const ncomp = A.length;
    const A0 = A[0], a0 = a[0], A1 = ncomp > 1 ? A[1] : 0, a1 = ncomp > 1 ? a[1] : 1;
    const sl = [0, 0], tl = [0, 0];
    const s1 = nx, s2 = nx * ny;
    const nxm = nx - 0.5, nym = ny - 0.5, nzm = nz - 0.5;
    const nx1 = nx - 1.0, ny1 = ny - 1.0, nz1 = nz - 1.0;
    for (let iu = 0; iu < nu; iu++) {
      for (let iv = 0; iv < nv; iv++) {
        const lbase = (iu * nv + iv) * ns;
        const bu = u0 + iu * h, bv = v0 + iv * h;
        const bx = bu * e1x + bv * e2x, by = bu * e1y + bv * e2y, bz = bu * e1z + bv * e2z;
        slab(bx, by, bz, d, boxLo, boxHi, sl);
        let smin = sl[0];
        const smax = sl[1];
        if (smax <= smin) { lat.fill(0, lbase, lbase + ns); continue; }
        slab(bx, by, bz, d, tLo, tHi, tl);
        if (tl[1] <= tl[0]) { lat.fill(0, lbase, lbase + ns); continue; }
        if (tl[0] > smin) smin = tl[0];
        let kIn = Math.floor((smin - s0) / ds), kOut = Math.ceil((smax - s0) / ds);
        if (kIn < 0) kIn = 0;
        if (kOut > ns) kOut = ns;
        if (kOut < kIn) kOut = kIn;
        if (kIn > 0) lat.fill(0, lbase, lbase + kIn);
        if (kOut < ns) lat.fill(0, lbase + kOut, lbase + ns);
        let F0 = 0.0, F1 = 0.0;
        for (let j = 0; j < ncomp; j++) F[j] = 0.0;
        for (let k = kIn; k < kOut; k++) {
          const s = s0 + (k + 0.5) * ds;
          const px = bx + s * dx, py = by + s * dy, pz = bz + s * dz;
          let fx = px / spx, fy = py / spy, fz = pz / spz;
          let t = 0.0, r = 0.0;
          if (!(fx < -0.5 || fy < -0.5 || fz < -0.5 || fx > nxm || fy > nym || fz > nzm)) {
            fx = fx < 0.0 ? 0.0 : (fx > nx1 ? nx1 : fx);
            fy = fy < 0.0 ? 0.0 : (fy > ny1 ? ny1 : fy);
            fz = fz < 0.0 ? 0.0 : (fz > nz1 ? nz1 : fz);
            let i0 = fx | 0, j0 = fy | 0, k0 = fz | 0;
            if (i0 >= nx - 1) i0 = nx > 1 ? nx - 2 : 0;
            if (j0 >= ny - 1) j0 = ny > 1 ? ny - 2 : 0;
            if (k0 >= nz - 1) k0 = nz > 1 ? nz - 2 : 0;
            const tx = fx - i0, ty = fy - j0, tz = fz - k0;
            const i1 = i0 + 1 < nx ? i0 + 1 : nx - 1, j1 = j0 + 1 < ny ? j0 + 1 : ny - 1, k1 = k0 + 1 < nz ? k0 + 1 : nz - 1;
            const w000 = (1 - tz) * (1 - ty) * (1 - tx), w001 = (1 - tz) * (1 - ty) * tx;
            const w010 = (1 - tz) * ty * (1 - tx), w011 = (1 - tz) * ty * tx;
            const w100 = tz * (1 - ty) * (1 - tx), w101 = tz * (1 - ty) * tx;
            const w110 = tz * ty * (1 - tx), w111 = tz * ty * tx;
            const b00 = k0 * s2 + j0 * s1, b01 = k0 * s2 + j1 * s1, b10 = k1 * s2 + j0 * s1, b11 = k1 * s2 + j1 * s1;
            t = (w000 * T[b00 + i0] + w001 * T[b00 + i1] + w010 * T[b01 + i0] + w011 * T[b01 + i1]
              + w100 * T[b10 + i0] + w101 * T[b10 + i1] + w110 * T[b11 + i0] + w111 * T[b11 + i1]);
            r = (w000 * R[b00 + i0] + w001 * R[b00 + i1] + w010 * R[b01 + i0] + w011 * R[b01 + i1]
              + w100 * R[b10 + i0] + w101 * R[b10 + i1] + w110 * R[b11 + i0] + w111 * R[b11 + i1]);
          }
          const dl = r * ds;
          let dose = 0.0;
          if (ncomp === 2) {
            let x = a0 * dl, e, f1;
            if (x < 1e-5) { e = 1.0 - x; f1 = 1.0 - 0.5 * x; }
            else { e = Math.exp(-x); f1 = (1.0 - e) / x; }
            dose += A0 * (F0 * f1 + (t / a0) * (1.0 - f1));
            F0 = F0 * e + t * (1.0 - e) / a0;
            x = a1 * dl;
            if (x < 1e-5) { e = 1.0 - x; f1 = 1.0 - 0.5 * x; }
            else { e = Math.exp(-x); f1 = (1.0 - e) / x; }
            dose += A1 * (F1 * f1 + (t / a1) * (1.0 - f1));
            F1 = F1 * e + t * (1.0 - e) / a1;
          } else {
            for (let j = 0; j < ncomp; j++) {
              const aj = a[j];
              const x = aj * dl;
              let e, f1;
              if (x < 1e-5) { e = 1.0 - x; f1 = 1.0 - 0.5 * x; }
              else { e = Math.exp(-x); f1 = (1.0 - e) / x; }
              dose += A[j] * (F[j] * f1 + (t / aj) * (1.0 - f1));
              F[j] = F[j] * e + t * (1.0 - e) / aj;
            }
          }
          lat[lbase + k] = dose;
        }
      }
    }
  }

  function gather(lat, shape, sp, g, h, ds, out, mask) {
    const nz = shape[0], ny = shape[1], nx = shape[2];
    const d = g.d, e1 = g.e1, e2 = g.e2, u0 = g.u0, v0 = g.v0, s0 = g.s0, nu = g.nu, nv = g.nv, ns = g.ns;
    const dx = d[0], dy = d[1], dz = d[2];
    const e1x = e1[0], e1y = e1[1], e1z = e1[2], e2x = e2[0], e2y = e2[1], e2z = e2[2];
    const spx = sp[0], spy = sp[1], spz = sp[2];
    const nvns = nv * ns;
    const nu1 = nu - 1, nv1 = nv - 1, ns1 = ns - 1;
    for (let k = 0; k < nz; k++) {
      const pz = k * spz;
      for (let j = 0; j < ny; j++) {
        const py = j * spy;
        const base = (k * ny + j) * nx;
        for (let i = 0; i < nx; i++) {
          if (mask !== null && mask[base + i] === 0) continue;
          const px = i * spx;
          const fu = (px * e1x + py * e1y + pz * e1z - u0) / h;
          const fv = (px * e2x + py * e2y + pz * e2z - v0) / h;
          const fs = (px * dx + py * dy + pz * dz - s0) / ds - 0.5;
          if (fu < 0 || fv < 0 || fs < 0 || fu > nu1 || fv > nv1 || fs > ns1) continue;
          let iu = fu | 0, iv = fv | 0, is = fs | 0;
          if (iu > nu - 2) iu = nu - 2;
          if (iv > nv - 2) iv = nv - 2;
          if (is > ns - 2) is = ns - 2;
          const tu = fu - iu, tv = fv - iv, ts = fs - is;
          const l00 = iu * nvns + iv * ns + is, l01 = l00 + ns, l10 = l00 + nvns, l11 = l10 + ns;
          const val = ((1 - tu) * (1 - tv) * (1 - ts) * lat[l00]
            + (1 - tu) * (1 - tv) * ts * lat[l00 + 1]
            + (1 - tu) * tv * (1 - ts) * lat[l01]
            + (1 - tu) * tv * ts * lat[l01 + 1]
            + tu * (1 - tv) * (1 - ts) * lat[l10]
            + tu * (1 - tv) * ts * lat[l10 + 1]
            + tu * tv * (1 - ts) * lat[l11]
            + tu * tv * ts * lat[l11 + 1]);
          out[base + i] += val;
        }
      }
    }
  }

  // Superposición de un subconjunto de direcciones (índices dirIdx) acumulando en out (Float64Array).
  // T32, R32: Float32Array; mask: Uint8Array o null; A, a: arrays por dirección.
  M.cccRun = function (T32, R32, mask, prep, dirIdx, A, a, out) {
    const { shape, sp, h, ds, boxLo, boxHi, tLo, tHi, geo } = prep;
    let buf = new Float32Array(0);
    const F = new Float64Array(8);
    for (const n of dirIdx) {
      const g = geo[n];
      const need = g.nu * g.nv * g.ns;
      if (buf.length < need) buf = new Float32Array(Math.trunc(1.25 * need));
      const lat = buf.subarray(0, need);
      sweep(T32, R32, shape, sp, g, h, ds, A[n], a[n], boxLo, boxHi, tLo, tHi, lat, F);
      gather(lat, shape, sp, g, h, ds, out, mask || null);
    }
    return out;
  };

  // ccc.superpose completo (un solo hilo)
  M.superpose = function (terma, rho, shape, spacingCm, directions, A, a, mask, lineSpacingCm, stepCm, marginVox) {
    const out = new Float64Array(shape[0] * shape[1] * shape[2]);
    const prep = M.cccPrepare(terma, shape, spacingCm, directions, lineSpacingCm, stepCm, marginVox);
    if (!prep) return out;
    const T32 = terma instanceof Float32Array ? terma : Float32Array.from(terma);
    const R32 = rho instanceof Float32Array ? rho : Float32Array.from(rho);
    M.cccRun(T32, R32, mask || null, prep, directions.map((_, i) => i), A, a, out);
    return out;
  };
  // Coste estimado de cada dirección (para repartirlas entre hilos)
  M.cccCost = prep => prep.geo.map(g => g.nu * g.nv * g.ns);
});
