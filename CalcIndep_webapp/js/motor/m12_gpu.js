/* CalcIndep web · superposición en GPU con WebGPU (equivale a gpu.py con OpenCL), opcional.
 * Misma recursión que la CPU en simple precisión (fp32), con los desarrollos en serie de
 * 1 - e^-x y de 1 - (1 - e^-x)/x para x < 0.1. Comprobación automática frente a la CPU con un
 * maniquí de tórax: se acepta si la diferencia máxima es menor del 0.01 % de la dosis máxima.
 */
CI_MOTOR_MODULOS.push(function CIMod_gpu(M) {
  "use strict";
  const G = {};
  M.GPU = G;
  G.TOLERANCE_PCT = 0.01;
  G.MIN_SPEEDUP = 1.2;
  G.PRECISION = "fp32";
  G.TEST_VOX_MM = 4.0;
  const MAXC = 4;   // componentes exponenciales admitidas en la GPU

  G.WGSL = `
struct P {
  nz : i32, ny : i32, nx : i32, nu : i32,
  nv : i32, ns : i32, ncomp : i32, pad0 : i32,
  sp : vec4<f32>, d : vec4<f32>, e1 : vec4<f32>, e2 : vec4<f32>,
  org : vec4<f32>, hds : vec4<f32>, blo : vec4<f32>, bhi : vec4<f32>,
  tlo : vec4<f32>, thi : vec4<f32>, A : vec4<f32>, a : vec4<f32>,
};
@group(0) @binding(0) var<storage, read> T : array<f32>;
@group(0) @binding(1) var<storage, read> R : array<f32>;
@group(0) @binding(2) var<storage, read> mask : array<u32>;
@group(0) @binding(3) var<storage, read_write> lat : array<f32>;
@group(0) @binding(4) var<storage, read_write> outd : array<f32>;
@group(0) @binding(5) var<uniform> p : P;

fn slab(b : vec3<f32>, lo : vec3<f32>, hi : vec3<f32>) -> vec2<f32> {
  var smin : f32 = -1e30;
  var smax : f32 = 1e30;
  let d = p.d.xyz;
  for (var ax : i32 = 0; ax < 3; ax = ax + 1) {
    if (abs(d[ax]) < 1e-12) {
      if (b[ax] < lo[ax] || b[ax] > hi[ax]) { return vec2<f32>(1e30, -1e30); }
    } else {
      var t1 = (lo[ax] - b[ax]) / d[ax];
      var t2 = (hi[ax] - b[ax]) / d[ax];
      if (t1 > t2) { let t = t1; t1 = t2; t2 = t; }
      if (t1 > smin) { smin = t1; }
      if (t2 < smax) { smax = t2; }
    }
  }
  return vec2<f32>(smin, smax);
}

fn tri2(fz0 : f32, fy0 : f32, fx0 : f32) -> vec2<f32> {
  let nx = p.nx; let ny = p.ny; let nz = p.nz;
  if (fx0 < -0.5 || fy0 < -0.5 || fz0 < -0.5 || fx0 > f32(nx) - 0.5 || fy0 > f32(ny) - 0.5 || fz0 > f32(nz) - 0.5) {
    return vec2<f32>(0.0, 0.0);
  }
  let fx = min(max(fx0, 0.0), f32(nx - 1));
  let fy = min(max(fy0, 0.0), f32(ny - 1));
  let fz = min(max(fz0, 0.0), f32(nz - 1));
  var i0 = i32(fx); var j0 = i32(fy); var k0 = i32(fz);
  if (i0 >= nx - 1) { i0 = select(0, nx - 2, nx > 1); }
  if (j0 >= ny - 1) { j0 = select(0, ny - 2, ny > 1); }
  if (k0 >= nz - 1) { k0 = select(0, nz - 2, nz > 1); }
  let tx = fx - f32(i0); let ty = fy - f32(j0); let tz = fz - f32(k0);
  let i1 = min(i0 + 1, nx - 1); let j1 = min(j0 + 1, ny - 1); let k1 = min(k0 + 1, nz - 1);
  let w000 = (1.0 - tz) * (1.0 - ty) * (1.0 - tx); let w001 = (1.0 - tz) * (1.0 - ty) * tx;
  let w010 = (1.0 - tz) * ty * (1.0 - tx);         let w011 = (1.0 - tz) * ty * tx;
  let w100 = tz * (1.0 - ty) * (1.0 - tx);         let w101 = tz * (1.0 - ty) * tx;
  let w110 = tz * ty * (1.0 - tx);                 let w111 = tz * ty * tx;
  let s1 = u32(nx); let s2 = u32(nx) * u32(ny);
  let b000 = u32(k0) * s2 + u32(j0) * s1 + u32(i0); let b001 = u32(k0) * s2 + u32(j0) * s1 + u32(i1);
  let b010 = u32(k0) * s2 + u32(j1) * s1 + u32(i0); let b011 = u32(k0) * s2 + u32(j1) * s1 + u32(i1);
  let b100 = u32(k1) * s2 + u32(j0) * s1 + u32(i0); let b101 = u32(k1) * s2 + u32(j0) * s1 + u32(i1);
  let b110 = u32(k1) * s2 + u32(j1) * s1 + u32(i0); let b111 = u32(k1) * s2 + u32(j1) * s1 + u32(i1);
  let ra = w000 * T[b000] + w001 * T[b001] + w010 * T[b010] + w011 * T[b011]
         + w100 * T[b100] + w101 * T[b101] + w110 * T[b110] + w111 * T[b111];
  let rb = w000 * R[b000] + w001 * R[b001] + w010 * R[b010] + w011 * R[b011]
         + w100 * R[b100] + w101 * R[b101] + w110 * R[b110] + w111 * R[b111];
  return vec2<f32>(ra, rb);
}

@compute @workgroup_size(64)
fn sweep(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(num_workgroups) nwg : vec3<u32>) {
  let line = gid.x + gid.y * nwg.x * 64u;
  let nl = u32(p.nu) * u32(p.nv);
  if (line >= nl) { return; }
  let iu = i32(line / u32(p.nv)); let iv = i32(line - u32(iu) * u32(p.nv));
  let h = p.hds.x; let ds = p.hds.y;
  let bu = p.org.x + f32(iu) * h; let bv = p.org.y + f32(iv) * h;
  let e1 = p.e1.xyz; let e2 = p.e2.xyz; let d = p.d.xyz;
  let b = vec3<f32>(bu * e1.x + bv * e2.x, bu * e1.y + bv * e2.y, bu * e1.z + bv * e2.z);
  var kin : i32 = 0; var kout : i32 = 0;
  let sl = slab(b, p.blo.xyz, p.bhi.xyz);
  let tl = slab(b, p.tlo.xyz, p.thi.xyz);
  if (sl.y > sl.x && tl.y > tl.x) {
    var smin = sl.x;
    if (tl.x > smin) { smin = tl.x; }
    kin = i32(floor((smin - p.org.z) / ds));
    kout = i32(ceil((sl.y - p.org.z) / ds));
    if (kin < 0) { kin = 0; }
    if (kout > p.ns) { kout = p.ns; }
    if (kout < kin) { kout = kin; }
  }
  for (var k : i32 = 0; k < kin; k = k + 1) { lat[u32(k) * nl + line] = 0.0; }
  for (var k : i32 = kout; k < p.ns; k = k + 1) { lat[u32(k) * nl + line] = 0.0; }
  var F = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  for (var k : i32 = kin; k < kout; k = k + 1) {
    let s = p.org.z + (f32(k) + 0.5) * ds;
    let px = b.x + s * d.x; let py = b.y + s * d.y; let pz = b.z + s * d.z;
    let tr = tri2(pz / p.sp.z, py / p.sp.y, px / p.sp.x);
    let t = tr.x;
    let dl = tr.y * ds;
    var dose : f32 = 0.0;
    for (var j : i32 = 0; j < p.ncomp; j = j + 1) {
      let aj = p.a[j];
      let x = aj * dl;
      var om : f32; var g : f32;
      if (x < 0.1) {
        om = x * (1.0 - x * (0.5 - x * (1.0 / 6.0 - x * (1.0 / 24.0 - x * (1.0 / 120.0 - x / 720.0)))));
        g = x * (0.5 - x * (1.0 / 6.0 - x * (1.0 / 24.0 - x * (1.0 / 120.0 - x * (1.0 / 720.0 - x / 5040.0)))));
      } else {
        om = 1.0 - exp(-x);
        g = 1.0 - om / x;
      }
      dose = dose + p.A[j] * (F[j] * (1.0 - g) + (t / aj) * g);
      F[j] = F[j] * (1.0 - om) + t * om / aj;
    }
    lat[u32(k) * nl + line] = dose;
  }
}

@compute @workgroup_size(8, 8, 1)
fn gather(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = i32(gid.x); let j = i32(gid.y); let k = i32(gid.z);
  if (i >= p.nx || j >= p.ny || k >= p.nz) { return; }
  let idx = (u32(k) * u32(p.ny) + u32(j)) * u32(p.nx) + u32(i);
  if (mask[idx] == 0u) { return; }
  let px = f32(i) * p.sp.x; let py = f32(j) * p.sp.y; let pz = f32(k) * p.sp.z;
  let e1 = p.e1.xyz; let e2 = p.e2.xyz; let d = p.d.xyz;
  let h = p.hds.x; let ds = p.hds.y;
  let fu = (px * e1.x + py * e1.y + pz * e1.z - p.org.x) / h;
  let fv = (px * e2.x + py * e2.y + pz * e2.z - p.org.y) / h;
  let fs = (px * d.x + py * d.y + pz * d.z - p.org.z) / ds - 0.5;
  if (fu < 0.0 || fv < 0.0 || fs < 0.0 || fu > f32(p.nu - 1) || fv > f32(p.nv - 1) || fs > f32(p.ns - 1)) { return; }
  let iu = min(i32(fu), p.nu - 2); let iv = min(i32(fv), p.nv - 2); let is = min(i32(fs), p.ns - 2);
  let tu = fu - f32(iu); let tv = fv - f32(iv); let ts = fs - f32(is);
  let nl = u32(p.nu) * u32(p.nv);
  let l00 = u32(iu) * u32(p.nv) + u32(iv); let l01 = l00 + 1u; let l10 = l00 + u32(p.nv); let l11 = l10 + 1u;
  let a0 = u32(is) * nl; let a1 = a0 + nl;
  let val = (1.0 - tu) * (1.0 - tv) * (1.0 - ts) * lat[a0 + l00]
          + (1.0 - tu) * (1.0 - tv) * ts * lat[a1 + l00]
          + (1.0 - tu) * tv * (1.0 - ts) * lat[a0 + l01]
          + (1.0 - tu) * tv * ts * lat[a1 + l01]
          + tu * (1.0 - tv) * (1.0 - ts) * lat[a0 + l10]
          + tu * (1.0 - tv) * ts * lat[a1 + l10]
          + tu * tv * (1.0 - ts) * lat[a0 + l11]
          + tu * tv * ts * lat[a1 + l11];
  outd[idx] = outd[idx] + val;
}
`;
  // Identificador del código del kernel (cambia la comprobación si cambia el código)
  G.kernelId = (function () {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < G.WGSL.length; i++) {
      const c = G.WGSL.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ (c + 31), 2246822519) >>> 0;
    }
    return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 12);
  })();

  G.available = () => typeof navigator !== "undefined" && !!navigator.gpu;

  // Adaptadores WebGPU (uno por preferencia de energía, sin repetir)
  G.listDevices = async function () {
    if (!G.available()) return [[], "este navegador no tiene WebGPU"];
    const out = [];
    const seen = new Set();
    for (const pref of ["high-performance", "low-power"]) {
      let ad = null;
      try { ad = await navigator.gpu.requestAdapter({ powerPreference: pref }); } catch (e) { ad = null; }
      if (!ad) continue;
      let info = ad.info || null;
      if (!info && ad.requestAdapterInfo) { try { info = await ad.requestAdapterInfo(); } catch (e) { info = null; } }
      info = info || {};
      if ((ad.isFallbackAdapter || info.isFallbackAdapter) && !G.allowFallback) continue;
      const name = (info.description || [info.vendor, info.architecture, info.device].filter(Boolean).join(" ") ||
                    "GPU WebGPU").trim();
      const key = name + "|" + (info.vendor || "") + "|" + (info.architecture || "") + "|" + (info.device || "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ info: { name, vendor: info.vendor || "", architecture: info.architecture || "", device: info.device || "",
                         driver: info.driver || "", key: `${key}|${G.PRECISION}|${G.kernelId}` }, adapter: ad, pref });
    }
    if (!out.length) return [[], "no hay ninguna GPU con WebGPU"];
    return [out, ""];
  };

  class Superposer {
    constructor(adapter) { this.adapter = adapter; this.device = null; this.pipes = null; }
    async init() {
      const ad = this.adapter;
      const lim = ad.limits;
      this.device = await ad.requestDevice({ requiredLimits: {
        maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize, maxBufferSize: lim.maxBufferSize,
        maxComputeWorkgroupsPerDimension: lim.maxComputeWorkgroupsPerDimension } });
      this.lost = null;
      this.device.lost.then(info => { this.lost = info.message || "dispositivo perdido"; });
      const dev = this.device;
      const mod = dev.createShaderModule({ code: G.WGSL });
      if (mod.getCompilationInfo) {
        const ci = await mod.getCompilationInfo();
        const errs = ci.messages.filter(m => m.type === "error");
        if (errs.length) throw new Error("WGSL: " + errs.map(m => m.message).join("; "));
      }
      const entries = [0, 1, 2].map(b => ({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }));
      entries.push({ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } });
      entries.push({ binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } });
      entries.push({ binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true } });
      this.bgl = dev.createBindGroupLayout({ entries });
      const layout = dev.createPipelineLayout({ bindGroupLayouts: [this.bgl] });
      this.pSweep = await dev.createComputePipelineAsync({ layout, compute: { module: mod, entryPoint: "sweep" } });
      this.pGather = await dev.createComputePipelineAsync({ layout, compute: { module: mod, entryPoint: "gather" } });
      return this;
    }
    // Misma interfaz que M.superpose (devuelve Float64Array)
    async superpose(terma, rho, shape, spCm, directions, A, a, mask, lineCm, stepCm) {
      if (this.lost) throw new Error("la GPU no está disponible: " + this.lost);
      const dev = this.device;
      const [nz, ny, nx] = shape;
      const nvox = nz * ny * nx;
      const prep = M.cccPrepare(terma, shape, spCm, directions, lineCm, stepCm);
      if (!prep) return new Float64Array(nvox);
      const ncomp = A[0].length;
      if (ncomp > MAXC) throw new Error(`la GPU admite hasta ${MAXC} componentes del kernel`);
      let maxlat = 0;
      for (const g of prep.geo) maxlat = Math.max(maxlat, g.nu * g.nv * g.ns);
      const lim = this.adapter.limits.maxStorageBufferBindingSize;
      if (4 * maxlat > lim || 4 * nvox > lim) throw new Error("la rejilla no cabe en la memoria de la GPU");
      const mk = (arr, usage) => {
        const b = dev.createBuffer({ size: Math.max(16, Math.ceil(arr.byteLength / 4) * 4), usage, mappedAtCreation: true });
        new arr.constructor(b.getMappedRange()).set(arr);
        b.unmap();
        return b;
      };
      const S = GPUBufferUsage.STORAGE;
      const T32 = terma instanceof Float32Array ? terma : Float32Array.from(terma);
      const R32 = rho instanceof Float32Array ? rho : Float32Array.from(rho);
      const m32 = new Uint32Array(nvox);
      if (mask) for (let q = 0; q < nvox; q++) m32[q] = mask[q] ? 1 : 0; else m32.fill(1);
      const bT = mk(T32, S), bR = mk(R32, S), bM = mk(m32, S);
      const bL = dev.createBuffer({ size: Math.max(16, 4 * maxlat), usage: S });
      const bO = dev.createBuffer({ size: Math.max(16, 4 * nvox), usage: S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const ndir = prep.geo.length;
      const STRIDE = 256;
      const ub = new ArrayBuffer(STRIDE * ndir);
      prep.geo.forEach((g, n) => {
        const i32 = new Int32Array(ub, n * STRIDE, 8);
        i32.set([nz, ny, nx, g.nu, g.nv, g.ns, ncomp, 0]);
        const f = new Float32Array(ub, n * STRIDE + 32, 48);
        const sp = prep.sp;
        f.set([sp[0], sp[1], sp[2], 0, g.d[0], g.d[1], g.d[2], 0, g.e1[0], g.e1[1], g.e1[2], 0,
               g.e2[0], g.e2[1], g.e2[2], 0, g.u0, g.v0, g.s0, 0, prep.h, prep.ds, 0, 0,
               prep.boxLo[0], prep.boxLo[1], prep.boxLo[2], 0, prep.boxHi[0], prep.boxHi[1], prep.boxHi[2], 0,
               prep.tLo[0], prep.tLo[1], prep.tLo[2], 0, prep.tHi[0], prep.tHi[1], prep.tHi[2], 0]);
        for (let j = 0; j < ncomp; j++) { f[40 + j] = A[n][j]; f[44 + j] = a[n][j]; }
      });
      const bU = dev.createBuffer({ size: ub.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(bU, 0, ub);
      const bg = dev.createBindGroup({ layout: this.bgl, entries: [
        { binding: 0, resource: { buffer: bT } }, { binding: 1, resource: { buffer: bR } },
        { binding: 2, resource: { buffer: bM } }, { binding: 3, resource: { buffer: bL } },
        { binding: 4, resource: { buffer: bO } }, { binding: 5, resource: { buffer: bU, size: 224 } }] });
      const maxWG = this.adapter.limits.maxComputeWorkgroupsPerDimension;
      try {
        const BATCH = 4;
        for (let n0 = 0; n0 < ndir; n0 += BATCH) {
          const enc = dev.createCommandEncoder();
          for (let n = n0; n < Math.min(ndir, n0 + BATCH); n++) {
            const g = prep.geo[n];
            const nl = g.nu * g.nv;
            const wg = Math.ceil(nl / 64);
            const wx = Math.min(wg, maxWG), wy = Math.ceil(wg / wx);
            let pass = enc.beginComputePass();
            pass.setPipeline(this.pSweep);
            pass.setBindGroup(0, bg, [n * STRIDE]);
            pass.dispatchWorkgroups(wx, wy);
            pass.end();
            pass = enc.beginComputePass();
            pass.setPipeline(this.pGather);
            pass.setBindGroup(0, bg, [n * STRIDE]);
            pass.dispatchWorkgroups(Math.ceil(nx / 8), Math.ceil(ny / 8), nz);
            pass.end();
          }
          dev.queue.submit([enc.finish()]);
          await dev.queue.onSubmittedWorkDone();
          if (this.lost) throw new Error("la GPU ha dejado de responder: " + this.lost);
        }
        const rb = dev.createBuffer({ size: Math.max(16, 4 * nvox), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const enc = dev.createCommandEncoder();
        enc.copyBufferToBuffer(bO, 0, rb, 0, Math.max(16, 4 * nvox));
        dev.queue.submit([enc.finish()]);
        await rb.mapAsync(GPUMapMode.READ);
        const res = new Float32Array(rb.getMappedRange().slice(0, 4 * nvox));
        rb.unmap();
        rb.destroy();
        return Float64Array.from(res);
      } finally {
        for (const b of [bT, bR, bM, bL, bO, bU]) b.destroy();
      }
    }
  }
  G.Superposer = Superposer;

  // Maniquí de tórax 30 x 30 x 24 cm (agua, pulmón, hueso y aire) con un campo 10 x 10 (gpu._test_case)
  G.testCase = function (voxMm) {
    const m = M.BeamModel.fromJSON(M.DATOS_MODELO_GENERICO);
    const k = M.polyenergeticKernel(M.EDK, m.energies, m.weights, m.kernel_weight_depth_cm);
    const cs = M.buildConeSet(k, M.EDK.angle_edges, M.EDK.radius_edges, null, null, m.kernel_components);
    const sp = (voxMm || G.TEST_VOX_MM) / 10.0;
    const nx = Math.trunc(M.rint(30 / sp)), ny = Math.trunc(M.rint(30 / sp)), nz = Math.trunc(M.rint(24 / sp));
    const xs = Float64Array.from({ length: nx }, (_, i) => (i - (nx - 1) / 2) * sp);
    const ys = Float64Array.from({ length: ny }, (_, j) => (j - (ny - 1) / 2) * sp);
    const zs = Float64Array.from({ length: nz }, (_, k2) => (k2 - (nz - 1) / 2) * sp);
    const n = nx * ny * nz;
    const rho = new Float64Array(n), body = new Uint8Array(n), T = new Float64Array(n);
    for (let kz = 0; kz < nz; kz++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const p = (kz * ny + j) * nx + i;
      const X = xs[i], Y = ys[j];
      const b = X * X + Y * Y <= 13.0 * 13.0;
      body[p] = b ? 1 : 0;
      let r = b ? 1.0 : 0.001;
      if (b && Y > -9 && Y < -1 && X > -9 && X < 2) r = 0.2;
      if (b && Math.abs(X - 1) < 1 && Y > -12 && Y < -10.5) r = 1.6;
      rho[p] = r;
    }
    const edge = q => 0.5 * (1 + Math.tanh((5.0 - Math.abs(q)) / 0.3));
    for (let kz = 0; kz < nz; kz++) for (let i = 0; i < nx; i++) {
      let rd = 0;
      for (let j = 0; j < ny; j++) {
        const p = (kz * ny + j) * nx + i;
        rd += rho[p];
        const Y = ys[j];
        T[p] = edge(xs[i]) * edge(zs[kz]) * Math.exp(-0.05 * (rd * sp)) * (100.0 / (100.0 + Y)) ** 2 *
          (rho[p] > 0.01 ? 1 : 0) * rho[p];
      }
    }
    const u = [1.0, 0, 0], w = [0, 1.0, 0];
    const v = M.cross3(w, u);
    return { T, rho, body, shape: [nz, ny, nx], sp: [sp, sp, sp], dirs: M.rotateDirs(cs.directions, u, v, w), A: cs.A, a: cs.a };
  };

  // Comprobación de una GPU frente a la CPU (cpuSuperpose: función asíncrona con la interfaz de superpose)
  G.selfTest = async function (dev, cpuSuperpose, progress) {
    const info = dev.info;
    if (progress) progress(`Comprobando la GPU ${info.name} (solo la primera vez, unos segundos)`);
    const rec = { nombre: info.name, plataforma: "WebGPU", driver: info.driver || info.architecture || "",
                  precision: G.PRECISION, kernel: G.kernelId, fecha: M.fechaPy().slice(0, 16), valida: false,
                  mas_rapida: false, dif_max_pct: null, t_cpu_s: null, t_gpu_s: null, error: null };
    try {
      const tc = G.testCase();
      const g = await new Superposer(dev.adapter).init();
      // compilación / calentamiento con dos direcciones
      await g.superpose(tc.T, tc.rho, tc.shape, tc.sp, tc.dirs.slice(0, 2), tc.A.slice(0, 2), tc.a.slice(0, 2), tc.body);
      await cpuSuperpose(tc.T, tc.rho, tc.shape, tc.sp, tc.dirs.slice(0, 2), tc.A.slice(0, 2), tc.a.slice(0, 2), tc.body);
      const best = async (f, n) => {
        let tb = 1e30, res = null;
        for (let q = 0; q < (n || 2); q++) {
          const t0 = performance.now();
          res = await f();
          tb = Math.min(tb, (performance.now() - t0) / 1000);
        }
        return [tb, res];
      };
      const [tCpu, Dc] = await best(() => cpuSuperpose(tc.T, tc.rho, tc.shape, tc.sp, tc.dirs, tc.A, tc.a, tc.body));
      const [tGpu, Dg] = await best(() => g.superpose(tc.T, tc.rho, tc.shape, tc.sp, tc.dirs, tc.A, tc.a, tc.body));
      let dmax = 0, dif = 0;
      for (let p = 0; p < Dc.length; p++) if (tc.body[p]) {
        dmax = Math.max(dmax, Dc[p]);
        dif = Math.max(dif, Math.abs(Dg[p] - Dc[p]));
      }
      const diff = dif / dmax * 100.0;
      Object.assign(rec, { dif_max_pct: diff, t_cpu_s: M.pyRound(tCpu, 3), t_gpu_s: M.pyRound(tGpu, 3),
                           valida: isFinite(diff) && diff <= G.TOLERANCE_PCT, mas_rapida: tGpu * G.MIN_SPEEDUP < tCpu });
      g.device.destroy();
    } catch (e) {
      rec.error = `${e.name || "Error"}: ${e.message || e}`;
    }
    return rec;
  };
  G.describeRecord = function (rec) {
    if (!rec) return "sin comprobar";
    if (rec.error) return `la comprobación falló (${rec.error})`;
    const sp = rec.t_cpu_s / Math.max(rec.t_gpu_s, 1e-9);
    let txt = `comprobada el ${rec.fecha}: diferencia máxima con la CPU ${M.fmtF(rec.dif_max_pct, 5)} % de la dosis ` +
      `máxima, ${M.fmtF(sp, 1)} veces la velocidad de la CPU`;
    if (!rec.valida) txt += ` — NO VÁLIDA (tolerancia ${M.fmtG(G.TOLERANCE_PCT)} %)`;
    else if (!rec.mas_rapida) txt += " — no es más rápida que la CPU";
    return txt;
  };
});
