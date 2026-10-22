/* CalcIndep web · cálculo en paralelo con Web Workers.
 *
 * Hilo principal (interfaz)  ──►  coordinador (worker): flujo de verificación, calibración,
 *                                 comisionado y GPU
 *                                      │ MessageChannel
 *                                      ▼
 *                                 N subhilos (workers): TERMA, superposición, gamma, rasterizado
 *
 * Los workers se crean desde el código fuente de los módulos del motor (Blob), así funciona
 * también al abrir el HTML con doble clic (file://), sin servidor.
 */
var CI_HILOS_MODULOS = [];

// --------------------------------------------------------------------------- subhilo
CI_HILOS_MODULOS.push(function CIHilo_sub(M, port) {
  "use strict";
  const ctx = new Map();      // id -> array (densidades, máscaras, dosis)
  const f32cache = new Map();
  function get(id) {
    if (id === null || id === undefined || id < 0) return null;
    const a = ctx.get(id);
    if (a === undefined) throw new Error(`contexto ${id} no disponible en el subhilo`);
    return a;
  }
  port.onmessage = ev => {
    const msg = ev.data;
    try {
      if (msg.op === "ctx") { ctx.set(msg.id, msg.arr); return; }
      if (msg.op === "drop") { for (const id of msg.ids) { ctx.delete(id); f32cache.delete(id); } return; }
      let result, transfer = [];
      if (msg.op === "ccc") {
        const prep = msg.prep;
        const out = new Float64Array(prep.shape[0] * prep.shape[1] * prep.shape[2]);
        const t0 = performance.now();
        M.cccRun(msg.T32, get(msg.rhoId), get(msg.maskId), prep, msg.dirIdx, msg.A, msg.a, out);
        if (msg.debug) console.log(`subhilo ccc ${msg.dirIdx.length} direcciones ${(performance.now() - t0).toFixed(0)} ms`);
        result = out; transfer = [out.buffer];
      } else if (msg.op === "terma") {
        const p = msg.p;
        p.grid = M.Grid.from(p.grid);
        if (p.grid_t) p.grid_t = M.Grid.from(p.grid_t);
        p.geom = M.BeamGeometry.from(p.geom);
        p.rho = get(p.rhoId); p.rho_t = get(p.rhoTId);
        const r = M.computeTerma(p, msg.kRange);
        result = r; transfer = [r.T.buffer, r.De.buffer];
      } else if (msg.op === "rast") {
        const m = M.rasterize(msg.structure, M.Grid.from(msg.grid));
        result = m; transfer = [m.buffer];
      } else if (msg.op === "gamma") {
        const out = new Float64Array(msg.dref.length);
        M.gammaPoints(msg.pts, msg.dref, get(msg.deId), msg.eShape, msg.eOrg, msg.eSp, msg.offs, msg.d2, msg.dta,
                      msg.ddAbs, msg.local, msg.ddFrac, msg.gcap2, out);
        result = out; transfer = [out.buffer];
      } else if (msg.op === "superpose_full") {
        const out = M.superpose(msg.T, msg.rho, msg.shape, msg.sp, msg.dirs, msg.A, msg.a, msg.mask, msg.lineCm, msg.stepCm);
        result = out; transfer = [out.buffer];
      } else throw new Error("operación desconocida " + msg.op);
      port.postMessage({ tid: msg.tid, ok: true, result }, transfer);
    } catch (e) {
      port.postMessage({ tid: msg.tid, ok: false, error: String(e && e.message || e), stack: e && e.stack });
    }
  };
});

