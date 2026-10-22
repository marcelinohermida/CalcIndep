/* CalcIndep web · TERMA polienergético con trazado de rayos divergentes (terma.py). */
CI_MOTOR_MODULOS.push(function CIMod_terma(M) {
  "use strict";

  // _trilinear2 de ccc.py para un solo array: fuera de la caja de vóxeles 0;
  // en el último medio vóxel, el valor del borde.
  function tri(A, nz, ny, nx, fz, fy, fx) {
    if (fx < -0.5 || fy < -0.5 || fz < -0.5 || fx > nx - 0.5 || fy > ny - 0.5 || fz > nz - 0.5) return 0.0;
    fx = Math.min(Math.max(fx, 0.0), nx - 1.0);
    fy = Math.min(Math.max(fy, 0.0), ny - 1.0);
    fz = Math.min(Math.max(fz, 0.0), nz - 1.0);
    let i0 = Math.trunc(fx), j0 = Math.trunc(fy), k0 = Math.trunc(fz);
    if (i0 >= nx - 1) i0 = nx > 1 ? nx - 2 : 0;
    if (j0 >= ny - 1) j0 = ny > 1 ? ny - 2 : 0;
    if (k0 >= nz - 1) k0 = nz > 1 ? nz - 2 : 0;
    const tx = fx - i0, ty = fy - j0, tz = fz - k0;
    const i1 = Math.min(i0 + 1, nx - 1), j1 = Math.min(j0 + 1, ny - 1), k1 = Math.min(k0 + 1, nz - 1);
    const w000 = (1 - tz) * (1 - ty) * (1 - tx), w001 = (1 - tz) * (1 - ty) * tx;
    const w010 = (1 - tz) * ty * (1 - tx), w011 = (1 - tz) * ty * tx;
    const w100 = tz * (1 - ty) * (1 - tx), w101 = tz * (1 - ty) * tx;
    const w110 = tz * ty * (1 - tx), w111 = tz * ty * tx;
    const s1 = nx, s2 = nx * ny;
    const b0 = k0 * s2, b1 = k1 * s2, r0 = j0 * s1, r1 = j1 * s1;
    return (w000 * A[b0 + r0 + i0] + w001 * A[b0 + r0 + i1] + w010 * A[b0 + r1 + i0]
      + w011 * A[b0 + r1 + i1] + w100 * A[b1 + r0 + i0] + w101 * A[b1 + r0 + i1]
      + w110 * A[b1 + r1 + i0] + w111 * A[b1 + r1 + i1]);
  }
  M.tri = tri;

  function bilin(img, ny, nx, x0, dx, y0, dy, x, y) {
    const fx = (x - x0) / dx, fy = (y - y0) / dy;
    if (fx < 0 || fy < 0 || fx > nx - 1 || fy > ny - 1) return 0.0;
    const i0 = Math.min(Math.trunc(fx), nx - 2), j0 = Math.min(Math.trunc(fy), ny - 2);
    const tx = fx - i0, ty = fy - j0;
    const r0 = j0 * nx, r1 = r0 + nx;
    return ((1 - tx) * (1 - ty) * img[r0 + i0] + tx * (1 - ty) * img[r0 + i0 + 1]
      + (1 - tx) * ty * img[r1 + i0] + tx * ty * img[r1 + i0 + 1]);
  }

  // Profundidad radiológica acumulada a lo largo de cada rayo: cum (nrx, nry, nk)
  function rayCumulative(rho, rshape, sp, org, src, u, v, ax, sad, xr, yr, z0, hz, nk) {
    const nrx = xr.length, nry = yr.length;
    const [nz, ny, nx] = rshape;
    const out = new Float64Array(nrx * nry * nk);
    for (let ix = 0; ix < nrx; ix++) {
      for (let iy = 0; iy < nry; iy++) {
        const qx = (xr[ix] * u[0] + yr[iy] * v[0] + sad * ax[0]) / sad;
        const qy = (xr[ix] * u[1] + yr[iy] * v[1] + sad * ax[1]) / sad;
        const qz = (xr[ix] * u[2] + yr[iy] * v[2] + sad * ax[2]) / sad;
        const L = Math.sqrt(qx * qx + qy * qy + qz * qz);
        let cum = 0.0;
        const base = (ix * nry + iy) * nk;
        out[base] = 0.0;
        for (let k = 1; k < nk; k++) {
          const zm = z0 + (k - 0.5) * hz;
          const px = src[0] + zm * qx, py = src[1] + zm * qy, pz = src[2] + zm * qz;
          const r = tri(rho, nz, ny, nx, (pz - org[2]) / sp[2], (py - org[1]) / sp[1], (px - org[0]) / sp[0]);
          cum += r * hz * L * 0.1;
          out[base + k] = cum;
        }
      }
    }
    return out;
  }

  // TERMA (T) y contaminación electrónica (De) de una incidencia.
  // p: {rho, grid, rho_t, grid_t, geom, fluence, fshape, axes, efluence, energies, weights, mu,
  //     softening, softening_rmax_cm, softening_power, ke, ray_spacing_mm, step_mm}
  // Si se indican kRange = [k0, k1] solo se calculan esos cortes (para repartir el trabajo).
  M.computeTerma = function (p, kRange) {
    const grid = p.grid;
    const sp = grid.spacing, org = grid.origin;
    const geom = p.geom;
    const src = geom.source, u = geom.u, v = geom.v, ax = geom.axis;
    const sad = +geom.sad;
    const [x0, dx, y0, dy] = p.axes;
    const [fny, fnx] = p.fshape;
    const flu = p.fluence;
    const efl = p.efluence || new Float64Array(flu.length);
    const [gnz, gny, gnx] = grid.shape;
    const k0r = kRange ? kRange[0] : 0, k1r = kRange ? kRange[1] : gnz;
    const n = (k1r - k0r) * gny * gnx;   // con kRange solo se devuelven esos cortes
    const T = new Float64Array(n), De = new Float64Array(n);
    let tmax = -Infinity;
    for (let q = 0; q < flu.length; q++) { const t = flu[q] + efl[q]; if (t > tmax) tmax = t; }
    const thr = tmax * 1e-5;
    let imin = Infinity, imax = -Infinity, jmin = Infinity, jmax = -Infinity;
    for (let j = 0; j < fny; j++) for (let i = 0; i < fnx; i++) {
      const q = j * fnx + i;
      if (flu[q] + efl[q] > thr) {
        if (i < imin) imin = i; if (i > imax) imax = i; if (j < jmin) jmin = j; if (j > jmax) jmax = j;
      }
    }
    if (imin === Infinity) return { T, De };
    const rs = +(p.ray_spacing_mm || Math.min(grid.minSpacing(), 2.5));
    const xa = x0 + dx * imin - rs, xb_ = x0 + dx * imax + rs;
    const ya = y0 + dy * jmin - rs, yb_ = y0 + dy * jmax + rs;
    const xr = M.arange(xa, xb_ + rs, rs), yr = M.arange(ya, yb_ + rs, rs);
    const rhoT = p.rho_t || p.rho, gridT = p.grid_t || grid;
    let zmin = Infinity, zmax = -Infinity;
    for (const gg of [grid, gridT]) {
      const e = gg.extent();
      for (const xc of [e[0], e[1]]) for (const yc of [e[2], e[3]]) for (const zc of [e[4], e[5]]) {
        const z = (xc - src[0]) * ax[0] + (yc - src[1]) * ax[1] + (zc - src[2]) * ax[2];
        if (z < zmin) zmin = z; if (z > zmax) zmax = z;
      }
    }
    const spMax = grid.maxSpacing();
    const z0 = Math.max(1.0, zmin - 2 * spMax);
    const z1 = zmax + 2 * spMax;
    const hz = +(p.step_mm || 0.5 * grid.minSpacing());
    const nk = Math.ceil((z1 - z0) / hz) + 1;
    const cum = rayCumulative(rhoT, gridT.shape, gridT.spacing, gridT.origin, src, u, v, ax, sad, xr, yr, z0, hz, nk);
    const e = p.energies, w = p.weights;
    const nE = e.length;
    const psiE = new Float64Array(nE);
    for (let q = 0; q < nE; q++) psiE[q] = w[q] * e[q];
    const s = M.npsum(psiE);
    for (let q = 0; q < nE; q++) psiE[q] = psiE[q] / s;
    const muE = p.mu;
    const soft = +p.softening, softRmax = +p.softening_rmax_cm, softPow = +p.softening_power, ke = +p.ke;
    const [nz, ny, nx] = grid.shape;
    const nrx = xr.length, nry = yr.length;
    const xr0 = xr[0], yr0 = yr[0];
    const k0 = kRange ? kRange[0] : 0, k1 = kRange ? kRange[1] : nz;
    const mE = new Float64Array(nE);
    for (let k = k0; k < k1; k++) {
      const pz = org[2] + k * sp[2];
      for (let j = 0; j < ny; j++) {
        const py = org[1] + j * sp[1];
        for (let i = 0; i < nx; i++) {
          const px = org[0] + i * sp[0];
          const rx = px - src[0], ry = py - src[1], rz = pz - src[2];
          const z = rx * ax[0] + ry * ax[1] + rz * ax[2];
          if (z <= 1.0) continue;
          const xb = (rx * u[0] + ry * u[1] + rz * u[2]) * sad / z;
          const yb = (rx * v[0] + ry * v[1] + rz * v[2]) * sad / z;
          const psi = bilin(flu, fny, fnx, x0, dx, y0, dy, xb, yb);
          const pe = bilin(efl, fny, fnx, x0, dx, y0, dy, xb, yb);
          if (psi <= 0.0 && pe <= 0.0) continue;
          const fxr = (xb - xr0) / rs, fyr = (yb - yr0) / rs, fz = (z - z0) / hz;
          if (fxr < 0 || fyr < 0 || fz < 0 || fxr > nrx - 1 || fyr > nry - 1 || fz > nk - 1) continue;
          const d = tri(cum, nrx, nry, nk, fxr, fyr, fz);
          const isq = (sad / z) * (sad / z);
          let rcm = Math.sqrt(xb * xb + yb * yb) * 0.1;
          if (rcm > softRmax) rcm = softRmax;
          let sf;
          if (softPow === 1.0) sf = 1.0 + soft * rcm;
          else if (softPow === 2.0) sf = 1.0 + soft * rcm * rcm;
          else sf = 1.0 + soft * Math.pow(rcm, softPow);
          let t = 0.0;
          for (let q = 0; q < nE; q++) {
            const m = muE[q] * sf;
            t += psiE[q] * m * Math.exp(-m * d);
          }
          const idx = ((k - k0) * ny + j) * nx + i;
          T[idx] = psi * isq * t;
          De[idx] = pe * isq * Math.exp(-ke * d);
        }
      }
    }
    return { T, De };
  };
});
