/* CalcIndep web · gráficos en canvas (sustituye a matplotlib): ejes, líneas, barras, imágenes con
 * mapa de color, contornos de máscaras, barras de color y leyendas. */
var CIG = (function () {
  "use strict";
  const FONT = '"Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';

  // ------------------------------------------------------------------ mapas de color
  const luts = {};
  function lut(name) {
    if (luts[name]) return luts[name];
    const hex = CI_CMAPS[name];
    const n = hex.length / 6;
    const a = new Uint8Array(n * 3);
    for (let i = 0; i < n * 3; i++) a[i] = parseInt(hex.substr(2 * i, 2), 16);
    luts[name] = a;
    return a;
  }
  function cmapColor(name, t) {
    const L = lut(name), n = L.length / 3;
    const i = Math.max(0, Math.min(n - 1, Math.floor(t * n)));
    return [L[3 * i], L[3 * i + 1], L[3 * i + 2]];
  }
  const TAB10 = () => CI_CMAPS.tab10;
  function hexToRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function rgbCss(c, a) { return a === undefined ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`; }

  // ------------------------------------------------------------------ marcas "bonitas"
  function niceTicks(a, b, n) {
    n = n || 6;
    if (!(isFinite(a) && isFinite(b)) || a === b) return [a];
    if (a > b) { const t = a; a = b; b = t; }
    const span = b - a;
    const raw = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const steps = [1, 2, 2.5, 5, 10];
    let step = mag;
    for (const s of steps) { if (s * mag >= raw) { step = s * mag; break; } }
    const t0 = Math.ceil(a / step - 1e-9) * step;
    const out = [];
    for (let v = t0; v <= b + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return out;
  }
  function fmtTick(v, step) {
    const d = Math.max(0, -Math.floor(Math.log10(step || 1) + 1e-9));
    return v.toFixed(Math.min(d, 6));
  }

  // ------------------------------------------------------------------ figura
  class Figure {
    constructor(canvas, w, h, dpr) {
      this.dpr = dpr || (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
      this.canvas = canvas || document.createElement("canvas");
      this.resize(w || this.canvas.clientWidth || 600, h || this.canvas.clientHeight || 400);
      this.axesList = [];
      this.colorbars = [];
      this.texts = [];
      this.bg = "#ffffff";
    }
    resize(w, h) {
      this.w = Math.max(10, Math.round(w)); this.h = Math.max(10, Math.round(h));
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      if (this.canvas.style) { this.canvas.style.width = this.w + "px"; this.canvas.style.height = this.h + "px"; }
    }
    clear() { this.axesList = []; this.colorbars = []; this.texts = []; }
    axes(rect, opts) { const a = new Axes(this, rect, opts); this.axesList.push(a); return a; }
    colorbar(ax, opts) { const cb = Object.assign({ ax }, opts); this.colorbars.push(cb); return cb; }
    text(x, y, s, opts) { this.texts.push(Object.assign({ x, y, s }, opts || {})); }
    draw() {
      const g = this.canvas.getContext("2d");
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.fillStyle = this.bg;
      g.fillRect(0, 0, this.w, this.h);
      for (const a of this.axesList) a.draw(g);
      for (const cb of this.colorbars) drawColorbar(g, cb);
      for (const t of this.texts) {
        g.fillStyle = t.color || "#1d2433";
        g.font = `${t.bold ? "bold " : ""}${t.size || 13}px ${FONT}`;
        g.textAlign = t.align || "left";
        g.textBaseline = t.baseline || "alphabetic";
        g.fillText(t.s, t.x, t.y);
      }
    }
    toDataURL() { this.draw(); return this.canvas.toDataURL("image/png"); }
    axesAt(px, py) { return this.axesList.find(a => px >= a.x && px <= a.x + a.w && py >= a.y && py <= a.y + a.h) || null; }
  }

  class Axes {
    constructor(fig, rect, opts) {
      this.fig = fig;
      [this.x, this.y, this.w, this.h] = rect;
      this.o = Object.assign({ grid: false, xticks: true, yticks: true, fontSize: 11, frame: true }, opts || {});
      this.items = [];
      this.xlim = null; this.ylim = null;
      this.twin = null;
    }
    set(o) { Object.assign(this.o, o); if (o.xlim) this.xlim = o.xlim.slice(); if (o.ylim) this.ylim = o.ylim.slice(); return this; }
    line(x, y, o) { this.items.push(Object.assign({ type: "line", x, y }, o || {})); return this; }
    bar(x, h, o) { this.items.push(Object.assign({ type: "bar", x, h }, o || {})); return this; }
    image(o) { this.items.push(Object.assign({ type: "image" }, o)); return this; }
    contour(o) { this.items.push(Object.assign({ type: "contour" }, o)); return this; }
    hline(y, o) { this.items.push(Object.assign({ type: "hline", y }, o || {})); return this; }
    vline(x, o) { this.items.push(Object.assign({ type: "vline", x }, o || {})); return this; }
    text(x, y, s, o) { this.items.push(Object.assign({ type: "text", tx: x, ty: y, s }, o || {})); return this; }
    marker(x, y, o) { this.items.push(Object.assign({ type: "marker", mx: x, my: y }, o || {})); return this; }
    makeTwin() { this.twin = new Axes(this.fig, [this.x, this.y, this.w, this.h], { twin: true, fontSize: this.o.fontSize }); return this.twin; }
    autoscale() {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const it of this.items) {
        if (it.type === "line") {
          for (let i = 0; i < it.x.length; i++) {
            const a = it.x[i], b = it.y[i];
            if (isFinite(a) && isFinite(b)) { x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, b); y1 = Math.max(y1, b); }
          }
        } else if (it.type === "bar") {
          const bw = it.width || 0.8;
          for (let i = 0; i < it.x.length; i++) {
            x0 = Math.min(x0, it.x[i] - bw / 2); x1 = Math.max(x1, it.x[i] + bw / 2);
            y0 = Math.min(y0, 0, it.h[i]); y1 = Math.max(y1, it.h[i]);
          }
        } else if (it.type === "image") {
          const e = it.extent;
          x0 = Math.min(x0, e[0], e[1]); x1 = Math.max(x1, e[0], e[1]); y0 = Math.min(y0, e[2], e[3]); y1 = Math.max(y1, e[2], e[3]);
        }
      }
      if (!isFinite(x0)) { x0 = 0; x1 = 1; } if (!isFinite(y0)) { y0 = 0; y1 = 1; }
      if (x0 === x1) { x0 -= 0.5; x1 += 0.5; } if (y0 === y1) { y0 -= 0.5; y1 += 0.5; }
      const hasImage = this.items.some(it => it.type === "image");
      const mx = hasImage ? 0 : 0.03 * (x1 - x0), my = hasImage ? 0 : 0.05 * (y1 - y0);
      if (!this.xlim) this.xlim = [x0 - mx, x1 + mx];
      if (!this.ylim) this.ylim = [y0 - my, y1 + my];
    }
    // datos -> píxeles
    px(xv) { const [a, b] = this.xlim; return this.x + (xv - a) / (b - a) * this.w; }
    py(yv) { const [a, b] = this.ylim; return this.y + this.h - (yv - a) / (b - a) * this.h; }
    inv(px, py) {
      const [a, b] = this.xlim, [c, d] = this.ylim;
      return [a + (px - this.x) / this.w * (b - a), c + (this.y + this.h - py) / this.h * (d - c)];
    }
    fitEqual() {
      // ajusta los límites para que la escala sea igual en x e y (imágenes)
      const [a, b] = this.xlim, [c, d] = this.ylim;
      const sx = Math.abs(b - a) / this.w, sy = Math.abs(d - c) / this.h;
      const s = Math.max(sx, sy);
      const cx = (a + b) / 2, cy = (c + d) / 2;
      const hx = s * this.w / 2 * Math.sign(b - a || 1), hy = s * this.h / 2 * Math.sign(d - c || 1);
      this.xlim = [cx - hx, cx + hx]; this.ylim = [cy - hy, cy + hy];
    }
    draw(g) {
      this.autoscale();
      if (this.o.equal) this.fitEqual();
      if (this.twin) this.twin.autoscale();
      const fs = this.o.fontSize;
      g.save();
      g.beginPath();
      g.rect(this.x, this.y, this.w, this.h);
      g.clip();
      if (this.o.bg) { g.fillStyle = this.o.bg; g.fillRect(this.x, this.y, this.w, this.h); }
      // rejilla
      const xt = this.o.xticks ? niceTicks(this.xlim[0], this.xlim[1], Math.max(3, Math.round(this.w / 90))) : [];
      const yt = this.o.yticks ? niceTicks(this.ylim[0], this.ylim[1], Math.max(3, Math.round(this.h / 60))) : [];
      if (this.o.grid) {
        g.strokeStyle = "rgba(0,0,0,0.12)";
        g.lineWidth = 1;
        g.beginPath();
        for (const v of xt) { const p = Math.round(this.px(v)) + 0.5; g.moveTo(p, this.y); g.lineTo(p, this.y + this.h); }
        for (const v of yt) { const p = Math.round(this.py(v)) + 0.5; g.moveTo(this.x, p); g.lineTo(this.x + this.w, p); }
        g.stroke();
      }
      for (const it of this.items) this.drawItem(g, it);
      if (this.twin) for (const it of this.twin.items) this.twin.drawItem(g, it);
      g.restore();
      if (this.o.frame) {
        g.strokeStyle = "#5b6475";
        g.lineWidth = 1;
        g.strokeRect(Math.round(this.x) + 0.5, Math.round(this.y) + 0.5, Math.round(this.w), Math.round(this.h));
      }
      g.fillStyle = "#1d2433";
      g.font = `${fs}px ${FONT}`;
      const stepX = xt.length > 1 ? xt[1] - xt[0] : 1, stepY = yt.length > 1 ? yt[1] - yt[0] : 1;
      if (this.o.xticks && this.o.xticklabels !== false) {
        g.textAlign = "center"; g.textBaseline = "top";
        for (const v of xt) {
          const p = this.px(v);
          g.fillRect(p, this.y + this.h, 1, 4);
          g.fillText(fmtTick(v, stepX), p, this.y + this.h + 5);
        }
      }
      if (this.o.yticks && this.o.yticklabels !== false) {
        g.textAlign = "right"; g.textBaseline = "middle";
        for (const v of yt) {
          const p = this.py(v);
          g.fillRect(this.x - 4, p, 4, 1);
          g.fillText(fmtTick(v, stepY), this.x - 6, p);
        }
      }
      if (this.twin) {
        const tw = this.twin;
        const yt2 = niceTicks(tw.ylim[0], tw.ylim[1], Math.max(3, Math.round(this.h / 60)));
        const st2 = yt2.length > 1 ? yt2[1] - yt2[0] : 1;
        g.fillStyle = tw.o.tickColor || "#4b5563";
        g.textAlign = "left"; g.textBaseline = "middle";
        g.font = `${fs - 1}px ${FONT}`;
        for (const v of yt2) { const p = tw.py(v); g.fillRect(this.x + this.w, p, 4, 1); g.fillText(fmtTick(v, st2), this.x + this.w + 6, p); }
        if (tw.o.ylabel) {
          g.save(); g.translate(this.x + this.w + 44, this.y + this.h / 2); g.rotate(Math.PI / 2);
          g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(tw.o.ylabel, 0, 0); g.restore();
        }
      }
      g.fillStyle = "#1d2433";
      if (this.o.xlabel) {
        g.font = `${fs + 1}px ${FONT}`; g.textAlign = "center"; g.textBaseline = "top";
        g.fillText(this.o.xlabel, this.x + this.w / 2, this.y + this.h + (this.o.xticks ? 22 : 6));
      }
      if (this.o.ylabel) {
        g.save(); g.font = `${fs + 1}px ${FONT}`;
        g.translate(this.x - (this.o.yticks ? (this.o.ylabelOffset || 46) : 10), this.y + this.h / 2); g.rotate(-Math.PI / 2);
        g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(this.o.ylabel, 0, 0); g.restore();
      }
      if (this.o.title) {
        g.font = `${this.o.titleBold ? "bold " : ""}${this.o.titleSize || fs + 2}px ${FONT}`;
        g.textAlign = "center"; g.textBaseline = "bottom";
        g.fillText(this.o.title, this.x + this.w / 2, this.y - 5);
      }
      if (this.o.legend) this.drawLegend(g);
    }
    drawLegend(g) {
      const items = this.items.filter(it => it.label).concat(this.twin ? this.twin.items.filter(it => it.label) : []);
      if (!items.length) return;
      const fs = this.o.legendSize || this.o.fontSize;
      g.font = `${fs}px ${FONT}`;
      const pos = this.o.legend === true ? "upper right" : this.o.legend;
      const cols = this.o.legendCols || 1;
      const lineH = fs + 6;
      const widths = items.map(it => g.measureText(it.label).width + 30);
      const colW = Math.max(...widths);
      const rows = Math.ceil(items.length / cols);
      const W = colW * cols + 10, H = rows * lineH + 8;
      let x0, y0;
      if (pos === "above") { x0 = this.x + (this.w - W) / 2; y0 = this.y - H - 2; }
      else if (pos === "upper left") { x0 = this.x + 8; y0 = this.y + 8; }
      else { x0 = this.x + this.w - W - 8; y0 = this.y + 8; }
      if (pos !== "above") { g.fillStyle = "rgba(255,255,255,0.85)"; g.fillRect(x0, y0, W, H); }
      items.forEach((it, i) => {
        const c = Math.floor(i / rows), r = i % rows;
        const lx = x0 + 6 + c * colW, ly = y0 + 4 + r * lineH + lineH / 2;
        g.strokeStyle = it.color || "#1f5fa8";
        g.lineWidth = it.width || 1.5;
        g.setLineDash(it.dash || []);
        g.beginPath(); g.moveTo(lx, ly); g.lineTo(lx + 22, ly); g.stroke();
        g.setLineDash([]);
        g.fillStyle = "#1d2433"; g.textAlign = "left"; g.textBaseline = "middle";
        g.fillText(it.label, lx + 27, ly);
      });
    }
    drawItem(g, it) {
      if (it.type === "line") {
        g.strokeStyle = it.color || "#1f5fa8";
        g.lineWidth = it.width || 1.5;
        g.globalAlpha = it.alpha === undefined ? 1 : it.alpha;
        g.setLineDash(it.dash || []);
        if (it.width !== 0 && !it.markersOnly) {
          g.beginPath();
          let pen = false;
          for (let i = 0; i < it.x.length; i++) {
            const a = it.x[i], b = it.y[i];
            if (!(isFinite(a) && isFinite(b))) { pen = false; continue; }
            const X = this.px(a), Y = this.py(b);
            if (!pen) { g.moveTo(X, Y); pen = true; } else g.lineTo(X, Y);
          }
          g.stroke();
        }
        g.setLineDash([]);
        if (it.marker) {
          g.fillStyle = it.mfc || it.color || "#1f5fa8";
          const r = it.ms || 3;
          for (let i = 0; i < it.x.length; i++) {
            if (!(isFinite(it.x[i]) && isFinite(it.y[i]))) continue;
            g.beginPath(); g.arc(this.px(it.x[i]), this.py(it.y[i]), r, 0, 2 * Math.PI); g.fill();
          }
        }
        g.globalAlpha = 1;
      } else if (it.type === "bar") {
        g.fillStyle = it.color || "#4c78a8";
        const bw = it.width || 0.8;
        for (let i = 0; i < it.x.length; i++) {
          const x0 = this.px(it.x[i] - bw / 2), x1 = this.px(it.x[i] + bw / 2);
          const y0 = this.py(0), y1 = this.py(it.h[i]);
          g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        }
      } else if (it.type === "hline" || it.type === "vline") {
        g.strokeStyle = it.color || "#000"; g.lineWidth = it.width || 1;
        g.beginPath();
        if (it.type === "hline") { const p = this.py(it.y); g.moveTo(this.x, p); g.lineTo(this.x + this.w, p); }
        else { const p = this.px(it.x); g.moveTo(p, this.y); g.lineTo(p, this.y + this.h); }
        g.stroke();
      } else if (it.type === "image") {
        const c = imageCanvas(it);
        const e = it.extent;   // [izquierda, derecha, abajo, arriba] en datos (como matplotlib)
        const x0 = this.px(e[0]), x1 = this.px(e[1]), yb = this.py(e[2]), yt = this.py(e[3]);
        g.imageSmoothingEnabled = false;
        g.globalAlpha = 1;
        g.save();
        // la fila 0 de la imagen va arriba si origin="upper"
        if (it.origin === "lower") {
          g.translate(x0, yb); g.scale((x1 - x0) / c.width, (yt - yb) / c.height);
          g.translate(0, c.height); g.scale(1, -1);
          g.drawImage(c, 0, 0);
        } else {
          g.translate(x0, yt); g.scale((x1 - x0) / c.width, (yb - yt) / c.height);
          g.drawImage(c, 0, 0);
        }
        g.restore();
      } else if (it.type === "contour") {
        g.strokeStyle = it.color || "#ff0";
        g.lineWidth = it.width || 1;
        g.beginPath();
        const segs = it.segments || (it.segments = maskSegments(it.mask, it.nx, it.ny));
        const hx = it.h, vy = it.v;
        const X = f => this.px(hx[0] + f * (hx.length > 1 ? hx[1] - hx[0] : 1));
        const Y = f => this.py(vy[0] + f * (vy.length > 1 ? vy[1] - vy[0] : 1));
        for (let s = 0; s < segs.length; s += 4) {
          g.moveTo(X(segs[s]), Y(segs[s + 1])); g.lineTo(X(segs[s + 2]), Y(segs[s + 3]));
        }
        g.stroke();
      } else if (it.type === "text") {
        g.fillStyle = it.color || "#1d2433";
        g.font = `${it.bold ? "bold " : ""}${it.size || 11}px ${FONT}`;
        g.textAlign = it.align || "left"; g.textBaseline = it.baseline || "alphabetic";
        const X = it.axesCoords ? this.x + it.tx * this.w : this.px(it.tx);
        const Y = it.axesCoords ? this.y + (1 - it.ty) * this.h : this.py(it.ty);
        const lines = String(it.s).split("\n");
        lines.forEach((l, i) => g.fillText(l, X + (it.dx || 0), Y + (it.dy || 0) + i * ((it.size || 11) + 3)));
      } else if (it.type === "marker") {
        const X = this.px(it.mx), Y = this.py(it.my);
        g.fillStyle = it.color || "#ffd400"; g.strokeStyle = it.edge || "#000"; g.lineWidth = 0.8;
        g.beginPath(); g.arc(X, Y, it.r || 4, 0, 2 * Math.PI); g.fill(); g.stroke();
        if (it.label) {
          g.fillStyle = it.color || "#ffd400"; g.font = `bold 11px ${FONT}`; g.textAlign = "left"; g.textBaseline = "bottom";
          g.fillText(it.label, X + 4, Y - 4);
        }
      }
    }
  }

  // Imagen con mapa de color en un canvas auxiliar (data: filas de arriba abajo, nx x ny)
  function imageCanvas(it) {
    if (it._canvas) return it._canvas;
    const nx = it.nx, ny = it.ny;
    const c = document.createElement("canvas");
    c.width = nx; c.height = ny;
    const ctx = c.getContext("2d");
    const im = ctx.createImageData(nx, ny);
    const L = lut(it.cmap || "gray");
    const n = L.length / 3;
    const vmin = it.vmin, vmax = it.vmax;
    const a255 = Math.round(255 * (it.alpha === undefined ? 1 : it.alpha));
    const d = it.data;
    for (let q = 0; q < nx * ny; q++) {
      const v = d[q];
      if (v !== v || (it.below !== undefined && v < it.below)) { im.data[4 * q + 3] = 0; continue; }
      let t = (v - vmin) / (vmax - vmin);
      if (it.twoSlope) {   // TwoSlopeNorm(vcenter, vmin, vmax)
        const [vc, lo, hi] = it.twoSlope;
        t = v < vc ? 0.5 * (v - lo) / (vc - lo) : 0.5 + 0.5 * (v - vc) / (hi - vc);
      }
      let i = Math.floor(t * n);
      if (i < 0) i = 0; if (i > n - 1) i = n - 1;
      im.data[4 * q] = L[3 * i]; im.data[4 * q + 1] = L[3 * i + 1]; im.data[4 * q + 2] = L[3 * i + 2];
      im.data[4 * q + 3] = a255;
    }
    ctx.putImageData(im, 0, 0);
    it._canvas = c;
    return c;
  }

  // Segmentos de contorno (nivel 0.5) de una máscara binaria (cuadrados de marcha), en índices de píxel
  function maskSegments(mask, nx, ny) {
    const s = [];
    const v = (i, j) => mask[j * nx + i] ? 1 : 0;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), d = v(i, j + 1);
      const code = a | (b << 1) | (c << 2) | (d << 3);
      if (code === 0 || code === 15) continue;
      const T = [i + 0.5, j], R = [i + 1, j + 0.5], B = [i + 0.5, j + 1], Lp = [i, j + 0.5];
      const add = (p, q) => s.push(p[0], p[1], q[0], q[1]);
      switch (code) {
        case 1: case 14: add(Lp, T); break;
        case 2: case 13: add(T, R); break;
        case 3: case 12: add(Lp, R); break;
        case 4: case 11: add(R, B); break;
        case 5: add(Lp, T); add(R, B); break;
        case 10: add(T, R); add(B, Lp); break;
        case 6: case 9: add(T, B); break;
        case 7: case 8: add(Lp, B); break;
      }
    }
    return s;
  }

  function drawColorbar(g, cb) {
    const ax = cb.ax;
    const w = cb.width || 12, gap = cb.gap || 8;
    const x = ax.x + ax.w + gap, y = ax.y, h = ax.h;
    const L = lut(cb.cmap), n = L.length / 3;
    for (let p = 0; p < h; p++) {
      const t = 1 - p / (h - 1);
      const i = Math.max(0, Math.min(n - 1, Math.floor(t * n)));
      g.fillStyle = `rgb(${L[3 * i]},${L[3 * i + 1]},${L[3 * i + 2]})`;
      g.fillRect(x, y + p, w, 1.5);
    }
    g.strokeStyle = "#5b6475"; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w, h);
    const ticks = cb.ticks || niceTicks(cb.vmin, cb.vmax, Math.max(3, Math.round(h / 45)));
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
    g.fillStyle = "#1d2433"; g.font = `${cb.fontSize || 10}px ${FONT}`; g.textAlign = "left"; g.textBaseline = "middle";
    for (const v of ticks) {
      if (v < Math.min(cb.vmin, cb.vmax) - 1e-9 || v > Math.max(cb.vmin, cb.vmax) + 1e-9) continue;
      const t = (v - cb.vmin) / (cb.vmax - cb.vmin);
      const py = y + h - t * h;
      g.fillRect(x + w, py, 3, 1);
      g.fillText(fmtTick(v, step), x + w + 5, py);
    }
    if (cb.label) {
      g.save(); g.translate(x + w + 34, y + h / 2); g.rotate(Math.PI / 2);
      g.textAlign = "center"; g.fillText(cb.label, 0, 0); g.restore();
    }
  }

  return { Figure, Axes, niceTicks, cmapColor, lut, hexToRgb, rgbCss, maskSegments, TAB10, FONT, imageCanvas };
})();
