/* CalcIndep web · componentes comunes de la interfaz: diálogos, tablas, formularios, progreso,
 * registro, selección de ficheros y carpetas, descargas y menús. */
var CIUI = (function () {
  "use strict";

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (k === "html") e.innerHTML = v;
      else if (v === true) e.setAttribute(k, "");
      else e.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }
  const $ = (sel, root) => (root || document).querySelector(sel);

  // ------------------------------------------------------------------ formato
  function duration(s) {
    s = Math.round(s);
    if (s < 60) return `${s} s`;
    let m = Math.floor(s / 60); s = s % 60;
    if (m < 60) return `${m} min ${String(s).padStart(2, "0")} s`;
    const h = Math.floor(m / 60); m = m % 60;
    return `${h} h ${String(m).padStart(2, "0")} min`;
  }
  function fmt(v, nd) {
    nd = nd === undefined ? 2 : nd;
    if (v === null || v === undefined || v !== v) return "–";
    if (typeof v !== "number") return String(v);
    return CIApp.M.fmtF(v, nd);
  }
  function parseNum(text, name, lo, hi) {
    const t = String(text).trim().replace(",", ".");
    const v = CIApp.M.pyParseFloat(t);
    if (v === null || v !== v) throw new Error(`«${name}» debe ser un número (valor actual: «${text}»)`);
    const G = CIApp.M.fmtG;
    if (lo !== undefined && lo !== null && v < lo) throw new Error(`«${name}» debe ser ≥ ${G(lo)}`);
    if (hi !== undefined && hi !== null && v > hi) throw new Error(`«${name}» debe ser ≤ ${G(hi)}`);
    return v;
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  }

  // ------------------------------------------------------------------ diálogos
  const modalStack = [];
  function modal(title, body, buttons, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      const box = el("div", { class: "modal" + (opts.wide ? " wide" : ""), role: "dialog", "aria-modal": "true" });
      const back = el("div", { class: "modal-back" }, box);
      const close = v => { back.remove(); modalStack.pop(); resolve(v); };
      const head = el("div", { class: "modal-head" }, el("span", null, title),
                      el("button", { class: "x", title: "Cerrar", onclick: () => close(opts.cancelValue) }, "×"));
      const content = el("div", { class: "modal-body" });
      if (typeof body === "string") content.appendChild(el("div", { class: "pre" }, body));
      else if (body) content.appendChild(body);
      const foot = el("div", { class: "modal-foot" });
      for (const b of buttons || []) {
        const btn = el("button", { class: b.primary ? "primary" : (b.left ? "left" : ""), onclick: async () => {
          if (b.validate) { try { const r = await b.validate(); if (r === false) return; } catch (e) { alert_(e.message); return; } }
          close(b.value);
        } }, b.label);
        foot.appendChild(btn);
      }
      box.append(head, content, foot);
      document.body.appendChild(back);
      modalStack.push(close);
      const first = box.querySelector("input, select, textarea") || foot.querySelector("button.primary") || foot.querySelector("button");
      if (first) setTimeout(() => first.focus(), 30);
      box.addEventListener("keydown", e => {
        if (e.key === "Escape") { e.stopPropagation(); close(opts.cancelValue); }
        if (e.key === "Enter" && e.target.tagName === "INPUT" && opts.enterValue !== undefined) { e.preventDefault(); close(opts.enterValue); }
      });
    });
  }
  function alert_(msg, title, kind) {
    const body = el("div", { class: "msg " + (kind || "") }, msg);
    return modal(title || (kind === "error" ? "Error" : "Aviso"), body, [{ label: "Aceptar", primary: true, value: true }],
                 { cancelValue: true, enterValue: true });
  }
  const info = (msg, title) => alert_(msg, title || "Información", "info");
  const error = (msg, title) => alert_(msg, title || "Error", "error");
  const warn = (msg, title) => alert_(msg, title || "Aviso", "warn");
  function confirm_(msg, title) {
    return modal(title || "Confirmar", el("div", { class: "msg" }, msg),
                 [{ label: "No", value: false }, { label: "Sí", primary: true, value: true }], { cancelValue: false });
  }
  async function prompt_(title, label, initial) {
    const inp = el("input", { type: "text", value: initial || "", style: { width: "100%" } });
    const body = el("div", null, el("label", { class: "plabel" }, label), inp);
    const ok = await modal(title, body, [{ label: "Cancelar", value: false }, { label: "Aceptar", primary: true, value: true }],
                           { cancelValue: false, enterValue: true });
    return ok ? inp.value.trim() : null;
  }

  // ------------------------------------------------------------------ menús emergentes
  let openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
  document.addEventListener("mousedown", e => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); });
  function popupMenu(x, y, items) {
    closeMenu();
    const m = el("div", { class: "popmenu" });
    for (const it of items) {
      if (it === "-") { m.appendChild(el("div", { class: "sep" })); continue; }
      m.appendChild(el("div", { class: "item" + (it.disabled ? " disabled" : ""), onclick: () => {
        if (it.disabled) return; closeMenu(); it.action();
      } }, it.label, it.accel ? el("span", { class: "accel" }, it.accel) : null));
    }
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, window.innerWidth - r.width - 4) + "px";
    m.style.top = Math.min(y, window.innerHeight - r.height - 4) + "px";
    openMenu = m;
  }

  // ------------------------------------------------------------------ tabla
  // columns: [{key, title, align, cls(row), editable}], opts: {select: "single"|"multi"|null, onSelect, onDblClick,
  //  onEdit(row, key, nuevo, anterior) -> bool, rowClass(row), height}
  class Table {
    constructor(columns, opts) {
      this.columns = columns; this.o = opts || {};
      this.rows = []; this.sel = new Set();
      this.wrap = el("div", { class: "tablewrap" + (this.o.cls ? " " + this.o.cls : "") });
      if (this.o.height) this.wrap.style.maxHeight = this.o.height;
      this.table = el("table", { class: "grid" });
      this.thead = el("thead");
      this.tbody = el("tbody");
      this.table.append(this.thead, this.tbody);
      this.wrap.appendChild(this.table);
      const tr = el("tr");
      for (const c of columns) tr.appendChild(el("th", { class: c.align === "right" ? "r" : (c.align === "center" ? "c" : "") }, c.title));
      this.thead.appendChild(tr);
    }
    get el() { return this.wrap; }
    setRows(rows) {
      this.rows = rows;
      this.sel = new Set(Array.from(this.sel).filter(i => i < rows.length));
      this.render();
    }
    render() {
      this.tbody.textContent = "";
      this.rows.forEach((r, i) => {
        const tr = el("tr", { class: (this.o.rowClass ? this.o.rowClass(r) || "" : "") + (this.sel.has(i) ? " sel" : "") });
        tr.dataset.i = i;
        for (const c of this.columns) {
          let v = r[c.key];
          const td = el("td", { class: (c.align === "right" ? "r" : (c.align === "center" ? "c" : "")) + (c.cellClass ? " " + (c.cellClass(r) || "") : "") });
          if (v instanceof Node) td.appendChild(v); else td.textContent = v === undefined || v === null ? "" : String(v);
          if (c.editable) td.addEventListener("dblclick", e => { e.stopPropagation(); this.edit(i, c.key, td); });
          tr.appendChild(td);
        }
        tr.addEventListener("mousedown", e => this._click(i, e));
        tr.addEventListener("dblclick", e => { if (this.o.onDblClick) this.o.onDblClick(r, i, e); });
        tr.addEventListener("contextmenu", e => { if (this.o.onContext) { e.preventDefault(); this.o.onContext(r, i, e); } });
        this.tbody.appendChild(tr);
      });
    }
    _click(i, e) {
      if (!this.o.select) return;
      if (this.o.select === "multi" && (e.ctrlKey || e.metaKey)) { if (this.sel.has(i)) this.sel.delete(i); else this.sel.add(i); }
      else if (this.o.select === "multi" && e.shiftKey && this.sel.size) {
        const last = Math.max(...this.sel); const [a, b] = [Math.min(last, i), Math.max(last, i)];
        for (let q = a; q <= b; q++) this.sel.add(q);
      } else this.sel = new Set([i]);
      this._refreshSel();
      if (this.o.onSelect) this.o.onSelect(this.selected());
    }
    _refreshSel() { Array.from(this.tbody.children).forEach((tr, i) => tr.classList.toggle("sel", this.sel.has(i))); }
    select(indices, silent) {
      this.sel = new Set(indices.filter(i => i >= 0 && i < this.rows.length));
      this._refreshSel();
      if (!silent && this.o.onSelect) this.o.onSelect(this.selected());
    }
    selected() { return Array.from(this.sel).sort((a, b) => a - b).map(i => this.rows[i]); }
    selectedIdx() { return Array.from(this.sel).sort((a, b) => a - b); }
    edit(i, key, td) {
      const r = this.rows[i];
      const old = r[key] === undefined || r[key] === null ? "" : String(r[key]);
      const inp = el("input", { type: "text", value: old, class: "cell-edit" });
      td.textContent = "";
      td.appendChild(inp);
      inp.focus(); inp.select();
      let done = false;
      const commit = async ok => {
        if (done) return; done = true;
        const nv = inp.value;
        if (ok && nv !== old) {
          let accept = true;
          if (this.o.onEdit) accept = await this.o.onEdit(r, key, nv, old, i);
          if (accept !== false) r[key] = nv;
        }
        this.render();
      };
      inp.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); commit(true); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); commit(false); }
        else if (e.key === "Tab") { e.preventDefault(); commit(true); }
      });
      inp.addEventListener("blur", () => commit(true));
    }
  }

  // ------------------------------------------------------------------ formularios
  class Form {
    constructor(parent) { this.p = el("div", { class: "form" }); if (parent) parent.appendChild(this.p); }
    row(label, control, unit, tip) {
      const lab = el("label", { class: "flabel" }, label);
      const cell = el("div", { class: "fcell" }, control, unit ? el("span", { class: "unit" }, unit) : null);
      this.p.append(lab, cell);
      if (tip) this.p.appendChild(el("div", { class: "ftip" }, tip));
      return control;
    }
    full(node) { this.p.appendChild(el("div", { class: "ffull" }, node)); return node; }
  }
  function input(value, width, attrs) {
    return el("input", Object.assign({ type: "text", value: value === undefined ? "" : value, style: { width: (width || 7) + "em" } }, attrs || {}));
  }
  function select(options, value, width) {
    const s = el("select", { style: width ? { width: width + "em" } : null });
    for (const o of options) {
      const [v, t] = Array.isArray(o) ? o : [o, o];
      s.appendChild(el("option", { value: v }, t));
    }
    if (value !== undefined) s.value = value;
    return s;
  }
  function checkbox(label, checked, onchange) {
    const c = el("input", { type: "checkbox" });
    c.checked = !!checked;
    if (onchange) c.addEventListener("change", onchange);
    const l = el("label", { class: "check" }, c, " ", label);
    l.input = c;
    return l;
  }
  function section(title, ...children) {
    return el("fieldset", { class: "sec" }, el("legend", null, title), ...children);
  }

  // ------------------------------------------------------------------ progreso y registro
  class ProgressPanel {
    constructor() {
      this.el = el("div", { class: "progress" });
      this.bar = el("div", { class: "bar" }, el("div", { class: "fill" }));
      this.msg = el("div", { class: "pmsg" });
      this.el.append(this.bar, this.msg);
      this.t0 = null; this.text = ""; this.frac = 0; this.timer = null;
    }
    start(text) {
      this.t0 = Date.now(); this.frac = 0; this.text = text || "";
      this.bar.classList.remove("indet");
      this._set(0); this.refresh();
      clearInterval(this.timer);
      this.timer = setInterval(() => this.refresh(), 1000);
    }
    indeterminate(on) { this.bar.classList.toggle("indet", !!on); }
    _set(f) { this.bar.firstChild.style.width = (100 * f).toFixed(1) + "%"; }
    update(frac, text) {
      if (frac !== null && frac !== undefined) { this.frac = frac; this._set(frac); }
      if (text) this.text = text;
      this.refresh();
    }
    refresh() {
      if (this.t0 === null) { this.msg.textContent = this.text; return; }
      const elp = (Date.now() - this.t0) / 1000;
      let s = `${this.text}  ·  ${Math.round(this.frac * 100)}%  ·  ${duration(elp)}`;
      if (this.frac > 0.12 && this.frac < 0.995 && elp > 10) s += `  ·  quedan ~${duration(elp * (1 - this.frac) / this.frac)}`;
      this.msg.textContent = s;
    }
    finish(text) { this.t0 = null; clearInterval(this.timer); this.bar.classList.remove("indet"); this.msg.textContent = text; }
  }
  class LogBox {
    constructor() { this.el = el("div", { class: "logbox" }); }
    append(msg, tag, stamp) {
      const line = el("div", { class: "logline " + (tag || "") });
      if (stamp !== false) {
        const d = new Date();
        line.appendChild(el("span", { class: "muted" }, `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}  `));
      }
      line.appendChild(document.createTextNode(msg));
      this.el.appendChild(line);
      this.el.scrollTop = this.el.scrollHeight;
    }
    clear() { this.el.textContent = ""; }
  }

  // ------------------------------------------------------------------ ficheros
  function pickFiles(accept, multiple) {
    return new Promise(resolve => {
      const inp = el("input", { type: "file", accept: accept || "", style: { display: "none" } });
      if (multiple) inp.multiple = true;
      inp.addEventListener("change", () => { resolve(Array.from(inp.files || [])); inp.remove(); });
      document.body.appendChild(inp);
      inp.click();
    });
  }
  // Carpeta: [{path, file}] (File System Access si está, si no input webkitdirectory)
  async function pickFolder(id) {
    if (window.showDirectoryPicker) {
      let h;
      try { h = await window.showDirectoryPicker({ id: id || "dicom", mode: "read" }); }
      catch (e) { if (e.name === "AbortError") return null; throw e; }
      return { name: h.name, handle: h, files: await filesFromHandle(h) };
    }
    return new Promise(resolve => {
      const inp = el("input", { type: "file", style: { display: "none" } });
      inp.webkitdirectory = true; inp.multiple = true;
      inp.addEventListener("change", () => {
        const fl = Array.from(inp.files || []);
        inp.remove();
        if (!fl.length) { resolve(null); return; }
        const root = (fl[0].webkitRelativePath || fl[0].name).split("/")[0];
        resolve({ name: root, handle: null, files: fl.map(f => ({ path: f.webkitRelativePath || f.name, file: f })) });
      });
      document.body.appendChild(inp);
      inp.click();
    });
  }
  async function filesFromHandle(h, prefix) {
    prefix = prefix || h.name;
    const out = [];
    for await (const [name, e] of h.entries()) {
      if (e.kind === "file") out.push({ path: `${prefix}/${name}`, file: await e.getFile() });
      else out.push(...await filesFromHandle(e, `${prefix}/${name}`));
    }
    return out;
  }
  // Arrastrar y soltar una carpeta: [{path, file}]
  async function filesFromDrop(dt) {
    const out = [];
    const entries = Array.from(dt.items || []).map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    async function walk(entry, path) {
      if (entry.isFile) {
        const f = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ path: path + entry.name, file: f });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const e of batch) await walk(e, path + entry.name + "/");
        }
      }
    }
    for (const e of entries) await walk(e, "");
    const name = entries.length === 1 && entries[0].isDirectory ? entries[0].name : "carpeta";
    return { name, handle: null, files: out };
  }
  function download(name, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: type || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name, style: { display: "none" } });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  }
  function openBlob(data, type) {
    const blob = data instanceof Blob ? new Blob([data], { type: type || data.type }) : new Blob([data], { type: type || "text/html" });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank");
    if (!w) download("informe.html", blob);
    setTimeout(() => URL.revokeObjectURL(url), 600000);
  }

  // ------------------------------------------------------------------ ZIP (sin compresión)
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  async function zip(entries) {   // entries: [{path, data: Blob|string|Uint8Array}]
    const enc = new TextEncoder();
    const parts = [], central = [];
    let off = 0;
    const d = new Date();
    const dosT = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosD = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const e of entries) {
      let data = e.data;
      if (data instanceof Blob) data = new Uint8Array(await data.arrayBuffer());
      else if (typeof data === "string") data = enc.encode(data);
      const name = enc.encode(e.path);
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, dosT, true); lh.setUint16(12, dosD, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, dosT, true); ch.setUint16(14, dosD, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + data.length;
    }
    const csize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, csize, true); end.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
  }
  async function unzip(blob) {
    const b = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(b.buffer);
    let p = b.length - 22;
    while (p >= 0 && dv.getUint32(p, true) !== 0x06054b50) p--;
    if (p < 0) throw new Error("No es un fichero ZIP");
    const n = dv.getUint16(p + 10, true);
    let c = dv.getUint32(p + 16, true);
    const out = [];
    const dec = new TextDecoder();
    for (let i = 0; i < n; i++) {
      const method = dv.getUint16(c + 10, true);
      const csz = dv.getUint32(c + 20, true);
      const nl = dv.getUint16(c + 28, true), xl = dv.getUint16(c + 30, true), cl = dv.getUint16(c + 32, true);
      const lo = dv.getUint32(c + 42, true);
      const name = dec.decode(b.subarray(c + 46, c + 46 + nl));
      const lnl = dv.getUint16(lo + 26, true), lxl = dv.getUint16(lo + 28, true);
      const start = lo + 30 + lnl + lxl;
      let data = b.subarray(start, start + csz);
      if (method === 8) {
        const ds = new DecompressionStream("deflate-raw");
        data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer());
      } else if (method !== 0) throw new Error(`Compresión ZIP no admitida en ${name}`);
      if (!name.endsWith("/")) out.push({ path: name, data: new Blob([data]) });
      c += 46 + nl + xl + cl;
    }
    return out;
  }

  // ------------------------------------------------------------------ pestañas
  function tabs(container, specs, onChange) {
    const bar = el("div", { class: "subtabs" });
    const body = el("div", { class: "subtab-body" });
    const btns = specs.map((s, i) => {
      const b = el("button", { class: "subtab" + (i === 0 ? " on" : ""), onclick: () => show(i) }, s.title);
      bar.appendChild(b);
      s.el.classList.add("subpanel");
      if (i !== 0) s.el.style.display = "none";
      body.appendChild(s.el);
      return b;
    });
    function show(i) {
      specs.forEach((s, q) => { s.el.style.display = q === i ? "" : "none"; btns[q].classList.toggle("on", q === i); });
      if (onChange) onChange(i);
    }
    container.append(bar, body);
    return { show, bar, body };
  }

  return { el, $, duration, fmt, parseNum, esc, modal, alert: alert_, info, error, warn, confirm: confirm_, prompt: prompt_,
           popupMenu, closeMenu, Table, Form, input, select, checkbox, section, ProgressPanel, LogBox, pickFiles, pickFolder,
           filesFromDrop, filesFromHandle, download, openBlob, zip, unzip, tabs };
})();
