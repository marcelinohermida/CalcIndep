/* CalcIndep web · utilidades numéricas.
 * Réplica de las funciones de NumPy y SciPy que usa CalcIndep, con la misma
 * aritmética cuando es posible (interp, arange, gaussian_filter, map_coordinates,
 * erf/erfc de Cephes, least_squares TRF, nnls, fminbound).
 */
var CI_MOTOR_MODULOS = (typeof CI_MOTOR_MODULOS !== "undefined") ? CI_MOTOR_MODULOS : [];
CI_MOTOR_MODULOS.push(function CIMod_numerico(M) {
  "use strict";
  const EPS = 2.220446049250313e-16;
  M.EPS = EPS;

  // ------------------------------------------------------------------ escalares
  M.pymod = function (a, b) {          // a % b con el signo del divisor (Python)
    const r = a % b;
    return (r !== 0 && (r < 0) !== (b < 0)) ? r + b : r;
  };
  M.rint = function (x) {              // redondeo al par (np.rint)
    if (!isFinite(x)) return x;
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
  };
  M.npRound = function (x, dec) {      // np.round(x, dec)
    if (!dec) return M.rint(x);
    const p = Math.pow(10, dec);
    return M.rint(x * p) / p;
  };
  // round() de Python con decimales (redondeo exacto del valor decimal, empates al par)
  M.pyRound = function (x, nd) {
    if (!isFinite(x)) return x;
    const s = x.toFixed(Math.min(100, nd + 25));
    // toFixed con muchos decimales da la expansión decimal exacta (hasta su límite)
    const neg = s[0] === "-";
    const t = neg ? s.slice(1) : s;
    const [ip, fp] = t.split(".");
    const keep = fp.slice(0, nd), rest = fp.slice(nd);
    let up;
    const first = rest.charCodeAt(0) - 48;
    if (first > 5) up = true;
    else if (first < 5) up = false;
    else {
      const tail = rest.slice(1).replace(/0+$/, "");
      if (tail.length) up = true;
      else {
        const lastDigit = nd > 0 ? keep.charCodeAt(nd - 1) - 48 : ip.charCodeAt(ip.length - 1) - 48;
        up = (lastDigit % 2) === 1;
      }
    }
    let v = parseFloat(ip + (nd > 0 ? "." + keep : ""));
    if (up) v = parseFloat((v + Math.pow(10, -nd)).toFixed(nd));
    return neg ? -v : v;
  };
  M.hypot = function (a, b) { return Math.sqrt(a * a + b * b); };
  M.sign = function (x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); };
  M.clip = function (x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); };
  M.deg2rad = function (d) { return d * (Math.PI / 180.0); };
  M.rad2deg = function (r) { return r * (180.0 / Math.PI); };

  // ------------------------------------------------------------------ vectores 3
  M.dot3 = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
  M.norm3 = function (a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); };
  M.cross3 = function (a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  };
  M.scale3 = function (a, s) { return [a[0] * s, a[1] * s, a[2] * s]; };
  M.add3 = function (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; };
  M.sub3 = function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; };
  // Producto de matrices 3x3 (filas)
  M.matmul3 = function (A, B) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    return C;
  };
  M.matvec3 = function (A, v) {
    return [A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2],
            A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
            A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2]];
  };
  M.transpose3 = function (A) {
    return [[A[0][0], A[1][0], A[2][0]], [A[0][1], A[1][1], A[2][1]], [A[0][2], A[1][2], A[2][2]]];
  };

  // ------------------------------------------------------------------ sumas (NumPy)
  function pairwise(a, off, n) {
    if (n < 8) {
      let res = 0.0;
      for (let i = 0; i < n; i++) res += a[off + i];
      return res;
    } else if (n <= 128) {
      const r = [a[off], a[off + 1], a[off + 2], a[off + 3], a[off + 4], a[off + 5], a[off + 6], a[off + 7]];
      let i;
      const lim = n - (n % 8);
      for (i = 8; i < lim; i += 8) {
        r[0] += a[off + i]; r[1] += a[off + i + 1]; r[2] += a[off + i + 2]; r[3] += a[off + i + 3];
        r[4] += a[off + i + 4]; r[5] += a[off + i + 5]; r[6] += a[off + i + 6]; r[7] += a[off + i + 7];
      }
      let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
      for (; i < n; i++) res += a[off + i];
      return res;
    } else {
      let n2 = Math.floor(n / 2);
      n2 -= n2 % 8;
      return pairwise(a, off, n2) + pairwise(a, off + n2, n - n2);
    }
  }
  // np.sum de un array 1D contiguo de float64
  M.npsum = function (a, off, n) {
    off = off || 0;
    if (n === undefined) n = a.length - off;
    if (n === 0) return 0.0;
    return a[off] + pairwise(a, off + 1, n - 1);
  };
  M.npmean = function (a) { return M.npsum(a) / a.length; };
  M.sumSeq = function (a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
  M.dot = function (a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  M.norm = function (a) { return Math.sqrt(M.dot(a, a)); };
  M.max = function (a) { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };
  M.min = function (a) { let m = Infinity; for (let i = 0; i < a.length; i++) if (a[i] < m) m = a[i]; return m; };
  M.nanmax = function (a) {
    let m = -Infinity, any = false;
    for (let i = 0; i < a.length; i++) { const v = a[i]; if (v === v) { any = true; if (v > m) m = v; } }
    return any ? m : NaN;
  };
  M.argmax = function (a) {   // primer índice del máximo (NaN se ignora salvo que todo sea NaN)
    let m = -Infinity, k = 0;
    for (let i = 0; i < a.length; i++) if (a[i] > m) { m = a[i]; k = i; }
    return k;
  };
  M.nanargmax = M.argmax;
  M.argminAbs = function (arr, v) {
    let best = Infinity, k = 0;
    for (let i = 0; i < arr.length; i++) { const d = Math.abs(arr[i] - v); if (d < best) { best = d; k = i; } }
    return k;
  };

  // ------------------------------------------------------------------ arrays 1D
  // np.arange(start, stop, step) con la misma aritmética que NumPy
  M.arange = function (start, stop, step) {
    if (stop === undefined) { stop = start; start = 0; }
    if (step === undefined) step = 1;
    const next = start + step;
    const delta = next - start;
    let len = Math.ceil((stop - start) / delta);
    if (!(len > 0)) len = 0;
    const out = new Float64Array(len);
    if (len > 0) out[0] = start;
    if (len > 1) out[1] = next;
    for (let i = 2; i < len; i++) out[i] = start + i * delta;
    return out;
  };
  M.linspace = function (a, b, n) {
    const out = new Float64Array(n);
    if (n === 1) { out[0] = a; return out; }
    const div = n - 1;
    const step = (b - a) / div;
    for (let i = 0; i < n; i++) out[i] = a + i * step;
    if (n > 1) out[n - 1] = b;
    return out;
  };
  // np.searchsorted(a, v, side) para a creciente
  M.searchsorted = function (a, v, side) {
    let lo = 0, hi = a.length;
    if (side === "right") {
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (a[mid] <= v) lo = mid + 1; else hi = mid; }
    } else {
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (a[mid] < v) lo = mid + 1; else hi = mid; }
    }
    return lo;
  };
  // np.interp(x, xp, fp, left, right): escalar
  M.interp1 = function (x, xp, fp, left, right) {
    const n = xp.length;
    const lval = (left === undefined) ? fp[0] : left;
    const rval = (right === undefined) ? fp[n - 1] : right;
    if (x !== x) return x;
    if (n === 1) {
      if (x < xp[0]) return lval;
      if (x > xp[0]) return rval;
      return fp[0];
    }
    if (x > xp[n - 1]) return rval;
    if (x < xp[0]) return lval;
    if (x === xp[n - 1]) return fp[n - 1];
    // xp[j] <= x < xp[j+1]
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (xp[mid] <= x) lo = mid; else hi = mid; }
    const j = lo;
    const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
    let r = slope * (x - xp[j]) + fp[j];
    if (r !== r) {
      r = slope * (x - xp[j + 1]) + fp[j + 1];
      if (r !== r && fp[j] === fp[j + 1]) r = fp[j];
    }
    return r;
  };
  M.interp = function (xs, xp, fp, left, right) {
    if (typeof xs === "number") return M.interp1(xs, xp, fp, left, right);
    const out = new Float64Array(xs.length);
    for (let i = 0; i < xs.length; i++) out[i] = M.interp1(xs[i], xp, fp, left, right);
    return out;
  };
  // argsort estable
  M.argsort = function (a, desc) {
    const idx = new Array(a.length);
    for (let i = 0; i < a.length; i++) idx[i] = i;
    if (desc) idx.sort((p, q) => (a[q] - a[p]) || (p - q));
    else idx.sort((p, q) => (a[p] - a[q]) || (p - q));
    return idx;
  };
  M.sortedCopy = function (a) {
    const b = Float64Array.from(a);
    b.sort();
    return b;
  };
  M.uniqueSorted = function (a) {
    const b = M.sortedCopy(a);
    const out = [];
    for (let i = 0; i < b.length; i++) if (i === 0 || b[i] !== b[i - 1]) out.push(b[i]);
    return Float64Array.from(out);
  };
  M.diff = function (a) {
    const out = new Float64Array(Math.max(0, a.length - 1));
    for (let i = 0; i < out.length; i++) out[i] = a[i + 1] - a[i];
    return out;
  };
  // np.median / np.percentile (interpolación lineal)
  M.percentileSorted = function (s, q) {
    const n = s.length;
    if (n === 0) return NaN;
    const pos = (q / 100) * (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, n - 1);
    const g = pos - lo;
    // NumPy (método lineal): a + (b - a) * g, con la variante para g >= 0.5
    const a = s[lo], b = s[hi];
    const d = b - a;
    return (g >= 0.5) ? b - d * (1 - g) : a + d * g;
  };
  M.percentile = function (a, q) { return M.percentileSorted(M.sortedCopy(a), q); };
  M.median = function (a) {
    const s = M.sortedCopy(a);
    const n = s.length;
    if (n === 0) return NaN;
    if (n % 2) return s[(n - 1) / 2];
    return (s[n / 2 - 1] + s[n / 2]) / 2;   // np.median: media de los dos centrales
  };
  // np.histogram con bordes dados (último intervalo cerrado)
  M.histogram = function (vals, edges) {
    const nb = edges.length - 1;
    const h = new Float64Array(nb);
    const first = edges[0], last = edges[nb];
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (!(v >= first && v <= last)) continue;
      let k = M.searchsorted(edges, v, "right") - 1;
      if (k >= nb) k = nb - 1;
      h[k] += 1;
    }
    return h;
  };

  // ------------------------------------------------------------------ erf / erfc (Cephes)
  const P = [2.46196981473530512524E-10, 5.64189564831068821977E-1, 7.46321056442269912687E0,
    4.86371970985681366614E1, 1.96520832956077098242E2, 5.26445194995477358631E2,
    9.34528527171957607540E2, 1.02755188689515710272E3, 5.57535335369399327526E2];
  const Q = [1.32281951154744992508E1, 8.67072140885989742329E1, 3.54937778887819891062E2,
    9.75708501743205489753E2, 1.82390916687909736289E3, 2.24633760818710981792E3,
    1.65666309194161350182E3, 5.57535340817727675546E2];
  const R = [5.64189583547755073984E-1, 1.27536670759978104416E0, 5.01905042251180477414E0,
    6.16021097993053585195E0, 7.40974269950448939160E0, 2.97886665372100240670E0];
  const S = [2.26052863220117276590E0, 9.39603524938001434673E0, 1.20489539808096656605E1,
    1.70814450747565897222E1, 9.60896809063285878198E0, 3.36907645100081516050E0];
  const T = [9.60497373987051638749E0, 9.00260197203842689217E1, 2.23200534594684319226E3,
    7.00332514112805075473E3, 5.55923013010394962768E4];
  const U = [3.35617141647503099647E1, 5.21357949780152679795E2, 4.59432382970980127987E3,
    2.26290000613890934246E4, 4.92673942608635921086E4];
  const MAXLOG = 7.09782712893383996843E2;
  function polevl(x, c, n) { let a = c[0]; for (let i = 1; i <= n; i++) a = a * x + c[i]; return a; }
  function p1evl(x, c, n) { let a = x + c[0]; for (let i = 1; i < n; i++) a = a * x + c[i]; return a; }
  function erf(x) {
    if (x !== x) return x;
    if (x < 0.0) return -erf(-x);
    if (Math.abs(x) > 1.0) return 1.0 - erfc(x);
    const z = x * x;
    return x * polevl(z, T, 4) / p1evl(z, U, 5);
  }
  function erfc(a) {
    if (a !== a) return a;
    const x = a < 0 ? -a : a;
    if (x < 1.0) return 1.0 - erf(a);
    let z = -a * a;
    if (z < -MAXLOG) return a < 0 ? 2.0 : 0.0;
    z = Math.exp(z);
    let p, q;
    if (x < 8.0) { p = polevl(x, P, 8); q = p1evl(x, Q, 8); }
    else { p = polevl(x, R, 5); q = p1evl(x, S, 6); }
    let y = (z * p) / q;
    if (a < 0) y = 2.0 - y;
    if (y === 0.0) return a < 0 ? 2.0 : 0.0;
    return y;
  }
  M.erf = erf;
  M.erfc = erfc;

  // ------------------------------------------------------------------ filtro gaussiano
  function gaussKernel(sigma, radius) {
    const sigma2 = sigma * sigma;
    const n = 2 * radius + 1;
    const phi = new Float64Array(n);
    const c = -0.5 / sigma2;
    for (let i = 0; i < n; i++) { const x = i - radius; phi[i] = Math.exp(c * (x * x)); }
    const s = M.npsum(phi);
    for (let i = 0; i < n; i++) phi[i] = phi[i] / s;
    return phi;
  }
  M.gaussKernel = gaussKernel;
  // correlate1d en modo constante (cval 0) a lo largo de un eje de un array 2D o 3D
  function correlate1dConst(inp, shape, axis, w) {
    const size1 = (w.length - 1) >> 1;
    const out = new Float64Array(inp.length);
    const nd = shape.length;
    const len = shape[axis];
    let stride = 1;
    for (let d = nd - 1; d > axis; d--) stride *= shape[d];
    const total = inp.length;
    const nlines = total / len;
    const line = new Float64Array(len + 2 * size1);
    const fw = w;   // fw[size1 + jj]
    // ¿simétrico?
    let symmetric = 1;
    for (let l = 1; l <= size1; l++) if (Math.abs(fw[size1 + l] - fw[size1 - l]) > EPS) { symmetric = 0; break; }
    for (let ln = 0; ln < nlines; ln++) {
      // base de la línea: índices con el eje "axis" variable
      const outer = Math.floor(ln / stride);
      const inner = ln - outer * stride;
      const base = outer * len * stride + inner;
      for (let i = 0; i < size1; i++) { line[i] = 0.0; line[size1 + len + i] = 0.0; }
      for (let i = 0; i < len; i++) line[size1 + i] = inp[base + i * stride];
      for (let ll = 0; ll < len; ll++) {
        const c = size1 + ll;
        let v;
        if (symmetric) {
          v = line[c] * fw[size1];
          for (let jj = -size1; jj < 0; jj++) v += (line[c + jj] + line[c - jj]) * fw[size1 + jj];
        } else {
          v = line[c - size1] * fw[0];
          for (let jj = -size1 + 1; jj <= size1; jj++) v += line[c + jj] * fw[size1 + jj];
        }
        out[base + ll * stride] = v;
      }
    }
    return out;
  }
  // gaussian_filter(A, sigma, mode="constant", truncate=4): sigma escalar o por eje
  M.gaussianFilter = function (A, shape, sigma) {
    const sig = Array.isArray(sigma) ? sigma : shape.map(() => sigma);
    let cur = A;
    for (let ax = 0; ax < shape.length; ax++) {
      const sd = sig[ax];
      if (!(sd > 1e-15)) continue;
      const lw = Math.trunc(4.0 * sd + 0.5);
      const w = gaussKernel(sd, lw);   // simétrico: [::-1] no cambia nada
      cur = correlate1dConst(cur, shape, ax, w);
    }
    if (cur === A) cur = Float64Array.from(A);
    return cur;
  };

  // ------------------------------------------------------------------ map_coordinates (orden 1)
  // Interpolación trilineal de SciPy (orden 1). mode "constant": fuera de [0, n-1] -> cval;
  // "nearest": se recorta al borde. data: array plano (nz, ny, nx).
  M.mapCoord3 = function (data, shape, fz, fy, fx, mode, cval) {
    const nz = shape[0], ny = shape[1], nx = shape[2];
    if (mode === "nearest") {
      fz = fz < 0 ? 0 : (fz > nz - 1 ? nz - 1 : fz);
      fy = fy < 0 ? 0 : (fy > ny - 1 ? ny - 1 : fy);
      fx = fx < 0 ? 0 : (fx > nx - 1 ? nx - 1 : fx);
    } else if (fz < 0 || fz > nz - 1 || fy < 0 || fy > ny - 1 || fx < 0 || fx > nx - 1 ||
               fz !== fz || fy !== fy || fx !== fx) {
      return cval === undefined ? 0.0 : cval;
    }
    const k0 = Math.floor(fz), j0 = Math.floor(fy), i0 = Math.floor(fx);
    const tz = fz - k0, ty = fy - j0, tx = fx - i0;
    const wz = [1.0 - tz, tz], wy = [1.0 - ty, ty], wx = [1.0 - tx, tx];
    let t = 0.0;
    for (let a = 0; a < 2; a++) {
      let k = k0 + a;
      for (let b = 0; b < 2; b++) {
        let j = j0 + b;
        for (let c = 0; c < 2; c++) {
          let i = i0 + c;
          let coeff;
          if (k >= nz || j >= ny || i >= nx) {
            if (mode === "nearest") {
              coeff = data[(Math.min(k, nz - 1) * ny + Math.min(j, ny - 1)) * nx + Math.min(i, nx - 1)];
            } else coeff = (cval === undefined ? 0.0 : cval);
          } else coeff = data[(k * ny + j) * nx + i];
          coeff *= wz[a];
          coeff *= wy[b];
          coeff *= wx[c];
          t += coeff;
        }
      }
    }
    return t;
  };

  // ------------------------------------------------------------------ SVD (Jacobi de una cara)
  // A: m x n (m >= n), filas. Devuelve {U (m x n), s (n, decreciente), V (n x n)} con A = U diag(s) V^T
  M.svd = function (A) {
    const m = A.length, n = A[0].length;
    const U = A.map(r => Float64Array.from(r));
    const V = [];
    for (let i = 0; i < n; i++) { const r = new Float64Array(n); r[i] = 1; V.push(r); }
    for (let sweep = 0; sweep < 100; sweep++) {
      let off = 0;
      for (let p = 0; p < n - 1; p++) {
        for (let q = p + 1; q < n; q++) {
          let alpha = 0, beta = 0, gamma = 0;
          for (let i = 0; i < m; i++) {
            const up = U[i][p], uq = U[i][q];
            alpha += up * up; beta += uq * uq; gamma += up * uq;
          }
          if (gamma === 0) continue;
          const conv = Math.abs(gamma) / Math.sqrt(alpha * beta);
          if (conv > off) off = conv;
          if (conv < 1e-17) continue;
          const zeta = (beta - alpha) / (2 * gamma);
          const t = M.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
          const c = 1 / Math.sqrt(1 + t * t), s = c * t;
          for (let i = 0; i < m; i++) {
            const up = U[i][p], uq = U[i][q];
            U[i][p] = c * up - s * uq; U[i][q] = s * up + c * uq;
          }
          for (let i = 0; i < n; i++) {
            const vp = V[i][p], vq = V[i][q];
            V[i][p] = c * vp - s * vq; V[i][q] = s * vp + c * vq;
          }
        }
      }
      if (off < 1e-16) break;
    }
    const s = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      let ss = 0;
      for (let i = 0; i < m; i++) ss += U[i][j] * U[i][j];
      s[j] = Math.sqrt(ss);
      if (s[j] > 0) for (let i = 0; i < m; i++) U[i][j] /= s[j];
    }
    const order = M.argsort(s, true);
    const s2 = new Float64Array(n), U2 = [], V2 = [];
    for (let i = 0; i < m; i++) U2.push(new Float64Array(n));
    for (let i = 0; i < n; i++) V2.push(new Float64Array(n));
    order.forEach((o, j) => {
      s2[j] = s[o];
      for (let i = 0; i < m; i++) U2[i][j] = U[i][o];
      for (let i = 0; i < n; i++) V2[i][j] = V[i][o];
    });
    return { U: U2, s: s2, V: V2 };
  };

  // ------------------------------------------------------------------ least_squares (TRF, sin límites)
  // Réplica de scipy.optimize.least_squares(fun, x0, method="trf", jac="2-point",
  // x_scale=1, ftol=xtol=gtol=1e-8, loss="linear", tr_solver="exact").
  M.leastSquaresTRF = function (fun, x0, opts) {
    opts = opts || {};
    const ftol = opts.ftol || 1e-8, xtol = opts.xtol || 1e-8, gtol = opts.gtol || 1e-8;
    const n = x0.length;
    const maxNfev = opts.max_nfev || n * 100;
    const rstep = Math.sqrt(EPS);
    function jac(x, f0) {
      const m = f0.length;
      const J = [];
      for (let i = 0; i < m; i++) J.push(new Float64Array(n));
      for (let k = 0; k < n; k++) {
        const sgn = x[k] >= 0 ? 1 : -1;
        const h = rstep * sgn * Math.max(1.0, Math.abs(x[k]));
        const x1 = Float64Array.from(x);
        x1[k] = x[k] + h;
        const f1 = fun(x1);
        const dx = (x[k] + h) - x[k];
        for (let i = 0; i < m; i++) J[i][k] = (f1[i] - f0[i]) / dx;
      }
      return J;
    }
    function gradOf(J, f) {
      const g = new Float64Array(n);
      for (let k = 0; k < n; k++) { let s = 0; for (let i = 0; i < f.length; i++) s += J[i][k] * f[i]; g[k] = s; }
      return g;
    }
    function solveTR(m, uf, s, V, Delta, initialAlpha) {
      const rtol = 0.01, maxIter = 10;
      const suf = new Float64Array(n);
      for (let i = 0; i < n; i++) suf[i] = s[i] * uf[i];
      let fullRank = false;
      if (m >= n) fullRank = s[n - 1] > EPS * m * s[0];
      function Vdot(vec) {
        const p = new Float64Array(n);
        for (let i = 0; i < n; i++) { let a = 0; for (let j = 0; j < n; j++) a += V[i][j] * vec[j]; p[i] = a; }
        return p;
      }
      if (fullRank) {
        const t = new Float64Array(n);
        for (let i = 0; i < n; i++) t[i] = uf[i] / s[i];
        const p = Vdot(t);
        for (let i = 0; i < n; i++) p[i] = -p[i];
        if (M.norm(p) <= Delta) return { p, alpha: 0.0 };
      }
      function phiDer(alpha) {
        let ss = 0, sd = 0;
        const q = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const den = s[i] * s[i] + alpha;
          q[i] = suf[i] / den;
          sd += suf[i] * suf[i] / (den * den * den);
        }
        const pn = M.norm(q);
        return [pn - Delta, -sd / pn];
      }
      let alphaUpper = M.norm(suf) / Delta;
      let alphaLower = 0.0;
      if (fullRank) { const r = phiDer(0.0); alphaLower = -r[0] / r[1]; }
      let alpha;
      if (initialAlpha === null || initialAlpha === undefined || (!fullRank && initialAlpha === 0))
        alpha = Math.max(0.001 * alphaUpper, Math.sqrt(alphaLower * alphaUpper));
      else alpha = initialAlpha;
      for (let it = 0; it < maxIter; it++) {
        if (alpha < alphaLower || alpha > alphaUpper)
          alpha = Math.max(0.001 * alphaUpper, Math.sqrt(alphaLower * alphaUpper));
        const r = phiDer(alpha);
        const phi = r[0], phiP = r[1];
        if (phi < 0) alphaUpper = alpha;
        const ratio = phi / phiP;
        alphaLower = Math.max(alphaLower, alpha - ratio);
        alpha -= (phi + Delta) * ratio / Delta;
        if (Math.abs(phi) < rtol * Delta) break;
      }
      const t = new Float64Array(n);
      for (let i = 0; i < n; i++) t[i] = suf[i] / (s[i] * s[i] + alpha);
      const p = Vdot(t);
      const pn = M.norm(p);
      for (let i = 0; i < n; i++) p[i] = -p[i] * (Delta / pn);
      return { p, alpha };
    }
    let x = Float64Array.from(x0);
    let f = fun(x);
    let nfev = 1;
    let J = jac(x, f);
    const m = f.length;
    let cost = 0.5 * M.dot(f, f);
    let g = gradOf(J, f);
    let Delta = M.norm(x);
    if (Delta === 0) Delta = 1.0;
    let alpha = 0.0;
    let status = null;
    let fNew = null, costNew = 0, xNew = null;
    for (;;) {
      let gnorm = 0;
      for (let i = 0; i < n; i++) gnorm = Math.max(gnorm, Math.abs(g[i]));
      if (gnorm < gtol) status = 1;
      if (status !== null || nfev === maxNfev) break;
      const sv = M.svd(J);
      const uf = new Float64Array(n);
      for (let k = 0; k < n; k++) { let a = 0; for (let i = 0; i < m; i++) a += sv.U[i][k] * f[i]; uf[k] = a; }
      let actualReduction = -1;
      while (actualReduction <= 0 && nfev < maxNfev) {
        const tr = solveTR(m, uf, sv.s, sv.V, Delta, alpha);
        const stepH = tr.p;
        alpha = tr.alpha;
        // evaluate_quadratic
        let q = 0;
        for (let i = 0; i < m; i++) { let a = 0; for (let k = 0; k < n; k++) a += J[i][k] * stepH[k]; q += a * a; }
        const predicted = -(0.5 * q + M.dot(stepH, g));
        xNew = new Float64Array(n);
        for (let k = 0; k < n; k++) xNew[k] = x[k] + stepH[k];
        fNew = fun(xNew);
        nfev++;
        const stepNorm = M.norm(stepH);
        let finite = true;
        for (let i = 0; i < m; i++) if (!isFinite(fNew[i])) { finite = false; break; }
        if (!finite) { Delta = 0.25 * stepNorm; continue; }
        costNew = 0.5 * M.dot(fNew, fNew);
        actualReduction = cost - costNew;
        let ratio;
        if (predicted > 0) ratio = actualReduction / predicted;
        else if (predicted === actualReduction && actualReduction === 0) ratio = 1;
        else ratio = 0;
        let DeltaNew = Delta;
        if (ratio < 0.25) DeltaNew = 0.25 * stepNorm;
        else if (ratio > 0.75 && stepNorm > 0.95 * Delta) DeltaNew = Delta * 2.0;
        const ftolOk = actualReduction < ftol * cost && ratio > 0.25;
        const xtolOk = stepNorm < xtol * (xtol + M.norm(x));
        if (ftolOk && xtolOk) status = 4;
        else if (ftolOk) status = 2;
        else if (xtolOk) status = 3;
        if (status !== null) break;
        alpha *= Delta / DeltaNew;
        Delta = DeltaNew;
      }
      if (actualReduction > 0) {
        x = xNew; f = fNew; cost = costNew;
        J = jac(x, f);
        g = gradOf(J, f);
      }
    }
    return { x, cost, nfev, status };
  };

  // ------------------------------------------------------------------ NNLS (Lawson-Hanson)
  // A: m filas x n columnas (array de Float64Array), b: m. Devuelve x >= 0.
  M.nnls = function (A, b, maxiter) {
    const m = A.length, n = A[0].length;
    maxiter = maxiter || 3 * n;
    // AtA y Atb
    const AtA = []; for (let i = 0; i < n; i++) AtA.push(new Float64Array(n));
    const Atb = new Float64Array(n);
    for (let r = 0; r < m; r++) {
      const row = A[r];
      for (let i = 0; i < n; i++) {
        const ai = row[i];
        if (ai === 0) continue;
        Atb[i] += ai * b[r];
        for (let j = 0; j < n; j++) AtA[i][j] += ai * row[j];
      }
    }
    const x = new Float64Array(n);
    const P = new Uint8Array(n);
    const w = new Float64Array(n);
    let tol = 10 * Math.max(m, n) * EPS;
    // tolerancia relativa a la norma de A (como SciPy: 10 * max(m,n) * eps * ||A||_1-ish)
    let anorm = 0;
    for (let j = 0; j < n; j++) { let s = 0; for (let r = 0; r < m; r++) s += Math.abs(A[r][j]); anorm = Math.max(anorm, s); }
    tol *= Math.max(anorm, 1);
    function computeW() {
      for (let i = 0; i < n; i++) {
        let s = Atb[i];
        for (let j = 0; j < n; j++) s -= AtA[i][j] * x[j];
        w[i] = s;
      }
    }
    function solveP() {
      const idx = [];
      for (let i = 0; i < n; i++) if (P[i]) idx.push(i);
      const k = idx.length;
      const s = new Float64Array(n);
      if (!k) return s;
      // mínimos cuadrados en las columnas de P con QR (Householder) para estabilidad
      const Ap = [];
      for (let r = 0; r < m; r++) { const row = new Float64Array(k); for (let c = 0; c < k; c++) row[c] = A[r][idx[c]]; Ap.push(row); }
      const sol = M.lstsq(Ap, b);
      for (let c = 0; c < k; c++) s[idx[c]] = sol[c];
      return s;
    }
    computeW();
    let iter = 0;
    for (;;) {
      let jmax = -1, wmax = tol;
      for (let i = 0; i < n; i++) if (!P[i] && w[i] > wmax) { wmax = w[i]; jmax = i; }
      if (jmax < 0) break;
      P[jmax] = 1;
      let s = solveP();
      for (;;) {
        iter++;
        if (iter > maxiter) return x;
        let minS = Infinity;
        for (let i = 0; i < n; i++) if (P[i] && s[i] < minS) minS = s[i];
        if (minS > 0) break;
        let alpha = Infinity;
        for (let i = 0; i < n; i++) if (P[i] && s[i] <= 0) {
          const a = x[i] / (x[i] - s[i]);
          if (a < alpha) alpha = a;
        }
        for (let i = 0; i < n; i++) x[i] += alpha * (s[i] - x[i]);
        for (let i = 0; i < n; i++) if (P[i] && x[i] <= tol) { P[i] = 0; x[i] = 0; }
        s = solveP();
      }
      for (let i = 0; i < n; i++) x[i] = s[i];
      computeW();
    }
    return x;
  };
  // Mínimos cuadrados con QR de Householder: A (m x k), b (m)
  M.lstsq = function (A, b) {
    const m = A.length, k = A[0].length;
    const R = A.map(r => Float64Array.from(r));
    const y = Float64Array.from(b);
    for (let c = 0; c < k; c++) {
      let nrm = 0;
      for (let r = c; r < m; r++) nrm += R[r][c] * R[r][c];
      nrm = Math.sqrt(nrm);
      if (nrm === 0) continue;
      const alpha = R[c][c] > 0 ? -nrm : nrm;
      const v = new Float64Array(m);
      for (let r = c; r < m; r++) v[r] = R[r][c];
      v[c] -= alpha;
      let vn = 0;
      for (let r = c; r < m; r++) vn += v[r] * v[r];
      if (vn === 0) continue;
      for (let cc = c; cc < k; cc++) {
        let d = 0;
        for (let r = c; r < m; r++) d += v[r] * R[r][cc];
        const f = 2 * d / vn;
        for (let r = c; r < m; r++) R[r][cc] -= f * v[r];
      }
      let d = 0;
      for (let r = c; r < m; r++) d += v[r] * y[r];
      const f = 2 * d / vn;
      for (let r = c; r < m; r++) y[r] -= f * v[r];
    }
    const x = new Float64Array(k);
    for (let c = k - 1; c >= 0; c--) {
      let s = y[c];
      for (let cc = c + 1; cc < k; cc++) s -= R[c][cc] * x[cc];
      x[c] = R[c][c] !== 0 ? s / R[c][c] : 0;
    }
    return x;
  };

  // ------------------------------------------------------------------ minimize_scalar(bounded) = fminbound
  M.fminbound = function (func, x1, x2, xatol) {
    xatol = xatol === undefined ? 1e-5 : xatol;
    const maxfun = 500;
    const sqrt_eps = Math.sqrt(2.2e-16);
    const golden_mean = 0.5 * (3.0 - Math.sqrt(5.0));
    let a = x1, b = x2;
    let fulc = a + golden_mean * (b - a);
    let nfc = fulc, xf = fulc;
    let rat = 0.0, e = 0.0;
    let x = xf;
    let fx = func(x);
    let num = 1;
    let ffulc = fx, fnfc = fx;
    let xm = 0.5 * (a + b);
    let tol1 = sqrt_eps * Math.abs(xf) + xatol / 3.0;
    let tol2 = 2.0 * tol1;
    while (Math.abs(xf - xm) > (tol2 - 0.5 * (b - a))) {
      let golden = 1;
      if (Math.abs(e) > tol1) {
        golden = 0;
        let r = (xf - nfc) * (fx - ffulc);
        let q = (xf - fulc) * (fx - fnfc);
        let p = (xf - fulc) * q - (xf - nfc) * r;
        q = 2.0 * (q - r);
        if (q > 0.0) p = -p;
        q = Math.abs(q);
        r = e;
        e = rat;
        if ((Math.abs(p) < Math.abs(0.5 * q * r)) && (p > q * (a - xf)) && (p < q * (b - xf))) {
          rat = (p + 0.0) / q;
          x = xf + rat;
          if (((x - a) < tol2) || ((b - x) < tol2)) {
            const si = (xm - xf) >= 0 ? 1 : -1;
            rat = tol1 * si;
          }
        } else golden = 1;
      }
      if (golden) {
        if (xf >= xm) e = a - xf; else e = b - xf;
        rat = golden_mean * e;
      }
      const si = rat >= 0 ? 1 : -1;
      x = xf + si * Math.max(Math.abs(rat), tol1);
      const fu = func(x);
      num += 1;
      if (fu <= fx) {
        if (x >= xf) a = xf; else b = xf;
        fulc = nfc; ffulc = fnfc;
        nfc = xf; fnfc = fx;
        xf = x; fx = fu;
      } else {
        if (x < xf) a = x; else b = x;
        if ((fu <= fnfc) || (nfc === xf)) {
          fulc = nfc; ffulc = fnfc;
          nfc = x; fnfc = fu;
        } else if ((fu <= ffulc) || (fulc === xf) || (fulc === nfc)) {
          fulc = x; ffulc = fu;
        }
      }
      xm = 0.5 * (a + b);
      tol1 = sqrt_eps * Math.abs(xf) + xatol / 3.0;
      tol2 = 2.0 * tol1;
      if (num >= maxfun) break;
    }
    return { x: xf, fun: fx };
  };

  // ------------------------------------------------------------------ formato de números (Python)
  // repr() de un float de Python
  M.pyFloat = function (v) {
    if (v !== v) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    if (v === 0) return (1 / v < 0) ? "-0.0" : "0.0";
    // dígitos mínimos que reproducen el número
    let e = v.toExponential();       // "d.ddde±x" con los dígitos mínimos
    const neg = e[0] === "-";
    if (neg) e = e.slice(1);
    const parts = e.split("e");
    const digits = parts[0].replace(".", "");
    const exp = parseInt(parts[1], 10);
    let s;
    if (exp < -4 || exp >= 16) {
      s = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + "e" + (exp < 0 ? "-" : "+") +
        (Math.abs(exp) < 10 ? "0" : "") + Math.abs(exp);
    } else if (exp >= 0) {
      if (digits.length <= exp + 1) s = digits + "0".repeat(exp + 1 - digits.length) + ".0";
      else s = digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
    } else {
      s = "0." + "0".repeat(-exp - 1) + digits;
    }
    return (neg ? "-" : "") + s;
  };
  // format(v, ".Nf") y ".Ng" de Python
  M.fmtF = function (v, nd) {
    if (v === null || v === undefined || v !== v) return "nan";
    if (!isFinite(v)) return v > 0 ? "inf" : "-inf";
    // Python redondea el valor binario exacto (half-even sobre la expansión exacta)
    return pyFixed(v, nd);
  };
  function pyFixed(v, nd) {
    const neg = v < 0 || (v === 0 && 1 / v < 0);
    const r = M.pyRound(Math.abs(v), nd);
    let s = r.toFixed(nd);
    if (neg && parseFloat(s) !== 0) s = "-" + s;
    else if (neg) s = "-" + s;
    return s;
  }
  M.fmtG = function (v, prec) {        // format(v, ".{prec}g") / f"{v:g}" (prec 6)
    if (prec === undefined) prec = 6;
    if (v !== v) return "nan";
    if (!isFinite(v)) return v > 0 ? "inf" : "-inf";
    if (v === 0) return (1 / v < 0) ? "-0" : "0";
    if (prec === 0) prec = 1;
    // exponente tras redondear a prec cifras
    let s = Math.abs(v).toExponential(prec - 1);
    // corrección del redondeo de toExponential (puede no ser half-even exacto): suficiente para mostrar
    let [mant, ex] = s.split("e");
    let exp = parseInt(ex, 10);
    let out;
    if (exp < -4 || exp >= prec) {
      mant = mant.indexOf(".") >= 0 ? mant.replace(/0+$/, "").replace(/\.$/, "") : mant;
      out = mant + "e" + (exp < 0 ? "-" : "+") + (Math.abs(exp) < 10 ? "0" : "") + Math.abs(exp);
    } else {
      out = Math.abs(v).toFixed(Math.max(0, prec - 1 - exp));
      if (out.indexOf(".") >= 0) out = out.replace(/0+$/, "").replace(/\.$/, "");
    }
    return (v < 0 ? "-" : "") + out;
  };
  // json.dumps(obj, indent=2, ensure_ascii=False) de Python. Los números se escriben como
  // float salvo los de las claves de intKeys (o los marcados con M.PyInt).
  function PyInt(v) { this.v = v; }
  M.PyInt = function (v) { return new PyInt(v); };
  M.pyJSON = function (obj, intKeys) {
    intKeys = intKeys || new Set();
    function str(s) {
      return JSON.stringify(s);   // escapes compatibles (ensure_ascii=False)
    }
    function num(v, asInt) {
      if (asInt && Number.isInteger(v)) return String(v);
      return M.pyFloat(v);
    }
    function ser(o, ind, key) {
      const pad = "  ".repeat(ind + 1), padE = "  ".repeat(ind);
      if (o === null || o === undefined) return "null";
      if (o instanceof PyInt) return String(o.v);
      if (typeof o === "boolean") return o ? "true" : "false";
      if (typeof o === "number") return num(o, intKeys.has(key));
      if (typeof o === "string") return str(o);
      if (Array.isArray(o) || ArrayBuffer.isView(o)) {
        if (!o.length) return "[]";
        const items = Array.from(o, v => pad + ser(v, ind + 1, key));
        return "[\n" + items.join(",\n") + "\n" + padE + "]";
      }
      const keys = Object.keys(o);
      if (!keys.length) return "{}";
      return "{\n" + keys.map(k => pad + str(k) + ": " + ser(o[k], ind + 1, k)).join(",\n") + "\n" + padE + "}";
    }
    return ser(obj, 0, null);
  };
});
