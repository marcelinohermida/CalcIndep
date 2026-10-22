/* CalcIndep web · ajustes y biblioteca (modelos, curvas, comisionado y resultados).
 * La biblioteca puede estar en el almacenamiento del navegador (IndexedDB, en cualquier navegador)
 * o en una carpeta del disco o de la red (Chrome/Edge, API File System Access), con la misma
 * estructura que la versión de escritorio: modelos/, curvas_hu/, comisionado/, resultados/.
 */
var CIAlmacen = (function () {
  "use strict";
  const DB_NAME = "calcindep_web", DB_VER = 1;
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("files")) d.createObjectStore("files");
        if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      const r = fn(s);
      if (r && "onsuccess" in r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  // memoria de respaldo si IndexedDB no está disponible (ventana privada, file:// en algunos navegadores)
  const mem = { files: new Map(), kv: new Map() };
  let idbOk = true;
  async function kvGet(k) {
    if (idbOk) { try { return await tx("kv", "readonly", s => s.get(k)); } catch (e) { idbOk = false; } }
    return mem.kv.get(k);
  }
  async function kvSet(k, v) {
    if (idbOk) { try { await tx("kv", "readwrite", s => s.put(v, k)); return; } catch (e) { idbOk = false; } }
    mem.kv.set(k, v);
  }

  // ------------------------------------------------------------------ ajustes
  const DEFAULTS = {
    library_mode: "navegador",       // "navegador" o "carpeta"
    library_name: "",                // nombre de la carpeta elegida (solo para mostrarlo)
    results_mode: "biblioteca",      // "biblioteca" o "carpeta"
    results_name: "",
    threads: 0, gpu_mode: "auto",
    fluence_res_mm: 0.5, max_gantry_step_deg: 2.0, sector_deg: 10.0, trace_full_ct: true, margin_mm: 20.0,
    last_folder: "", last_curve: "", gamma_dose_pct: 3.0, gamma_dta_mm: 2.0, gamma_local: false,
    gamma_threshold_pct: 10.0, gamma_normalization: "max", gamma_reference: "tps", pass_threshold_pct: 95.0,
    outside_air: true, keep_support: true, calc_spacing_mm: 0.0, save_rtdose: true,
    scanner_curves: {}, model_choice: {}, default_model: "", last_commission_dir: "",
  };
  class Settings {
    constructor(d) { Object.assign(this, JSON.parse(JSON.stringify(DEFAULTS)), d || {}); }
    static async load() {
      let d = null;
      try { d = await kvGet("ajustes"); } catch (e) { d = null; }
      if (!d) { try { const t = localStorage.getItem("calcindep_ajustes"); if (t) d = JSON.parse(t); } catch (e) { d = null; } }
      const s = new Settings();
      if (d) for (const k of Object.keys(d)) if (k in DEFAULTS) s[k] = d[k];
      return s;
    }
    toDict() { const o = {}; for (const k of Object.keys(DEFAULTS)) o[k] = this[k]; return o; }
    async save() {
      const d = this.toDict();
      await kvSet("ajustes", d);
      try { localStorage.setItem("calcindep_ajustes", JSON.stringify(d)); } catch (e) { /* sin almacenamiento local */ }
    }
    toJSON() { return CIApp.M.pyJSON(this.toDict(), new Set(["threads"])); }
  }

  // ------------------------------------------------------------------ biblioteca
  const fsaOk = () => typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

  class BrowserStore {
    constructor(prefix) { this.prefix = prefix || ""; this.kind = "navegador"; }
    key(p) { return this.prefix + p; }
    async list(dir) {
      const pre = this.key(dir.replace(/\/?$/, "/"));
      let keys;
      if (idbOk) {
        try { keys = await tx("files", "readonly", s => s.getAllKeys()); } catch (e) { idbOk = false; }
      }
      if (!idbOk) keys = Array.from(mem.files.keys());
      const names = new Set();
      for (const k of keys) if (k.startsWith(pre)) names.add(k.slice(pre.length).split("/")[0]);
      return Array.from(names).sort((a, b) => a.localeCompare(b));
    }
    async listFiles(dir) {
      const pre = this.key(dir.replace(/\/?$/, "/"));
      let keys;
      if (idbOk) { try { keys = await tx("files", "readonly", s => s.getAllKeys()); } catch (e) { idbOk = false; } }
      if (!idbOk) keys = Array.from(mem.files.keys());
      return keys.filter(k => k.startsWith(pre) && k.slice(pre.length).indexOf("/") < 0).map(k => k.slice(pre.length)).sort();
    }
    async read(p) {
      let v;
      if (idbOk) { try { v = await tx("files", "readonly", s => s.get(this.key(p))); } catch (e) { idbOk = false; } }
      if (!idbOk) v = mem.files.get(this.key(p));
      if (v === undefined) throw new Error(`No existe ${p}`);
      return v instanceof Blob ? v : new Blob([v]);
    }
    async readText(p) { return await (await this.read(p)).text(); }
    async exists(p) {
      let v;
      if (idbOk) { try { v = await tx("files", "readonly", s => s.getKey(this.key(p))); } catch (e) { idbOk = false; } }
      if (!idbOk) v = mem.files.has(this.key(p)) ? p : undefined;
      return v !== undefined;
    }
    async write(p, data) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      if (idbOk) { try { await tx("files", "readwrite", s => s.put(blob, this.key(p))); return; } catch (e) { idbOk = false; } }
      mem.files.set(this.key(p), blob);
    }
    async remove(p) {
      if (idbOk) { try { await tx("files", "readwrite", s => s.delete(this.key(p))); return; } catch (e) { idbOk = false; } }
      mem.files.delete(this.key(p));
    }
    describe() { return "almacenamiento del navegador"; }
  }

  class FolderStore {
    constructor(handle) { this.root = handle; this.kind = "carpeta"; }
    async dir(path, create) {
      let h = this.root;
      for (const part of path.split("/").filter(Boolean)) h = await h.getDirectoryHandle(part, { create: !!create });
      return h;
    }
    split(p) { const i = p.lastIndexOf("/"); return i < 0 ? ["", p] : [p.slice(0, i), p.slice(i + 1)]; }
    async list(dir) {
      const out = [];
      let h;
      try { h = await this.dir(dir, false); } catch (e) { return []; }
      for await (const [name] of h.entries()) out.push(name);
      return out.sort((a, b) => a.localeCompare(b));
    }
    async listFiles(dir) {
      const out = [];
      let h;
      try { h = await this.dir(dir, false); } catch (e) { return []; }
      for await (const [name, e] of h.entries()) if (e.kind === "file") out.push(name);
      return out.sort((a, b) => a.localeCompare(b));
    }
    async read(p) {
      const [d, f] = this.split(p);
      const fh = await (await this.dir(d, false)).getFileHandle(f);
      return await fh.getFile();
    }
    async readText(p) { return await (await this.read(p)).text(); }
    async exists(p) { try { await this.read(p); return true; } catch (e) { return false; } }
    async write(p, data) {
      const [d, f] = this.split(p);
      const fh = await (await this.dir(d, true)).getFileHandle(f, { create: true });
      const w = await fh.createWritable();
      await w.write(data instanceof Blob ? data : new Blob([data]));
      await w.close();
    }
    async remove(p) {
      const [d, f] = this.split(p);
      await (await this.dir(d, false)).removeEntry(f, { recursive: true });
    }
    describe() { return `carpeta «${this.root.name}»`; }
  }

  async function verifyPermission(handle, ask) {
    const opts = { mode: "readwrite" };
    if (!handle.queryPermission) return true;
    if ((await handle.queryPermission(opts)) === "granted") return true;
    if (ask && (await handle.requestPermission(opts)) === "granted") return true;
    return false;
  }

  // Biblioteca activa
  class Library {
    constructor(settings) { this.settings = settings; this.store = new BrowserStore("lib/"); this.results = null; this.pending = null; }
    get models_dir() { return "modelos"; }
    get curves_dir() { return "curvas_hu"; }
    get commissioning_dir() { return "comisionado"; }
    // Abre la biblioteca según los ajustes. Devuelve null o un texto si falta permiso para la carpeta.
    async open(askPermission) {
      const s = this.settings;
      this.pending = null;
      this.store = new BrowserStore("lib/");
      if (s.library_mode === "carpeta") {
        const h = await kvGet("handle_biblioteca");
        if (h && fsaOk()) {
          if (await verifyPermission(h, askPermission)) this.store = new FolderStore(h);
          else this.pending = "biblioteca";
        } else { s.library_mode = "navegador"; }
      }
      this.results = null;
      if (s.results_mode === "carpeta") {
        const h = await kvGet("handle_resultados");
        if (h && fsaOk()) {
          if (await verifyPermission(h, askPermission)) this.results = new FolderStore(h);
          else this.pending = this.pending || "resultados";
        } else s.results_mode = "biblioteca";
      }
      await this.ensure();
      return this.pending;
    }
    resultsStore() { return this.results || this.store; }
    resultsPrefix() { return this.results ? "" : "resultados/"; }
    describe() { return this.store.describe(); }
    describeResults() {
      return this.results ? this.results.describe() : `subcarpeta «resultados» de la biblioteca (${this.store.describe()})`;
    }
    async ensure() {
      const st = this.store;
      if (!(await st.listFiles(this.models_dir)).some(f => f.toLowerCase().endsWith(".json")))
        await st.write(`${this.models_dir}/generico_6X.json`, CI_DATOS.modelo_generico);
      if (!(await st.listFiles(this.curves_dir)).some(f => f.toLowerCase().endsWith(".csv")))
        await st.write(`${this.curves_dir}/curva_ejemplo.csv`, CI_DATOS.curva_ejemplo);
    }
    async listModels() {
      const M = CIApp.M;
      const out = new Map();
      for (const f of await this.store.listFiles(this.models_dir)) {
        if (!f.toLowerCase().endsWith(".json")) continue;
        try { out.set(f, M.BeamModel.fromJSON(await this.store.readText(`${this.models_dir}/${f}`))); } catch (e) { /* se omite */ }
      }
      return out;
    }
    async modelText(f) { return this.store.readText(`${this.models_dir}/${f}`); }
    async saveModel(f, model) { await this.store.write(`${this.models_dir}/${f}`, model.toJSON()); }
    async listCurves() {
      return (await this.store.listFiles(this.curves_dir)).filter(f => /\.csv$/i.test(f));
    }
    async curveText(f) { return this.store.readText(`${this.curves_dir}/${f}`); }
    async loadCurve(f) { return CIApp.M.HUEDCurve.fromCSV(await this.curveText(f), f); }
    async uniqueName(dir, stem, ext) {
      const names = new Set((await this.store.listFiles(dir)).map(n => n.toLowerCase()));
      let name = `${safeName(stem)}${ext}`;
      let i = 2;
      while (names.has(name.toLowerCase())) { name = `${safeName(stem)}_${i}${ext}`; i++; }
      return name;
    }
    // Resultados: lista de carpetas con sus ficheros
    async listResults() {
      const st = this.resultsStore(), pre = this.resultsPrefix();
      const dirs = await st.list(pre.replace(/\/$/, "") || "");
      const out = [];
      for (const d of dirs) {
        const files = await st.listFiles(pre + d);
        if (files.length) out.push({ name: d, files });
      }
      return out.sort((a, b) => b.name.localeCompare(a.name));
    }
    async writeResult(dir, name, data) { await this.resultsStore().write(`${this.resultsPrefix()}${dir}/${name}`, data); }
    async readResult(dir, name) { return this.resultsStore().read(`${this.resultsPrefix()}${dir}/${name}`); }
    async removeResult(dir) {
      const st = this.resultsStore(), pre = this.resultsPrefix();
      if (st.kind === "carpeta") { await st.remove(`${pre}${dir}`); return; }
      for (const f of await st.listFiles(pre + dir)) await st.remove(`${pre}${dir}/${f}`);
    }
    // Todos los ficheros de la biblioteca (para exportarla)
    async allFiles() {
      const st = this.store;
      const out = [];
      for (const d of [this.models_dir, this.curves_dir]) for (const f of await st.listFiles(d)) out.push(`${d}/${f}`);
      for (const sub of await st.list(this.commissioning_dir)) {
        const files = await st.listFiles(`${this.commissioning_dir}/${sub}`);
        if (files.length) for (const f of files) out.push(`${this.commissioning_dir}/${sub}/${f}`);
        else out.push(`${this.commissioning_dir}/${sub}`);
      }
      return out.filter(p => !p.endsWith("/"));
    }
  }

  async function chooseFolder(key) {
    if (!fsaOk()) throw new Error("Este navegador no permite elegir carpetas del disco (use Chrome o Edge).");
    const h = await window.showDirectoryPicker({ id: key, mode: "readwrite" });
    await kvSet(key === "resultados" ? "handle_resultados" : "handle_biblioteca", h);
    return h;
  }
  // Carpeta del último plan leído (solo Chrome/Edge)
  async function saveHandle(k, h) { await kvSet(k, h); }
  async function getHandle(k) { return kvGet(k); }

  function safeName(s, maxlen) {
    maxlen = maxlen || 60;
    let t = String(s).replace(/[^\p{L}\p{N}_\-.]+/gu, "_").replace(/^[_.]+|[_.]+$/g, "");
    return (t || "sin_nombre").slice(0, maxlen);
  }

  // ------------------------------------------------------------------ registro de errores
  async function logError(text) {
    try {
      const prev = (await kvGet("registro")) || [];
      prev.push(`${new Date().toISOString()} ${text}`);
      await kvSet("registro", prev.slice(-200));
    } catch (e) { /* sin registro */ }
  }
  async function readLog() { return (await kvGet("registro")) || []; }

  // ¿Se guarda de forma permanente? (IndexedDB disponible)
  async function storageOk() {
    try { await kvSet("_prueba", 1); } catch (e) { /* respaldo en memoria */ }
    if (idbOk) { try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* opcional */ } }
    return idbOk;
  }
  return { Settings, Library, BrowserStore, FolderStore, chooseFolder, fsaOk, safeName, kvGet, kvSet, storageOk,
           logError, readLog, saveHandle, getHandle, verifyPermission, DEFAULTS };
})();