// --------------------------------------------------------------------------- reparto de tareas
CI_HILOS_MODULOS.push(function CIHilo_pool(M) {
  "use strict";
  class Pool {
    constructor(ports) {
      this.ports = ports;
      this.n = ports.length;
      this.busy = new Array(this.n).fill(false);
      this.has = ports.map(() => new Set());   // contextos que tiene cada subhilo
      this.ids = new WeakMap();
      this.f32 = new WeakMap();
      this.nextId = 1;
      this.nextTid = 1;
      this.pending = new Map();
      this.queue = [];
      this.cancelled = false;
      this.live = new Map();   // id -> tamaño en bytes (orden de llegada, para liberar)
      this.liveBytes = 0;
      this.budget = 512 * 1024 * 1024;   // memoria máxima de contextos en cada subhilo
      ports.forEach((p, w) => {
        p.onmessage = ev => {
          const m = ev.data;
          const pr = this.pending.get(m.tid);
          if (!pr) return;
          this.pending.delete(m.tid);
          this.busy[w] = false;
          if (m.ok) pr.resolve(m.result); else pr.reject(new Error(m.error));
          this._pump();
        };
      });
    }
    idOf(arr) {
      if (!arr) return -1;
      let id = this.ids.get(arr);
      if (!id) { id = this.nextId++; this.ids.set(arr, id); }
      return id;
    }
    f32Of(arr) {
      if (!arr) return null;
      if (arr instanceof Float32Array) return arr;
      let f = this.f32.get(arr);
      if (!f) { f = Float32Array.from(arr); this.f32.set(arr, f); }
      return f;
    }
    // Envía un array de contexto a un subhilo si aún no lo tiene
    _ensure(w, arr) {
      if (!arr) return -1;
      const id = this.idOf(arr);
      if (!this.has[w].has(id)) { this.ports[w].postMessage({ op: "ctx", id, arr }); this.has[w].add(id); }
      if (!this.live.has(id)) {
        this.live.set(id, arr.byteLength || 0);
        this.liveBytes += arr.byteLength || 0;
      }
      return id;
    }
    // Libera los contextos más antiguos si se supera el presupuesto de memoria (cálculos largos, como el
    // comisionado, que usan muchos maniquíes). Un contexto liberado que se vuelva a usar se envía de nuevo.
    // Se llama después de enviar una tarea: los puertos son FIFO, así que las tareas ya enviadas se
    // ejecutan antes de la orden de liberar.
    _trim(keep) {
      if (this.liveBytes <= this.budget) return;
      const ids = [];
      for (const [id, b] of this.live) {
        if (this.liveBytes <= this.budget * 0.6) break;
        if (id === keep) continue;
        ids.push(id);
        this.liveBytes -= b;
      }
      if (!ids.length) return;
      for (const id of ids) this.live.delete(id);
      this.ports.forEach((p, w) => { p.postMessage({ op: "drop", ids }); for (const id of ids) this.has[w].delete(id); });
    }
    // Libera los contextos (fin de un cálculo)
    release() {
      const ids = Array.from(this.live.keys());
      this.ports.forEach((p, w) => { p.postMessage({ op: "drop", ids }); this.has[w].clear(); });
      this.live.clear();
      this.liveBytes = 0;
      this.ids = new WeakMap();
      this.f32 = new WeakMap();
    }
    // tarea: {build(w) -> [msg, transfer], worker (opcional: subhilo fijo)}
    run(task) {
      return new Promise((resolve, reject) => { this.queue.push({ task, resolve, reject }); this._pump(); });
    }
    _pump() {
      for (let qi = 0; qi < this.queue.length; qi++) {
        const it = this.queue[qi];
        if (this.cancelled) { this.queue.splice(qi, 1); qi--; it.reject(new M.Cancelled()); continue; }
        let w = it.task.worker;
        if (w === undefined || w === null) w = this.busy.indexOf(false);
        if (w < 0 || this.busy[w]) continue;
        this.queue.splice(qi, 1); qi--;
        this.busy[w] = true;
        const tid = this.nextTid++;
        let msg, transfer;
        try { [msg, transfer] = it.task.build(w); }
        catch (e) { this.busy[w] = false; it.reject(e); continue; }
        msg.tid = tid;
        this.pending.set(tid, { resolve: it.resolve, reject: it.reject });
        this.ports[w].postMessage(msg, transfer || []);
        this._trim();
      }
    }
    // ----------------------------------------------------------- operaciones
    async superpose(T, rho, shape, sp, dirs, A, a, mask, lineCm, stepCm) {
      const n = shape[0] * shape[1] * shape[2];
      const prep = M.cccPrepare(T, shape, sp, dirs, lineCm, stepCm);
      if (!prep) return new Float64Array(n);
      const T32 = Float32Array.from(T);
      const R32 = this.f32Of(rho);
      // reparto contiguo de direcciones equilibrado por coste
      const cost = M.cccCost(prep);
      const total = cost.reduce((s, c) => s + c, 0);
      const W = Math.min(this.forceW || this.n, dirs.length);
      const chunks = [];
      let acc = 0, cur = [];
      for (let d = 0; d < dirs.length; d++) {
        cur.push(d); acc += cost[d];
        if (acc >= total * (chunks.length + 1) / W && chunks.length < W - 1) { chunks.push(cur); cur = []; }
      }
      if (cur.length) chunks.push(cur);
      const mkTask = (idx, c) => this.run({ worker: c % this.n, build: w => {
        const rhoId = this._ensure(w, R32), maskId = this._ensure(w, mask || null);
        return [{ op: "ccc", T32, rhoId, maskId, prep, dirIdx: idx, A, a, debug: this.debug }, []];
      } });
      let outs;
      if (this.sequential) { outs = []; for (let c = 0; c < chunks.length; c++) outs.push(await mkTask(chunks[c], c)); }
      else outs = await Promise.all(chunks.map(mkTask));
      const out = outs[0];
      for (let c = 1; c < outs.length; c++) { const o = outs[c]; for (let p = 0; p < n; p++) out[p] += o[p]; }
      return out;
    }
    async termaMany(list) {
      const one = p => {
        const base = Object.assign({}, p);
        delete base.rho; delete base.rho_t;
        base.grid = p.grid.toObj(); base.grid_t = p.grid_t ? p.grid_t.toObj() : null;
        base.geom = p.geom.toObj();
        return base;
      };
      if (list.length >= this.n || list.length > 1) {
        return Promise.all(list.map(p => this.run({ build: w => {
          const q = one(p);
          q.rhoId = p.rho_t ? -1 : this._ensure(w, p.rho);
          q.rhoTId = this._ensure(w, p.rho_t || null);
          return [{ op: "terma", p: q }, []];
        } })));
      }
      // una sola incidencia: se reparte por cortes
      const p = list[0];
      const nz = p.grid.shape[0], slab = p.grid.shape[1] * p.grid.shape[2];
      const W = Math.min(this.n, nz);
      const ranges = [];
      for (let c = 0; c < W; c++) ranges.push([Math.floor(c * nz / W), Math.floor((c + 1) * nz / W)]);
      const parts = await Promise.all(ranges.map(r => this.run({ build: w => {
        const q = one(p);
        q.rhoId = p.rho_t ? -1 : this._ensure(w, p.rho);
        q.rhoTId = this._ensure(w, p.rho_t || null);
        return [{ op: "terma", p: q, kRange: r }, []];
      } })));
      const T = new Float64Array(nz * slab), De = new Float64Array(nz * slab);
      parts.forEach((r, c) => { T.set(r.T, ranges[c][0] * slab); De.set(r.De, ranges[c][0] * slab); });
      return [{ T, De }];
    }
    rasterize(structure, grid) {
      const s = { name: structure.name, contours: structure.contours };
      return this.run({ build: () => [{ op: "rast", structure: s, grid: grid.toObj() }, []] });
    }
    async gamma(ref, refGrid, ev, evGrid, settings, mask, rx) {
      const s = settings;
      const prep = M.gammaPrepare(ref, refGrid, s, mask, rx);
      const N = prep.dref.length;
      const out = new Float64Array(N);
      const nch = Math.min(Math.max(1, this.n * 4), Math.max(1, N));
      const tasks = [];
      for (let c = 0; c < nch; c++) {
        const p0 = Math.floor(c * N / nch), p1 = Math.floor((c + 1) * N / nch);
        if (p1 <= p0) continue;
        tasks.push(this.run({ build: w => {
          const deId = this._ensure(w, ev);
          return [{ op: "gamma", pts: prep.pts.slice(3 * p0, 3 * p1), dref: prep.dref.slice(p0, p1), deId,
                    eShape: evGrid.shape, eOrg: Array.from(evGrid.origin), eSp: Array.from(evGrid.spacing),
                    offs: prep.offs, d2: prep.d2, dta: +s.dta_mm, ddAbs: s.dose_pct / 100.0 * prep.norm, local: !!s.local,
                    ddFrac: s.dose_pct / 100.0, gcap2: s.max_gamma ** 2 }, []];
        } }).then(r => out.set(r, p0)));
      }
      await Promise.all(tasks);
      return M.gammaFinish(prep, out, ref.length, s);
    }
  }
  M.Pool = Pool;

  // Backend del motor: superposición en GPU (si está validada) o en los subhilos
  class Backend {
    constructor(pool, gpu, label, note) {
      this.pool = pool; this.gpu = gpu || null; this.label = label || ""; this.note = note || "";
      this.failed = null; this.warnings = [];
    }
    get isGpu() { return !!this.gpu && !this.failed; }
    cpuLabel() { return `CPU (JavaScript, ${this.pool.n} ${this.pool.n === 1 ? "hilo" : "hilos"})`; }
    describe() {
      if (this.gpu && this.failed) return `${this.cpuLabel()}; la GPU falló en esta sesión: ${this.failed}`;
      if (!this.gpu) return this.cpuLabel() + (this.note ? `; ${this.note}` : "");
      return this.label;
    }
    short() { return this.isGpu ? this.label : this.cpuLabel(); }
    async superpose(...args) {
      if (this.isGpu) {
        try { return await this.gpu.superpose(...args); }
        catch (e) {
          this.failed = `${e.name || "Error"}: ${e.message || e}`;
          this.warnings.push(`La GPU ha fallado (${this.failed}); el resto del cálculo se ha hecho en la CPU`);
        }
      }
      return this.pool.superpose(...args);
    }
    termaMany(list) { return this.pool.termaMany(list); }
    release() { this.pool.release(); }
  }
  M.Backend = Backend;
});

