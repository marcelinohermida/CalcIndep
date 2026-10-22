/* CalcIndep web · visor de cortes (TPS, cálculo, diferencia y gamma) con perfiles, y panel de DVH (viewer.py). */
var CIVisor = (function () {
  "use strict";
  const { el } = CIUI;
  const NON_ANATOMIC = ["SUPPORT", "MARKER", "REGISTRATION", "FIXATION", "CONTROL", "BOLUS"];
  const COL_TPS = "#1f5fa8", COL_CALC = "#d62728";
  const MAX_TXT = "Maximizar visor", RESTORE_TXT = "Restaurar panel";
  const TITLES = ["Dosis TPS (Gy)", "Cálculo independiente (Gy)", "Diferencia (% de la normalización)", "Gamma"];
  const M = () => CIApp.M;

  function structList(onChange) {
    const box = el("div", { class: "structlist" });
    return {
      el: box, items: [],
      set(structs) {
        box.textContent = "";
        this.items = structs.map(s => {
          const col = `rgb(${s.color.join(",")})`;
          const it = el("div", { class: "sitem" + (NON_ANATOMIC.indexOf(s.type) < 0 ? " on" : ""), title: s.name },
                        el("span", { class: "sw", style: { background: col } }), el("span", { style: { color: col } }, s.name));
          it.addEventListener("click", e => {
            if (!(e.ctrlKey || e.metaKey || e.shiftKey) && false) this.items.forEach(x => x.el.classList.remove("on"));
            it.classList.toggle("on");
            onChange();
          });
          box.appendChild(it);
          return { s, el: it };
        });
      },
      selected() { return this.items.filter(x => x.el.classList.contains("on")).map(x => x.s); },
    };
  }

  class SliceViewer {
    constructor(onMaximize) {
      this.res = null;
      this.orient = "Axial";
      this.idx = { Axial: 0, Coronal: 0, Sagital: 0 };
      this.profiles = {};
      this.view = {};          // zoom elegido por el usuario, por orientación: {xlim, ylim}
      this.autoView = {};      // vista completa calculada en el último dibujo
      this.el = el("div", { class: "viewer" });
      const top = el("div", { class: "vbar" });
      this.radios = ["Axial", "Coronal", "Sagital"].map(o => {
        const r = el("input", { type: "radio", name: "orient" + Math.random(), value: o });
        if (o === "Axial") r.checked = true;
        r.addEventListener("change", () => { this.orient = o; this.syncScale(); this.schedule(); });
        top.appendChild(el("label", { class: "radio" }, r, " ", o));
        return r;
      });
      top.appendChild(el("button", { onclick: () => this.gotoIso() }, "Ir al isocentro"));
      top.appendChild(el("button", { onclick: () => this.gotoMax() }, "Ir al máximo de dosis"));
      this.cont = CIUI.checkbox("Contornos", true, () => this.schedule());
      top.appendChild(this.cont);
      top.appendChild(el("button", { onclick: () => { this.view[this.orient] = null; this.schedule(); }, title: "Rueda del ratón: zoom; botón derecho o Mayús + arrastrar: desplazar" }, "Restablecer zoom"));
      if (onMaximize) { this.maxBtn = el("button", { class: "right", onclick: onMaximize }, MAX_TXT); top.appendChild(this.maxBtn); }
      const top2 = el("div", { class: "vbar" });
      this.profBtn = el("button", { class: "toggle", onclick: () => this.toggleProfile() }, "Perfil");
      this.dirSel = CIUI.select(["Libre", "Horizontal", "Vertical"], "Libre", 8);
      this.dirSel.disabled = true;
      this.clearBtn = el("button", { disabled: true, onclick: () => { delete this.profiles[this.orient]; this.schedule(); } }, "Borrar perfil");
      this.sliceLbl = el("span", { class: "right muted" });
      top2.append(this.profBtn, el("span", { class: "lbl" }, "Dirección"), this.dirSel, this.clearBtn, this.sliceLbl);
      this.slider = el("input", { type: "range", min: 0, max: 1, value: 0, class: "slider" });
      this.slider.addEventListener("input", () => {
        if (!this.res) return;
        const v = +this.slider.value;
        if (v !== this.idx[this.orient]) { this.idx[this.orient] = v; this.schedule(); }
      });
      this.readout = el("div", { class: "readout" }, "Mueva el cursor sobre la imagen para ver los valores.");
      const body = el("div", { class: "vbody" });
      this.canvasWrap = el("div", { class: "vcanvas" });
      this.canvas = el("canvas");
      this.canvasWrap.appendChild(this.canvas);
      this.slist = structList(() => this.schedule());
      body.append(this.canvasWrap, el("div", { class: "vside" }, el("div", { class: "muted" }, "Estructuras"), this.slist.el));
      this.profWrap = el("div", { class: "vprof", style: { display: "none" } });
      this.profLbl = el("div", { class: "proflbl" });
      this.pcanvas = el("canvas");
      this.profWrap.append(this.profLbl, this.pcanvas);
      this.el.append(top, top2, this.slider, body, this.profWrap, this.readout);
      this.fig = new CIG.Figure(this.canvas, 600, 400);
      this.pfig = new CIG.Figure(this.pcanvas, 600, 180);
      this.cache = new Map();
      this._bindMouse();
      new ResizeObserver(() => this.schedule()).observe(this.canvasWrap);
      this.placeholder();
    }
    setMaximized(m) { if (this.maxBtn) this.maxBtn.textContent = m ? RESTORE_TXT : MAX_TXT; }
    placeholder() {
      this.res = null;
      const w = this.canvasWrap.clientWidth || 600, h = this.canvasWrap.clientHeight || 400;
      this.fig.resize(w, h);
      this.fig.clear();
      this.fig.text(w / 2, h / 2 - 8, "Sin resultados.", { align: "center", color: "#6b7280", size: 14 });
      this.fig.text(w / 2, h / 2 + 14, "Calcule un plan para ver las distribuciones.", { align: "center", color: "#6b7280", size: 14 });
      this.fig.draw();
      this.slist.set([]);
      this.profiles = {};
      this.drawProfile();
    }
    setResult(res) {
      this.res = res;
      this.cache.clear();
      this.view = {};
      this.autoView = {};
      this.profiles = {};
      const g = res.tps_grid;
      [this.x, this.y, this.z] = g.axes();
      this.norm = res.gamma.norm_gy;
      this.diff = CIInforme.diffArray(res);
      this.structs = res.structures.filter(s => { const m = res.masks.get(s.name); return m && m.some(v => v); });
      this.slist.set(this.structs);
      this.gotoIso();
    }
    isoIndex() { return CIInforme.isoIndex(this.res); }
    gotoIso() { if (this.res) this.goto(...this.isoIndex()); }
    gotoMax() { if (this.res) this.goto(...CIInforme.argmax3(this.res.tps_dose, this.res.tps_grid.shape)); }
    goto(k, j, i) { this.idx = { Axial: k, Coronal: j, Sagital: i }; this.syncScale(); this.schedule(); }
    nslices() { const sh = this.res.tps_grid.shape; return { Axial: sh[0], Coronal: sh[1], Sagital: sh[2] }[this.orient]; }
    syncScale() {
      if (!this.res) return;
      this.slider.max = Math.max(this.nslices() - 1, 0);
      this.slider.value = this.idx[this.orient];
    }
    schedule() {
      clearTimeout(this._t);
      this._t = setTimeout(() => this.draw(), 30);
    }
    coords() {
      const o = this.orient;
      if (o === "Axial") return [this.x, this.y];
      if (o === "Coronal") return [this.x, this.z];
      return [this.y, this.z];
    }
    hvNames() { return { Axial: ["x", "y"], Coronal: ["x", "z"], Sagital: ["y", "z"] }[this.orient]; }
    draw() {
      const W = Math.max(200, this.canvasWrap.clientWidth), H = Math.max(160, this.canvasWrap.clientHeight);
      if (!this.res) { this.placeholder(); return; }
      if (!this.canvasWrap.clientWidth || !this.canvasWrap.clientHeight) return;   // pestaña oculta: se dibuja al mostrarla
      this.fig.resize(W, H);
      this.fig.clear();
      const res = this.res, o = this.orient, idx = this.idx[o];
      const sel = this.cont.input.checked ? this.slist.selected() : [];
      const prof = this.profBtn.classList.contains("on") ? this.profiles[o] : null;
      const cbw = 58, padL = 46, padT = 22, gapX = 18, gapY = 30, padB = 22;
      const pw = Math.floor((W - padL - 2 * cbw - gapX - 8) / 2), ph = Math.floor((H - padT - gapY - padB - 6) / 2);
      this.axes = [];
      const kinds = ["tps", "calc", "diff", "gamma"];
      let base = null;
      kinds.forEach((kind, q) => {
        const col = q % 2, row = Math.floor(q / 2);
        const ax = this.fig.axes([padL + col * (pw + cbw + gapX), padT + row * (ph + gapY), pw, ph],
                                 { xticks: true, yticks: true, title: TITLES[q], titleSize: 12, fontSize: 9, equal: true,
                                   bg: "#000", xticklabels: row === 1, yticklabels: col === 0 });
        const key = `${o}|${idx}|${kind}|${sel.map(s => s.name).join(",")}`;
        CIInforme.slicePanel(ax, res, o, idx, kind, { diff: this.diff, structs: sel, lw: 0.9 });
        // reutiliza las imágenes ya calculadas
        const cached = this.cache.get(key);
        const imgs = ax.items.filter(it => it.type === "image");
        if (cached) imgs.forEach((it, n) => { it._canvas = cached[n]; });
        else { imgs.forEach(it => CIG.imageCanvas(it)); this.cache.set(key, imgs.map(it => it._canvas)); if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value); }
        const v = this.view[o];
        if (v) ax.set({ xlim: v.xlim, ylim: v.ylim });
        if (prof) this.drawProfileLine(ax, prof[0], prof[1]);
        if (this._drag) this.drawProfileLine(ax, this._drag.p0, this._drag.p1, true);
        const n = this.norm;
        if (kind === "tps" || kind === "calc") this.fig.colorbar(ax, { cmap: "jet", vmin: 0.1 * n, vmax: 1.1 * n, label: "Gy", fontSize: 9 });
        else if (kind === "diff") this.fig.colorbar(ax, { cmap: "RdBu_r", vmin: -5, vmax: 5, label: "%", fontSize: 9 });
        else this.fig.colorbar(ax, { cmap: "gamma", vmin: 0, vmax: 2, label: "γ", fontSize: 9 });
        this.axes.push(ax);
        if (!base) base = ax;
      });
      this.fig.draw();
      // vista común: la primera fija los límites tras el ajuste de aspecto
      this.autoView[o] = { xlim: base.xlim.slice(), ylim: base.ylim.slice() };
      const pos = { Axial: this.z, Coronal: this.y, Sagital: this.x }[o][idx];
      const axis = { Axial: "z", Coronal: "y", Sagital: "x" }[o];
      this.sliceLbl.textContent = `Corte ${idx + 1}/${this.nslices()}  ·  ${axis} = ${M().fmtF(pos, 1)} mm`;
      this.drawProfile();
    }
    drawProfileLine(ax, p0, p1, temp) {
      ax.line([p0[0], p1[0]], [p0[1], p1[1]], { color: "rgba(0,0,0,0.6)", width: 3 });
      ax.line([p0[0], p1[0]], [p0[1], p1[1]], { color: "#ffd400", width: 1.5 });
      if (!temp) { ax.marker(p0[0], p0[1], { label: "A" }); ax.marker(p1[0], p1[1], { label: "B" }); }
    }
    toggleProfile() {
      const on = !this.profBtn.classList.contains("on");
      this.profBtn.classList.toggle("on", on);
      this.dirSel.disabled = !on; this.clearBtn.disabled = !on;
      this.profWrap.style.display = on ? "" : "none";
      if (on) this.readout.textContent = "Perfil: arrastre sobre una imagen para trazar la línea (dirección «Libre»), " +
                                          "o haga clic con «Horizontal» o «Vertical».";
      this.schedule();
    }
    clipHV(x, y) {
      const [h, v] = this.coords();
      const c = (a, b, q) => Math.min(Math.max(q, Math.min(a, b)), Math.max(a, b));
      return [c(h[0], h[h.length - 1], x), c(v[0], v[v.length - 1], y)];
    }
    _bindMouse() {
      const cv = this.canvas;
      const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      const axAt = (px, py) => (this.axes || []).find(a => px >= a.x && px <= a.x + a.w && py >= a.y && py <= a.y + a.h) || null;
      cv.addEventListener("contextmenu", e => e.preventDefault());
      cv.addEventListener("wheel", e => {
        if (!this.res) return;
        const [px, py] = pos(e);
        const ax = axAt(px, py);
        if (!ax) return;
        e.preventDefault();
        const [dx, dy] = ax.inv(px, py);
        const f = e.deltaY > 0 ? 1.2 : 1 / 1.2;
        if (!this.view[this.orient]) {
          if (!this.autoView[this.orient]) return;
          this.view[this.orient] = JSON.parse(JSON.stringify(this.autoView[this.orient]));
        }
        const v = this.view[this.orient];
        v.xlim = [dx + (v.xlim[0] - dx) * f, dx + (v.xlim[1] - dx) * f];
        v.ylim = [dy + (v.ylim[0] - dy) * f, dy + (v.ylim[1] - dy) * f];
        this.schedule();
      }, { passive: false });
      cv.addEventListener("mousedown", e => {
        if (!this.res) return;
        const [px, py] = pos(e);
        const ax = axAt(px, py);
        if (!ax) return;
        if (e.button === 2 || e.button === 1 || e.shiftKey) {
          this._pan = { ax, start: ax.inv(px, py), v: JSON.parse(JSON.stringify(this.view[this.orient] || this.autoView[this.orient])) };
          return;
        }
        if (e.button !== 0 || !this.profBtn.classList.contains("on")) return;
        const [h, v] = this.coords();
        const [x, y] = this.clipHV(...ax.inv(px, py));
        const mode = this.dirSel.value, o = this.orient;
        if (mode === "Horizontal") { this.profiles[o] = [[h[0], y], [h[h.length - 1], y]]; this.schedule(); return; }
        if (mode === "Vertical") {
          const [v0, v1] = o === "Axial" ? [v[0], v[v.length - 1]] : [v[v.length - 1], v[0]];
          this.profiles[o] = [[x, v0], [x, v1]]; this.schedule(); return;
        }
        this._drag = { p0: [x, y], p1: [x, y] };
      });
      window.addEventListener("mouseup", e => {
        if (this._pan) { this._pan = null; return; }
        if (!this._drag) return;
        const d = this._drag;
        this._drag = null;
        if (Math.hypot(d.p1[0] - d.p0[0], d.p1[1] - d.p0[1]) >= 2.0) this.profiles[this.orient] = [d.p0, d.p1];
        this.schedule();
      });
      cv.addEventListener("mousemove", e => {
        if (!this.res) return;
        const [px, py] = pos(e);
        if (this._pan) {
          const ax = this._pan.ax;
          // desplazamiento en coordenadas de datos según la vista inicial
          const v0 = this._pan.v;
          const sx = (v0.xlim[1] - v0.xlim[0]) / ax.w, sy = (v0.ylim[1] - v0.ylim[0]) / ax.h;
          if (!this._pan.p) this._pan.p = [px, py];
          const ddx = (px - this._pan.p[0]) * sx, ddy = (py - this._pan.p[1]) * sy;
          this.view[this.orient] = { xlim: [v0.xlim[0] - ddx, v0.xlim[1] - ddx], ylim: [v0.ylim[0] + ddy, v0.ylim[1] + ddy] };
          this.schedule();
          return;
        }
        const ax = axAt(px, py);
        if (!ax) return;
        const [xd, yd] = ax.inv(px, py);
        if (this._drag) { this._drag.p1 = this.clipHV(xd, yd); this.schedule(); }
        this.readoutAt(xd, yd);
      });
    }
    readoutAt(xd, yd) {
      const res = this.res, g = res.tps_grid, sp = g.spacing, org = g.origin, o = this.orient;
      let k = this.idx[o], j, i;
      if (o === "Axial") { i = Math.round((xd - org[0]) / sp[0]); j = Math.round((yd - org[1]) / sp[1]); }
      else if (o === "Coronal") { i = Math.round((xd - org[0]) / sp[0]); j = k; k = Math.round((yd - org[2]) / sp[2]); }
      else { i = k; j = Math.round((xd - org[1]) / sp[1]); k = Math.round((yd - org[2]) / sp[2]); }
      const sh = g.shape;
      if (!(k >= 0 && k < sh[0] && j >= 0 && j < sh[1] && i >= 0 && i < sh[2])) return;
      const p = (k * sh[1] + j) * sh[2] + i;
      const t = res.tps_dose[p], c = res.calc_dose[p], gm = res.gamma.gamma[p];
      const Mm = M();
      const d = (c - t) / this.norm * 100.0;
      const dl = t > 0.01 * this.norm ? (c - t) / t * 100.0 : NaN;
      const sg = v => (v !== v ? "nan" : (v >= 0 ? "+" : "") + Mm.fmtF(v, 2));
      this.readout.textContent = `x = ${Mm.fmtF(this.x[i], 1)}  y = ${Mm.fmtF(this.y[j], 1)}  z = ${Mm.fmtF(this.z[k], 1)} mm   ·   ` +
        `HU ${Mm.fmtF(res.ct_on_grid[p], 0)}   ·   TPS ${Mm.fmtF(t, 3)} Gy   ·   cálculo ${Mm.fmtF(c, 3)} Gy   ·   ` +
        `dif. ${sg(d)}% (norm.)  ${sg(dl)}% (local)   ·   γ ${gm !== gm ? "–" : Mm.fmtF(gm, 2)}`;
    }
    sampleProfile() {
      const o = this.orient;
      const prof = this.profiles[o];
      if (!this.res || !prof) return null;
      const [[h0, v0], [h1, v1]] = prof;
      const g = this.res.tps_grid, sp = g.spacing, org = g.origin, sh = g.shape;
      const length = Math.hypot(h1 - h0, v1 - v0);
      const step = 0.25 * Math.min(sp[0], sp[1], sp[2]);
      const n = Math.max(2, Math.ceil(length / step) + 1);
      const Mm = M();
      const k = this.idx[o];
      const d = new Float64Array(n), tps = new Float64Array(n), calc = new Float64Array(n), diff = new Float64Array(n);
      const xs = new Float64Array(n), ys = new Float64Array(n), zs = new Float64Array(n);
      for (let q = 0; q < n; q++) {
        const t = q / (n - 1);
        const hh = h0 + t * (h1 - h0), vv = v0 + t * (v1 - v0);
        let x, y, z;
        if (o === "Axial") { x = hh; y = vv; z = this.z[k]; }
        else if (o === "Coronal") { x = hh; y = this.y[k]; z = vv; }
        else { x = this.x[k]; y = hh; z = vv; }
        xs[q] = x; ys[q] = y; zs[q] = z;
        const fi = (x - org[0]) / sp[0], fj = (y - org[1]) / sp[1], fk = (z - org[2]) / sp[2];
        const inside = fk >= -0.5 && fk <= sh[0] - 0.5 && fj >= -0.5 && fj <= sh[1] - 0.5 && fi >= -0.5 && fi <= sh[2] - 0.5;
        const a = inside ? Mm.mapCoord3(this.res.tps_dose, sh, fk, fj, fi, "nearest") : NaN;
        const b = inside ? Mm.mapCoord3(this.res.calc_dose, sh, fk, fj, fi, "nearest") : NaN;
        d[q] = t * length; tps[q] = a; calc[q] = b;
        const df = (b - a) / this.norm * 100.0;
        diff[q] = (a < 0.1 * this.norm && b < 0.1 * this.norm) ? NaN : df;
      }
      return { d, tps, calc, diff, xs, ys, zs, length, p0: [h0, v0], p1: [h1, v1] };
    }
    drawProfile() {
      if (!this.profBtn.classList.contains("on")) { this.profData = null; return; }
      const W = Math.max(200, this.profWrap.clientWidth - 4), H = 190;
      const f = this.pfig;
      f.resize(W, H);
      f.clear();
      const data = this.sampleProfile();
      this.profData = data;
      if (!data) {
        this.profLbl.textContent = "";
        f.text(W / 2, H / 2, this.res ? "Trace un perfil sobre cualquiera de las imágenes de este corte." : "Sin resultados.",
               { align: "center", color: "#6b7280", size: 13 });
        f.draw();
        return;
      }
      const Mm = M();
      const ax = f.axes([60, 30, W - 130, H - 72], { grid: true, xlabel: "Distancia desde A (mm)", ylabel: "Dosis (Gy)", fontSize: 10,
                                                      legend: "above", legendCols: 3 });
      ax.line(data.d, data.tps, { color: COL_TPS, width: 1.8, label: "TPS" });
      ax.line(data.d, data.calc, { color: COL_CALC, width: 1.8, dash: [6, 4], label: "CalcIndep" });
      let ymax = 0;
      for (const a of [data.tps, data.calc]) for (const v of a) if (v > ymax) ymax = v;
      ax.set({ xlim: [0, Math.max(data.length, 1e-6)], ylim: [0, ymax * 1.05 || 1] });
      const tw = ax.makeTwin();
      tw.line(data.d, data.diff, { color: "#6b7280", width: 0.9, alpha: 0.8, label: "Diferencia" });
      tw.hline(0, { color: "#9ca3af", width: 0.6 });
      let lim = 0;
      for (const v of data.diff) if (isFinite(v)) lim = Math.max(lim, Math.abs(v));
      lim = lim > 0 ? Math.min(Math.max(5.0, Math.ceil(lim)), 50.0) : 5.0;
      tw.set({ xlim: [0, Math.max(data.length, 1e-6)], ylim: [-lim, lim], ylabel: "Dif. (%)" });
      f.draw();
      const o = this.orient, [hn, vn] = this.hvNames(), k = this.idx[o];
      const pos = { Axial: this.z, Coronal: this.y, Sagital: this.x }[o][k];
      const axis = { Axial: "z", Coronal: "y", Sagital: "x" }[o];
      this.profLbl.textContent = `Perfil en el corte ${o.toLowerCase()} ${axis} = ${Mm.fmtF(pos, 1)} mm   ·   ` +
        `A (${hn} = ${Mm.fmtF(data.p0[0], 1)}, ${vn} = ${Mm.fmtF(data.p0[1], 1)} mm)  →  ` +
        `B (${hn} = ${Mm.fmtF(data.p1[0], 1)}, ${vn} = ${Mm.fmtF(data.p1[1], 1)} mm)   ·   longitud ${Mm.fmtF(data.length, 1)} mm` +
        `   ·   diferencia en % de la normalización (${Mm.fmtF(this.norm, 3)} Gy)`;
      if (!this._profBound) {
        this._profBound = true;
        this.pcanvas.addEventListener("mousemove", e => {
          const dd = this.profData;
          if (!dd || !this.pfig.axesList.length) return;
          const r = this.pcanvas.getBoundingClientRect();
          const a = this.pfig.axesList[0];
          const xd = a.inv(e.clientX - r.left, e.clientY - r.top)[0];
          const i = Math.min(Math.max(M().searchsorted(dd.d, xd), 0), dd.d.length - 1);
          const ff = (v, nd, sgn) => (v !== v ? "–" : (sgn && v >= 0 ? "+" : "") + M().fmtF(v, nd));
          this.readout.textContent = `Perfil: ${M().fmtF(dd.d[i], 1)} mm desde A   ·   x = ${M().fmtF(dd.xs[i], 1)}  y = ${M().fmtF(dd.ys[i], 1)}  ` +
            `z = ${M().fmtF(dd.zs[i], 1)} mm   ·   TPS ${ff(dd.tps[i], 3)} Gy   ·   CalcIndep ${ff(dd.calc[i], 3)} Gy   ·   ` +
            `dif. ${ff(dd.diff[i], 2, true)}% (norm.)`;
        });
      }
    }
  }

  class DVHPanel {
    constructor(onMaximize) {
      this.res = null;
      this.el = el("div", { class: "dvhpanel" });
      const top = el("div", { class: "vbar" });
      if (onMaximize) { this.maxBtn = el("button", { class: "right", onclick: onMaximize }, MAX_TXT); top.appendChild(this.maxBtn); }
      const body = el("div", { class: "vbody" });
      this.canvasWrap = el("div", { class: "vcanvas" });
      this.canvas = el("canvas");
      this.canvasWrap.appendChild(this.canvas);
      this.slist = structList(() => this.draw());
      body.append(this.canvasWrap, el("div", { class: "vside" }, el("div", { class: "muted" }, "Estructuras"), this.slist.el));
      this.el.append(top, body);
      this.fig = new CIG.Figure(this.canvas, 600, 400);
      this.cache = new Map();
      new ResizeObserver(() => { clearTimeout(this._t); this._t = setTimeout(() => this.draw(), 40); }).observe(this.canvasWrap);
    }
    setMaximized(m) { if (this.maxBtn) this.maxBtn.textContent = m ? RESTORE_TXT : MAX_TXT; }
    setResult(res) {
      this.res = res;
      this.cache = new Map();
      if (!res) { this.slist.set([]); this.draw(); return; }
      this.structs = res.structures.filter(s => { const m = res.masks.get(s.name); return m && m.some(v => v); });
      this.slist.set(this.structs);
      let dmax = -Infinity;
      for (const a of [res.tps_dose, res.calc_dose]) for (let p = 0; p < a.length; p++) if (a[p] > dmax) dmax = a[p];
      this.dmax = dmax;
      this.draw();
    }
    dvh(name, which) {
      const key = name + "|" + which;
      if (!this.cache.has(key)) {
        const arr = which === "tps" ? this.res.tps_dose : this.res.calc_dose;
        this.cache.set(key, M().cumulativeDVH(arr, this.res.masks.get(name), this.dmax / 500, this.dmax));
      }
      return this.cache.get(key);
    }
    draw() {
      const W = Math.max(200, this.canvasWrap.clientWidth), H = Math.max(160, this.canvasWrap.clientHeight);
      this.fig.resize(W, H);
      this.fig.clear();
      if (!this.res) { this.fig.draw(); return; }
      const ax = this.fig.axes([70, 36, W - 100, H - 90], { grid: true, xlabel: "Dosis (Gy)", ylabel: "Volumen (%)", fontSize: 12,
                                                            title: "DVH  ·  continua: TPS  ·  discontinua: CalcIndep", titleSize: 13,
                                                            legend: "upper right", legendCols: 2, legendSize: 11 });
      for (const s of this.slist.selected()) {
        const col = `rgb(${s.color.join(",")})`;
        let [d, v] = this.dvh(s.name, "tps");
        ax.line(d, v, { color: col, width: 1.8, label: s.name });
        [d, v] = this.dvh(s.name, "calc");
        ax.line(d, v, { color: col, width: 1.8, dash: [6, 4] });
      }
      ax.set({ xlim: [0, this.dmax * 1.05], ylim: [0, 102] });
      this.fig.draw();
    }
  }
  return { SliceViewer, DVHPanel };
})();