// --------------------------------------------------------------------------- coordinador
CI_HILOS_MODULOS.push(function CIHilo_coordinador(M, self) {
  "use strict";
  let pool = null, gpuMode = "auto", registry = {}, backendCache = new Map(), cancelFlag = false;
  const post = (m, t) => self.postMessage(m, t || []);
  const log = (job, msg) => post({ job, type: "progress", msg });
  const fracMsg = (job, f) => post({ job, type: "fraction", f });
  function checkCancel() { if (cancelFlag) throw new M.Cancelled(); }

  async function listGpus() {
    try { return await M.GPU.listDevices(); } catch (e) { return [[], String(e.message || e)]; }
  }
  async function cpuSuperpose(...args) { return pool.superpose(...args); }
  async function makeBackend(mode, progress) {
    if (mode === "cpu") return new M.Backend(pool, null, "", "elegido en los ajustes");
    let [devs, reason] = await listGpus();
    if (mode !== "auto") {
      devs = devs.filter(d => d.info.name === mode);
      if (!devs.length) return new M.Backend(pool, null, "", `no se encuentra la GPU «${mode}» (${reason || "otro modelo"})`);
    }
    if (!devs.length) return new M.Backend(pool, null, "", reason);
    const cands = [], notes = [];
    for (const d of devs) {
      let rec = registry[d.info.key];
      if (!rec) {
        rec = await M.GPU.selfTest(d, cpuSuperpose, progress);
        registry[d.info.key] = rec;
        post({ type: "gpu_registry", registry });
      }
      const ok = rec.valida && !rec.error && (mode !== "auto" || rec.mas_rapida);
      if (ok) cands.push([rec.t_gpu_s, d]); else notes.push(`${d.info.name}: ${M.GPU.describeRecord(rec)}`);
    }
    if (!cands.length) return new M.Backend(pool, null, "", notes.join("; "));
    cands.sort((a, b) => a[0] - b[0]);
    const d = cands[0][1];
    try {
      const g = await new M.GPU.Superposer(d.adapter).init();
      return new M.Backend(pool, g, `GPU ${d.info.name} (WebGPU, ${M.GPU.PRECISION})`);
    } catch (e) {
      return new M.Backend(pool, null, "", `no se puede iniciar la GPU ${d.info.name} (${e.message || e})`);
    }
  }
  async function getBackend(mode, progress) {
    mode = mode || gpuMode;
    if (!backendCache.has(mode)) backendCache.set(mode, await makeBackend(mode, progress));
    return backendCache.get(mode);
  }
  async function readDs(f) {
    const buf = new Uint8Array(await f.arrayBuffer());
    return M.dcmread(buf, { force: true });
  }

  const handlers = {
    async init(msg) {
      M.initDatos(msg.datos);
      pool = new M.Pool(msg.ports);
      gpuMode = msg.gpuMode || "auto";
      registry = msg.registry || {};
      if (msg.allowSoftwareGpu) M.GPU.allowFallback = true;   // solo para pruebas (GPU emulada)
      if (msg.poolBudget) pool.budget = msg.poolBudget;        // solo para pruebas
      return { threads: pool.n };
    },
    async setGpuMode(msg) { gpuMode = msg.mode || "auto"; return true; },
    async gpuStatus(msg) {
      const [devs, reason] = await listGpus();
      return { devices: devs.map(d => ({ name: d.info.name, key: d.info.key, rec: registry[d.info.key] || null,
                                         describe: M.GPU.describeRecord(registry[d.info.key]) })), reason };
    },
    async gpuCheck(msg, job) {
      const [devs] = await listGpus();
      for (const d of devs) {
        registry[d.info.key] = await M.GPU.selfTest(d, cpuSuperpose, m => log(job, m));
      }
      post({ type: "gpu_registry", registry });
      backendCache.clear();
      const b = await getBackend(msg.mode, m => log(job, m));
      return { inUse: b.short(), describe: b.describe() };
    },
    async backendInfo(msg, job) {
      const b = await getBackend(msg.mode, m => log(job, m));
      return { inUse: b.short(), describe: b.describe() };
    },
    async warmup() {
      // cálculo mínimo para que el motor esté listo
      const m = M.BeamModel.fromJSON(M.DATOS_MODELO_GENERICO);
      const eng = new M.DoseEngine(m, M.CalcOptions(), M.EDK, new M.Backend(pool, null));
      const g = M.waterGrid(10.0, 100.0, 100.0);
      await M.computeWater(eng, m, M.squareBeam(40.0), g);
      return true;
    },
    async calibrar(msg, job) {
      if (msg.debug) {
        pool.debug = true; if (msg.forceW) pool.forceW = msg.forceW; pool.sequential = !!msg.sequential;
        for (const k of ["superpose", "termaMany"]) {
          const orig = pool[k].bind(pool);
          pool[k] = async (...a) => { const t0 = performance.now(); const r = await orig(...a); log(job, `${k} ${(performance.now() - t0).toFixed(0)} ms`); return r; };
        }
      }
      const model = M.BeamModel.fromJSON(msg.model);
      const b = await getBackend(msg.gpuMode, m => log(job, m));
      const eng = new M.DoseEngine(model, M.CalcOptions(), M.EDK, b);
      eng.cancel = checkCancel;
      await M.calibrate(model, msg.grid, eng);
      pool.release();
      return { model: model.toJSON(), cgy: model.calibration.cgy_per_unit };
    },
    async verificar(msg, job) {
      const progress = m => log(job, m);
      progress("Leyendo DICOM");
      const ct = [];
      for (let q = 0; q < msg.files.ct.length; q++) { ct.push(await readDs(msg.files.ct[q])); checkCancel(); }
      const inp = { ct, rtstruct: { ds: await readDs(msg.files.rtstruct.file), path: msg.files.rtstruct.path },
                    rtplan: { ds: await readDs(msg.files.rtplan.file), path: msg.files.rtplan.path },
                    rtdose: [] };
      for (const d of msg.files.rtdose) inp.rtdose.push({ ds: await readDs(d.file), path: d.path });
      const cfg = M.CheckConfig(msg.config);
      const curve = msg.curve ? M.HUEDCurve.fromCSV(msg.curve.text, msg.curve.name) : null;
      const models = new Map();
      const cacheByName = new Map();
      for (const [num, mm] of Object.entries(msg.models || {})) {
        if (!cacheByName.has(mm.file)) cacheByName.set(mm.file, M.BeamModel.fromJSON(mm.json));
        models.set(+num, cacheByName.get(mm.file));
      }
      const backend = await getBackend(cfg.options.gpu, progress);
      const res = await M.runCheck(inp, cfg, curve, models, [], {
        progress, fraction: f => fracMsg(job, f), cancel: checkCancel, backend, edk: M.EDK,
        rast: (s, g) => pool.rasterize(s, g),
        gamma: (ref, rg, ev, eg, s, mask, rx) => pool.gamma(ref, rg, ev, eg, s, mask, rx),
      });
      pool.release();
      progress("Generando resultados");
      const rtdose = cfg.save_rtdose ? M.resultRTDose(res) : null;
      const summary = M.summaryJSON(res);
      // datos para la interfaz y el informe
      const masks = [];
      for (const [name, m] of res.masks) masks.push([name, m]);
      const out = {
        plan: res.plan.toObj(), tps_grid: res.tps_grid.toObj(), tps_dose: res.tps_dose, calc_dose: res.calc_dose,
        ct_on_grid: res.ct_on_grid, masks,
        structures: res.structures.map(s => ({ number: s.number, name: s.name, type: s.type, color: s.color,
                                               rel_elec_density: s.rel_elec_density })),
        gamma: { gamma: res.gamma.gamma, evaluated: res.gamma.evaluated, norm_gy: res.gamma.norm_gy,
                 settings: res.gamma.settings, stats: res.gamma.stats },
        gamma_struct: res.gamma_struct, dvh_tps: res.dvh_tps, dvh_calc: res.dvh_calc,
        beams: res.beams.map(b => Object.assign({}, b, { dose_gy: undefined })), warnings: res.warnings,
        info: Object.assign({}, res.info, { tps_grid: res.info.tps_grid.toObj(), calc_grid: res.info.calc_grid.toObj() }),
        curve: { name: res.curve.name, table: res.curve.table() }, config: res.config, rtdose, summary,
      };
      const transfer = [out.tps_dose.buffer, out.calc_dose.buffer, out.ct_on_grid.buffer, out.gamma.gamma.buffer,
                        out.gamma.evaluated.buffer];
      for (const [, m] of masks) if (transfer.indexOf(m.buffer) < 0) transfer.push(m.buffer);
      if (rtdose) transfer.push(rtdose.buffer);
      return [out, transfer];
    },
    async comisionar(msg, job) {
      const backend = await getBackend(msg.gpuMode, m => log(job, m));
      const r = await M.runCommissioning(msg, {
        progress: m => log(job, m), fraction: f => fracMsg(job, f), cancel: checkCancel, backend });
      pool.release();
      return r;
    },
  };

  self.onmessage = async ev => {
    const msg = ev.data;
    if (msg.op === "cancel") { cancelFlag = true; if (pool) pool.cancelled = true; return; }
    const job = msg.job;
    cancelFlag = false;
    if (pool) pool.cancelled = false;
    try {
      const h = handlers[msg.op];
      if (!h) throw new Error("operación desconocida " + msg.op);
      let r = await h(msg, job);
      let transfer = [];
      if (Array.isArray(r) && r.length === 2 && Array.isArray(r[1]) && msg.op === "verificar") { transfer = r[1]; r = r[0]; }
      post({ job, type: "done", result: r }, transfer);
    } catch (e) {
      if (pool) { try { pool.release(); } catch (e2) { /* */ } }
      post({ job, type: e && e.cancelled ? "cancelled" : "error", error: String(e && e.message || e),
             stack: e && e.stack, keyError: !!(e && e.isKeyError) });
    }
  };
});

// --------------------------------------------------------------------------- hilo principal
var CIHilos = (function () {
  "use strict";
  function moduleSource() {
    return CI_MOTOR_MODULOS.map(f => f.toString()).join(",\n");
  }
  function hiloSource(name) {
    const f = CI_HILOS_MODULOS.find(x => x.name === name);
    return f.toString();
  }
  let urls = null;
  function blobURLs() {
    if (urls) return urls;
    const mods = moduleSource();
    const sub = `"use strict";
const MODS = [${mods}];
const M = {};
for (const f of MODS) f(M);
self.onmessage = ev => {
  if (ev.data && ev.data.op === "init") {
    M.initDatos(ev.data.datos);
    (${hiloSource("CIHilo_sub")})(M, ev.data.port);
  }
};`;
    const coord = `"use strict";
const MODS = [${mods}];
const M = {};
for (const f of MODS) f(M);
(${hiloSource("CIHilo_pool")})(M);
(${hiloSource("CIHilo_coordinador")})(M, self);`;
    urls = { sub: URL.createObjectURL(new Blob([sub], { type: "text/javascript" })),
             coord: URL.createObjectURL(new Blob([coord], { type: "text/javascript" })) };
    return urls;
  }

  class Cliente {
    constructor(nThreads, opts) {
      opts = opts || {};
      const u = blobURLs();
      this.n = Math.max(1, nThreads | 0);
      this.subs = [];
      const ports = [];
      for (let w = 0; w < this.n; w++) {
        const sw = new Worker(u.sub);
        const ch = new MessageChannel();
        sw.postMessage({ op: "init", datos: CI_DATOS, port: ch.port2 }, [ch.port2]);
        this.subs.push(sw);
        ports.push(ch.port1);
      }
      this.coord = new Worker(u.coord);
      this.jobs = new Map();
      this.nextJob = 1;
      this.onRegistry = opts.onRegistry || null;
      this.coord.onmessage = ev => this._msg(ev.data);
      // Si un hilo no se puede crear o falla, los trabajos pendientes terminan con error (no se queda esperando)
      const fail = ev => {
        console.error("Error en un hilo de cálculo", ev.message || ev);
        const e = new Error(`Error en los hilos de cálculo (Web Workers): ${ev.message || "el navegador no los ha podido crear"}`);
        for (const j of this.jobs.values()) j.reject(e);
        this.jobs.clear();
      };
      this.coord.onerror = fail;
      for (const sw of this.subs) sw.onerror = fail;
      this.ready = this.call("init", { datos: CI_DATOS, ports, gpuMode: opts.gpuMode || "auto", registry: opts.registry || {},
                                          allowSoftwareGpu: !!(typeof window !== "undefined" && window.CI_GPU_SOFTWARE),
                                          poolBudget: (typeof window !== "undefined" && window.CI_POOL_BUDGET) || 0 },
                             null, ports);
    }
    _msg(m) {
      if (m.type === "gpu_registry") { if (this.onRegistry) this.onRegistry(m.registry); return; }
      const j = this.jobs.get(m.job);
      if (!j) return;
      if (m.type === "progress") { if (j.onProgress) j.onProgress(m.msg); return; }
      if (m.type === "fraction") { if (j.onFraction) j.onFraction(m.f); return; }
      this.jobs.delete(m.job);
      if (m.type === "done") j.resolve(m.result);
      else if (m.type === "cancelled") { const e = new Error("Cálculo cancelado"); e.cancelled = true; j.reject(e); }
      else { const e = new Error(m.error); e.stack2 = m.stack; e.keyError = m.keyError; j.reject(e); }
    }
    call(op, args, handlers, transfer) {
      const job = this.nextJob++;
      handlers = handlers || {};
      return new Promise((resolve, reject) => {
        this.jobs.set(job, { resolve, reject, onProgress: handlers.onProgress, onFraction: handlers.onFraction });
        this.coord.postMessage(Object.assign({ op, job }, args || {}), transfer || []);
      });
    }
    cancel() { this.coord.postMessage({ op: "cancel" }); }
    terminate() {
      this.coord.terminate();
      for (const s of this.subs) s.terminate();
    }
  }
  return { Cliente, blobURLs };
})();
