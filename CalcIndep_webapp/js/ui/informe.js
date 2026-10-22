/* CalcIndep web · informes HTML autocontenidos (report.py y commissioning/report.py). */
var CIInforme = (function () {
  "use strict";
  const CSS = `
:root { --fg:#1d2433; --muted:#5b6475; --line:#d9dee7; --bg:#ffffff; --soft:#f4f6f9;
        --ok:#1b7f3b; --ko:#b42318; --warn:#9a6700; --accent:#1f5fa8; }
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; text-size-adjust:100%; }
body { font-family: "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif;
       color:var(--fg); background:var(--bg); margin:0; line-height:1.45; }
main { max-width:1180px; margin:0 auto; padding:24px 20px 60px; }
header.head { border-bottom:3px solid var(--accent); padding-bottom:12px; margin-bottom:6px; }
.kicker { color:var(--muted); font-size:.85rem; text-transform:uppercase; letter-spacing:.06em; }
.patient { font-size:2.1rem; font-weight:700; line-height:1.15; margin:6px 0 2px; overflow-wrap:anywhere; }
.pid { font-size:1.15rem; font-weight:600; color:#374151; overflow-wrap:anywhere; }
.plan { font-size:1.6rem; font-weight:700; color:var(--accent); margin:6px 0 4px; overflow-wrap:anywhere; }
h2 { font-size:1.15rem; margin:32px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line); }
.sub { color:var(--muted); font-size:.92rem; }
.verdict { display:flex; gap:12px; align-items:stretch; flex-wrap:wrap; margin:18px 0 8px; }
.card { background:var(--soft); border:1px solid var(--line); border-radius:8px; padding:12px 16px;
        flex:1 1 200px; min-width:0; }
.card .k { color:var(--muted); font-size:.85rem; font-weight:600; letter-spacing:.02em; }
.card .v { font-size:1.45rem; font-weight:600; font-variant-numeric: tabular-nums; }
.ok { color:var(--ok); } .ko { color:var(--ko); } .warn { color:var(--warn); }
td.ok, td.ko { font-weight:600; }
.badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:.8rem; font-weight:600; }
.badge.ok { background:#e3f3e8; } .badge.ko { background:#fde7e5; } .badge.na { background:#eceff3; color:var(--muted); }
.alert { border-left:4px solid var(--warn); background:#fff8e6; padding:10px 14px; margin:10px 0; border-radius:4px;
         overflow-wrap:anywhere; }
.alert ul { margin:4px 0 0 18px; padding:0; }
table { border-collapse:collapse; width:100%; font-size:.86rem; font-variant-numeric: tabular-nums; }
th, td { border-bottom:1px solid var(--line); padding:5px 7px; text-align:right; white-space:nowrap; }
th { background:var(--soft); font-weight:600; position:sticky; top:0; }
td.l, th.l { text-align:left; }
.scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }
img { max-width:100%; height:auto; display:block; margin:8px 0; }
.grid2 { display:grid; grid-template-columns: 1fr 1fr; gap:18px; }
.grid2 > div { min-width:0; }
.imgs { display:grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 480px), 1fr)); gap:10px; }
.small { font-size:.82rem; color:var(--muted); }
.figwrap { max-width:860px; }
.legend { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:3px 14px;
          font-size:.86rem; margin:4px 0 0; padding:8px 10px; border:1px solid var(--line); border-radius:6px; }
.legend .it { display:flex; align-items:center; gap:7px; min-width:0; overflow-wrap:anywhere; }
.legend .sw { flex:0 0 22px; height:0; border-top:3px solid; }
.legend .sw.d { border-top-style:dashed; }
.legend.styles { display:flex; flex-wrap:wrap; gap:6px 22px; border:none; padding:0 0 4px; }
dl.kv { display:grid; grid-template-columns: max-content 1fr; gap:4px 14px; font-size:.88rem; }
dl.kv dt { color:var(--muted); }
dl.kv dd { margin:0; overflow-wrap:anywhere; }
@media (max-width: 800px) { .grid2 { grid-template-columns: 1fr; } }
@media (max-width: 600px) {
  main { padding:14px 12px 40px; }
  .patient { font-size:1.6rem; }
  .plan { font-size:1.3rem; }
  .pid { font-size:1rem; }
  .card { flex:1 1 140px; padding:10px 12px; }
  .card .v { font-size:1.2rem; }
  h2 { font-size:1.05rem; margin-top:24px; }
  table { font-size:.8rem; }
  th, td { padding:4px 5px; }
  dl.kv { grid-template-columns: 1fr; gap:0; }
  dl.kv dd { margin-bottom:8px; }
  .legend { grid-template-columns:repeat(2, minmax(0, 1fr)); font-size:.8rem; gap:2px 10px; padding:6px 8px; }
}
`;
  const M = () => CIApp.M;
  const e = s => CIUI.esc(s);
  function f(v, nd) {
    nd = nd === undefined ? 2 : nd;
    if (v === null || v === undefined || (typeof v === "number" && !isFinite(v))) return "–";
    return M().fmtF(v, nd);
  }
  function safe(s, maxlen) { return CIAlmacen.safeName(s, maxlen); }
  function stamp(d, sep) {
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${sep}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  function reportFilename(res, when) {
    return `informe_${safe(res.info.patient_id || "")}_${safe(res.plan.label)}_${stamp(when || new Date(), "-")}.html`;
  }
  function personName(name) {
    const parts = String(name || "").split("^").map(s => s.trim()).filter(Boolean);
    if (!parts.length) return "Paciente sin nombre";
    if (parts.length === 1) return parts[0];
    return `${parts[0]}, ${parts.slice(1).join(" ")}`;
  }
  function orderStructures(structs) {
    const key = s => {
      const t = s.type, n = s.name.toUpperCase();
      if (["PTV", "CTV", "GTV"].indexOf(t) >= 0 || /^(PTV|CTV|GTV)/.test(n)) return [0, n];
      if (t === "EXTERNAL") return [3, n];
      if (["SUPPORT", "FIXATION", "BOLUS", "MARKER", "REGISTRATION", "CONTROL"].indexOf(t) >= 0) return [4, n];
      return [1, n];
    };
    return structs.slice().sort((a, b) => {
      const ka = key(a), kb = key(b);
      return (ka[0] - kb[0]) || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0);
    });
  }
  function isoIndex(res) {
    const g = res.tps_grid;
    for (const b of res.plan.beams) {
      if (b.cps && b.cps.length && b.cps[0].iso) {
        const fr = g.worldToIndex(b.cps[0].iso).map(v => Math.round(v));
        if (fr.every((v, i) => v >= 0 && v <= g.shape[i] - 1)) return fr;
      }
    }
    return argmax3(res.tps_dose, g.shape);
  }
  function argmax3(a, sh) {
    let m = -Infinity, q = 0;
    for (let p = 0; p < a.length; p++) if (a[p] > m) { m = a[p]; q = p; }
    return [Math.floor(q / (sh[1] * sh[2])), Math.floor(q / sh[2]) % sh[1], q % sh[2]];
  }

  // Corte de un volumen (nz, ny, nx): devuelve {data (filas de arriba abajo), nx, ny, h, v, mask}
  // orient "Axial": filas y (y0 arriba); "Coronal": filas z (z máx. arriba); "Sagital": filas z, columnas y
  function cut(arr, sh, orient, idx) {
    const [nz, ny, nx] = sh;
    let w, hgt, get;
    if (orient === "Axial") { w = nx; hgt = ny; get = (r, c) => arr[(idx * ny + r) * nx + c]; }
    else if (orient === "Coronal") { w = nx; hgt = nz; get = (r, c) => arr[((nz - 1 - r) * ny + idx) * nx + c]; }
    else { w = ny; hgt = nz; get = (r, c) => arr[((nz - 1 - r) * ny + c) * nx + idx]; }
    const T = arr instanceof Float32Array ? Float32Array : (arr instanceof Uint8Array ? Uint8Array : Float64Array);
    const out = new T(w * hgt);
    for (let r = 0; r < hgt; r++) for (let c = 0; c < w; c++) out[r * w + c] = get(r, c);
    return { data: out, nx: w, ny: hgt };
  }
  // Máscara del corte en el orden natural (filas = índice creciente del eje vertical) para los contornos
  function cutMask(m, sh, orient, idx) {
    const [nz, ny, nx] = sh;
    let w, hgt, get;
    if (orient === "Axial") { w = nx; hgt = ny; get = (r, c) => m[(idx * ny + r) * nx + c]; }
    else if (orient === "Coronal") { w = nx; hgt = nz; get = (r, c) => m[(r * ny + idx) * nx + c]; }
    else { w = ny; hgt = nz; get = (r, c) => m[(r * ny + c) * nx + idx]; }
    const out = new Uint8Array(w * hgt);
    let any = false, all = true;
    for (let r = 0; r < hgt; r++) for (let c = 0; c < w; c++) { const v = get(r, c); out[r * w + c] = v; if (v) any = true; else all = false; }
    return { data: out, nx: w, ny: hgt, any, all };
  }


  // Paneles de dosis: TPS, cálculo, diferencia y gamma, con el CT de fondo y contornos
  function slicePanel(ax, res, orient, idx, kind, opts) {
    const g = res.tps_grid;
    const sh = g.shape;
    const [x, y, z] = g.axes();
    const norm = res.gamma.norm_gy;
    let hAx, vAx, ext;
    if (orient === "Axial") { hAx = x; vAx = y; ext = [x[0], x[x.length - 1], y[y.length - 1], y[0]]; }
    else if (orient === "Coronal") { hAx = x; vAx = z; ext = [x[0], x[x.length - 1], z[0], z[z.length - 1]]; }
    else { hAx = y; vAx = z; ext = [y[0], y[y.length - 1], z[0], z[z.length - 1]]; }
    // extensión del píxel (centros en los bordes, como imshow con extent)
    const dh = hAx.length > 1 ? hAx[1] - hAx[0] : 1, dv = vAx.length > 1 ? vAx[1] - vAx[0] : 1;
    let extImg;
    if (orient === "Axial") extImg = [hAx[0] - dh / 2, hAx[hAx.length - 1] + dh / 2, vAx[vAx.length - 1] + dv / 2, vAx[0] - dv / 2];
    else extImg = [hAx[0] - dh / 2, hAx[hAx.length - 1] + dh / 2, vAx[0] - dv / 2, vAx[vAx.length - 1] + dv / 2];
    const ct = cut(res.ct_on_grid, sh, orient, idx);
    // imshow con origin "upper": la fila 0 arriba. En axial, arriba = y[0] (extent invertido en y).
    const imgExt = orient === "Axial" ? [extImg[0], extImg[1], extImg[2], extImg[3]] : [extImg[0], extImg[1], extImg[2], extImg[3]];
    ax.image({ data: ct.data, nx: ct.nx, ny: ct.ny, extent: imgExt, cmap: "gray", vmin: -500, vmax: 500, origin: "upper" });
    if (kind === "tps" || kind === "calc") {
      const d = cut(kind === "tps" ? res.tps_dose : res.calc_dose, sh, orient, idx);
      ax.image({ data: d.data, nx: d.nx, ny: d.ny, extent: imgExt, cmap: "jet", vmin: 0.1 * norm, vmax: 1.1 * norm,
                 alpha: 0.55, below: 0.1 * norm, origin: "upper" });
    } else if (kind === "diff") {
      const d = cut(opts.diff, sh, orient, idx);
      ax.image({ data: d.data, nx: d.nx, ny: d.ny, extent: imgExt, cmap: "RdBu_r", vmin: -5, vmax: 5, twoSlope: [0, -5, 5],
                 alpha: 0.85, origin: "upper" });
    } else {
      const d = cut(res.gamma.gamma, sh, orient, idx);
      ax.image({ data: d.data, nx: d.nx, ny: d.ny, extent: imgExt, cmap: "gamma", vmin: 0, vmax: 2, origin: "upper" });
    }
    for (const s of opts.structs || []) {
      const m = res.masks.get(s.name);
      if (!m) continue;
      const mm = cutMask(m, sh, orient, idx);
      if (mm.any && !mm.all)
        ax.contour({ mask: mm.data, nx: mm.nx, ny: mm.ny, h: hAx, v: vAx, color: `rgb(${s.color.join(",")})`, width: opts.lw || 0.8 });
    }
    ax.set({ xlim: [ext[0] - dh / 2, ext[1] + dh / 2],
             ylim: orient === "Axial" ? [ext[2] + dv / 2, ext[3] - dv / 2] : [ext[2] - dv / 2, ext[3] + dv / 2] });
    return { hAx, vAx };
  }
  function diffArray(res) {
    const n = res.gamma.norm_gy;
    const d = new Float64Array(res.calc_dose.length);
    for (let p = 0; p < d.length; p++) {
      const t = res.tps_dose[p], c = res.calc_dose[p];
      d[p] = (t < 0.1 * n && c < 0.1 * n) ? NaN : (c - t) / n * 100.0;
    }
    return d;
  }

  function slicesFigures(res) {
    const g = res.tps_grid;
    const [k, j, i] = isoIndex(res);
    const [x, y, z] = g.axes();
    const norm = res.gamma.norm_gy;
    const diff = diffArray(res);
    const out = [];
    const views = [["Axial", k, [x[0], x[x.length - 1], y[y.length - 1], y[0]]],
                   ["Coronal", j, [x[0], x[x.length - 1], z[0], z[z.length - 1]]],
                   ["Sagital", i, [y[0], y[y.length - 1], z[0], z[z.length - 1]]]];
    for (const [title, idx, ext] of views) {
      const hmm = Math.abs(ext[3] - ext[2]), wmm = Math.abs(ext[1] - ext[0]);
      const aspect = hmm / Math.max(wmm, 1e-6);
      const W = 700;
      const panelW = 270, panelH = Math.round(panelW * Math.min(Math.max(aspect, 0.45), 1.4));
      const H = 60 + 2 * (panelH + 46);
      const fig = new CIG.Figure(null, W, H, 1.5);
      const labels = [["TPS (Gy)", "tps"], ["CalcIndep (Gy)", "calc"], [`Diferencia (% de ${f(norm, 2)} Gy)`, "diff"], ["Gamma", "gamma"]];
      labels.forEach(([lab, kind], q) => {
        const col = q % 2, row = Math.floor(q / 2);
        const ax = fig.axes([18 + col * (panelW + 78), 60 + row * (panelH + 46), panelW, panelH],
                            { xticks: false, yticks: false, title: lab, titleSize: 16, equal: true, bg: "#000" });
        slicePanel(ax, res, title, idx, kind, { diff, structs: res.structures });
        if (kind === "tps" || kind === "calc") fig.colorbar(ax, { cmap: "jet", vmin: 0.1 * norm, vmax: 1.1 * norm, fontSize: 14 });
        else if (kind === "diff") fig.colorbar(ax, { cmap: "RdBu_r", vmin: -5, vmax: 5, fontSize: 14 });
        else fig.colorbar(ax, { cmap: "gamma", vmin: 0, vmax: 2, fontSize: 14 });
      });
      fig.text(W / 2, 30, title, { size: 16, bold: true, align: "center" });
      out.push([title, fig.toDataURL()]);
    }
    return [out, [x[i], y[j], z[k]]];
  }

  function dvhFigure(res, structs) {
    let dmax = -Infinity;
    for (const a of [res.tps_dose, res.calc_dose]) for (let p = 0; p < a.length; p++) if (a[p] > dmax) dmax = a[p];
    const fig = new CIG.Figure(null, 620, 420, 1.5);
    const ax = fig.axes([70, 20, 530, 340], { grid: true, xlabel: "Dosis (Gy)", ylabel: "Volumen (%)", fontSize: 13 });
    const drawn = [];
    for (const s of structs) {
      const m = res.masks.get(s.name);
      if (!m || !m.some(v => v)) continue;
      const col = `rgb(${s.color.join(",")})`;
      let [d, v] = M().cumulativeDVH(res.tps_dose, m, dmax / 500, dmax);
      ax.line(d, v, { color: col, width: 1.5 });
      [d, v] = M().cumulativeDVH(res.calc_dose, m, dmax / 500, dmax);
      ax.line(d, v, { color: col, width: 1.5, dash: [6, 4] });
      drawn.push(s);
    }
    ax.set({ ylim: [0, 102], xlim: [0, dmax * 1.05] });
    return [fig.toDataURL(), drawn];
  }
  function dvhLegendHtml(drawn) {
    const hx = c => "#" + c.map(v => v.toString(16).padStart(2, "0")).join("");
    return `<div class='legend'>${drawn.map(s => `<div class='it'><span class='sw' style='border-top-color:${hx(s.color)}'></span>${e(s.name)}</div>`).join("")}</div>`;
  }
  function gammaHist(res) {
    const g = res.gamma.gamma, ev = res.gamma.evaluated;
    const maxg = res.gamma.settings.max_gamma;
    const edges = M().linspace(0, maxg, 81);
    const vals = [];
    for (let p = 0; p < g.length; p++) if (ev[p] && isFinite(g[p])) vals.push(g[p]);
    const h = M().histogram(vals, edges);
    const fig = new CIG.Figure(null, 640, 380, 1.5);
    const ax = fig.axes([92, 44, 528, 266], { grid: true, xlabel: "γ", ylabel: "Número de puntos", fontSize: 16, titleSize: 17,
                                               title: "Distribución de gamma (puntos evaluados)", ylabelOffset: 72 });
    const bw = edges[1] - edges[0];
    ax.bar(Array.from(h, (_, q) => edges[q] + bw / 2), Array.from(h), { width: bw * 0.98, color: "#4c78a8" });
    ax.vline(1.0, { color: "#b42318", width: 1 });
    ax.set({ xlim: [0, maxg] });
    return fig.toDataURL();
  }
  function curveFig(curve, small) {
    const fig = new CIG.Figure(null, 640, 380, 1.5);
    const ax = fig.axes([80, 44, 540, 266], { grid: true, xlabel: "Número CT (HU)", ylabel: "Densidad electrónica relativa",
                                               fontSize: 16, titleSize: 17, title: `Curva HU–densidad electrónica (${curve.name})` });
    const hu = curve.hu;
    const h = M().linspace(Math.min(-1000, hu[0]), Math.max(3000, hu[hu.length - 1]), 400);
    ax.line(h, h.map(v => curve.value(v)), { color: "#1f5fa8", width: 1.5 });
    ax.line(Array.from(hu), Array.from(curve.red), { color: "#1f5fa8", marker: true, ms: 3, markersOnly: true });
    return fig.toDataURL();
  }

  // Informe de la verificación. res: resultado en la interfaz (con Grid, Map de máscaras y HUEDCurve)
  function verificationReport(res, when, title) {
    title = title || "Cálculo independiente de dosis";
    when = when || new Date();
    const Mm = M();
    const cfg = res.config;
    const gset = res.gamma.settings;
    const gstats = res.gamma.stats;
    const thr = cfg.pass_threshold_pct;
    const extName = res.info.density.external;
    const structs = orderStructures(res.structures);
    const rows = [];
    for (const s of structs) {
      const st = res.gamma_struct[s.name] || {};
      const mt = res.dvh_tps[s.name] || {}, mc = res.dvh_calc[s.name] || {};
      const n = st.n || 0;
      const gp = st.pass_pct;
      let badge, gcls;
      if (n >= cfg.min_points_structure) {
        const passed = gp >= thr;
        badge = `<span class="badge ${passed ? "ok" : "ko"}">${passed ? "Cumple" : "No cumple"}</span>`;
        gcls = passed ? "ok" : "ko";
      } else { badge = '<span class="badge na">Sin puntos</span>'; gcls = ""; }
      const dd = key => {
        const a = mt[key], b = mc[key];
        if (a === undefined || b === undefined || a === null || b === null || !isFinite(a) || a <= 0) return "–";
        const v = (b - a) / a * 100;
        return (v >= 0 ? "+" : "") + Mm.fmtF(v, 1);
      };
      rows.push(`<tr><td class='l'>${e(s.name)}</td><td class='l'>${e(s.type || "")}</td>` +
        `<td class='${gcls}'>${f(gp, 1)}</td><td class='l'>${badge}</td>` +
        `<td>${f(mt.volume_cc === undefined ? 0 : mt.volume_cc, 1)}</td><td>${n}</td>` +
        `<td>${f(st.mean)}</td><td>${f(st.p95)}</td><td>${f(st.max)}</td>` +
        `<td>${f(mt.Dmean)}</td><td>${f(mc.Dmean)}</td><td>${dd("Dmean")}</td>` +
        `<td>${dd("D95")}</td><td>${dd("D2")}</td><td>${dd("Dmax_0.03cc")}</td></tr>`);
    }
    const [slices, pt] = slicesFigures(res);
    const [dvhPng, dvhDrawn] = dvhFigure(res, structs.filter(s => ["SUPPORT", "MARKER", "REGISTRATION"].indexOf(s.type) < 0));
    const histPng = gammaHist(res);
    const curvePng = curveFig(res.curve);
    const isoRows = [];
    const seen = new Set();
    for (const b of res.plan.beams) {
      if (!b.cps || !b.cps.length || !b.cps[0].iso) continue;
      const iso = b.cps[0].iso;
      const key = Array.from(iso, v => Mm.npRound(v, 1));
      const ks = key.join("|");
      if (seen.has(ks)) continue;
      seen.add(ks);
      const fr = res.tps_grid.worldToIndex(iso);
      const dt = Mm.mapCoord3(res.tps_dose, res.tps_grid.shape, fr[0], fr[1], fr[2], "constant", 0.0);
      const dc = Mm.mapCoord3(res.calc_dose, res.tps_grid.shape, fr[0], fr[1], fr[2], "constant", 0.0);
      const diff = dt > 0 ? (dc - dt) / dt * 100 : NaN;
      isoRows.push(`<tr><td class='l'>(${Mm.fmtF(key[0], 1)}, ${Mm.fmtF(key[1], 1)}, ${Mm.fmtF(key[2], 1)})</td>` +
                   `<td>${Mm.fmtF(dt, 3)}</td><td>${Mm.fmtF(dc, 3)}</td><td>${f(diff)}</td></tr>`);
    }
    const treat = res.plan.beams.filter(b => b.beam_type === "TREATMENT" && b.mu > 0 && b.radiation_type === "PHOTON");
    const beamRows = res.beams.map((br, q) => {
      const b = treat[q];
      if (!b) return "";
      const g0 = b.cps[0].gantry, g1 = b.cps[b.cps.length - 1].gantry;
      const gtxt = !b.is_arc ? Mm.fmtF(g0, 1) : `${Mm.fmtF(g0, 1)} → ${Mm.fmtF(g1, 1)}`;
      return `<tr><td class='l'>${e(b.name)}</td><td class='l'>${e(b.machine)}</td><td>${e(b.energy)}` +
        `${b.fluence_mode === "STANDARD" ? "" : " " + e(b.fluence_mode)}</td>` +
        `<td class='l'>${e(b.technique)}</td><td>${gtxt}</td><td>${Mm.fmtF(b.cps[0].coll, 1)}</td>` +
        `<td>${Mm.fmtF(b.cps[0].couch, 1)}</td><td>${Mm.fmtF(b.mu, 1)}</td><td>${b.cps.length}</td>` +
        `<td>${br.n_subbeams}</td><td>${br.n_superpositions}</td><td>${Mm.fmtF(br.seconds, 1)}</td>` +
        `<td class='l'>${e(br.model)}</td><td class='l'>${e(br.mlc || "–")}</td></tr>`;
    });
    let warnHtml = "";
    if (res.warnings.length) warnHtml = "<div class='alert'><strong>Avisos</strong><ul>" + res.warnings.map(w => `<li>${e(w)}</li>`).join("") + "</ul></div>";
    const info = res.info, tg = res.tps_grid, cg = M().Grid.from(info.calc_grid), dens = info.density, plan = res.plan;
    const [ok, fails] = Mm.verdict(res);
    const verdictCls = ok ? "ok" : "ko", verdictTxt = ok ? "Cumple" : "No cumple";
    const failsTxt = fails.length ? "No cumple porque estas estructuras quedan por debajo del umbral: " + fails.map(e).join(", ")
      : "Todas las estructuras con puntos evaluados superan el umbral.";
    const now = Mm.fechaPy(when);
    const modelsHtml = info.models.map(m => `<tr><td class='l'>${e(m.name)}</td><td>${e(m.energy)}</td><td>${e(m.fluence_mode)}</td>` +
      `<td>${m.commissioned ? "Sí" : "<span class=ko>No</span>"}</td><td>${Mm.fmtG(m.cgy_per_unit, 4)}</td></tr>`).join("");
    const ov = dens.overrides.map(([n, v]) => `${e(n)} = ${Mm.fmtF(v, 3)}`).join(", ") || "ninguna";
    const rx = !plan.prescription_gy ? "" : ` · prescripción ${Mm.fmtF(plan.prescription_gy, 2)} Gy`;
    const slicesHtml = slices.map(([t, png]) => `<img src="${png}" alt="Corte ${t.toLowerCase()}: dosis, diferencia y gamma">`).join("");
    const pname = personName(info.patient_name);
    const opt = cfg.options;
    const base = p => String(p).split(/[\\/]/).pop();
    const doc = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(info.patient_id)} · ${e(plan.label)} · ${e(title)}</title><style>${CSS}</style></head><body><main>
<header class="head">
<div class="kicker">${e(title)}</div>
<div class="patient">${e(pname)}</div>
<div class="pid">ID ${e(info.patient_id)}</div>
<div class="plan">Plan ${e(plan.label)}</div>
<div class="sub">${plan.n_fractions} fracciones${rx} · generado ${now} con CalcIndep ${Mm.VERSION_WEB}</div>
</header>
<div class="verdict">
 <div class="card"><div class="k">Resultado global</div><div class="v ${verdictCls}">${verdictTxt}</div>
   <div class="small">Umbral ${Mm.fmtG(thr)}% en el External (${e(extName || "toda la rejilla")}) y en cada estructura</div></div>
 <div class="card"><div class="k">Gamma ${Mm.fmtG(gset.dose_pct)}%/${Mm.fmtG(gset.dta_mm)} mm</div>
   <div class="v">${f(gstats.pass_pct, 1)}%</div><div class="small">${gstats.n} puntos evaluados</div></div>
 <div class="card"><div class="k">γ medio / p95</div><div class="v">${f(gstats.mean)} / ${f(gstats.p95)}</div>
   <div class="small">γ máx. ${f(gstats.max)}</div></div>
 <div class="card"><div class="k">Normalización</div><div class="v">${Mm.fmtF(res.gamma.norm_gy, 2)} Gy</div>
   <div class="small">${e(gset.normalization)}</div></div>
</div>
<p class="small">${failsTxt}</p>
${warnHtml}

<h2>Gamma y dosimetría por estructura</h2>
<p class="small">Criterio: ${e(Mm.describeGamma(gset))}. Radio de búsqueda ${Mm.fmtG(gset.max_gamma)} × DTA, paso de
interpolación DTA/${gset.interp_fraction}. γ = ${Mm.fmtG(gset.max_gamma)} indica γ ≥ ${Mm.fmtG(gset.max_gamma)}. En verde, las
estructuras con γ ≤ 1 en al menos el ${Mm.fmtG(thr)}% de los puntos; en rojo, las que no llegan. Las diferencias
dosimétricas son (cálculo − TPS)/TPS en %.</p>
<div class="scroll"><table>
<tr><th class='l'>Estructura</th><th class='l'>Tipo</th><th>γ≤1 (%)</th><th class='l'>Estado</th><th>Vol. (cc)</th>
<th>Puntos</th><th>γ medio</th><th>γ p95</th><th>γ máx.</th><th>Dmedia TPS (Gy)</th><th>Dmedia calc. (Gy)</th>
<th>ΔDmedia %</th><th>ΔD95 %</th><th>ΔD2 %</th><th>ΔDmáx 0.03cc %</th></tr>
${rows.join("")}
</table></div>

<h2>Cortes por el isocentro</h2>
<p class="small">Punto: x = ${Mm.fmtF(pt[0], 1)} mm, y = ${Mm.fmtF(pt[1], 1)} mm, z = ${Mm.fmtF(pt[2], 1)} mm. La diferencia se muestra donde
alguna de las dos dosis supera el 10% de la normalización.</p>
<div class="imgs">${slicesHtml}</div>

<h2>Histograma dosis-volumen (DVH)</h2>
<div class="figwrap">
<div class="legend styles"><div class="it"><span class="sw" style="border-top-color:#374151"></span>TPS</div>
<div class="it"><span class="sw d" style="border-top-color:#374151"></span>CalcIndep</div></div>
<img src="${dvhPng}" alt="DVH">
${dvhLegendHtml(dvhDrawn)}
</div>

<div class="grid2">
<div><h2>Distribución de gamma</h2><img src="${histPng}" alt="Histograma gamma"></div>
<div><h2>Dosis en el isocentro</h2><div class="scroll"><table><tr><th class='l'>Isocentro (mm)</th><th>TPS (Gy)</th>
<th>Cálculo (Gy)</th><th>Dif. %</th></tr>
${isoRows.join("")}</table></div></div>
</div>

<h2>Haces</h2>
<div class="scroll"><table><tr><th class='l'>Haz</th><th class='l'>Máquina</th><th>Energía</th><th class='l'>Técnica</th>
<th>Gantry</th><th>Colim.</th><th>Mesa</th><th>UM</th><th>Puntos control</th><th>Incidencias</th>
<th>Superposiciones</th><th>Tiempo (s)</th><th class='l'>Modelo</th><th class='l'>MLC y parámetros</th></tr>${beamRows.join("")}</table></div>

<h2>Modelos de haz</h2>
<div class="scroll"><table><tr><th class='l'>Modelo</th><th>Energía</th><th>Fluencia</th><th>Comisionado</th><th>cGy/unidad</th></tr>${modelsHtml}</table></div>

<div class="grid2">
<div><h2>Densidades</h2><img src="${curvePng}" alt="Curva HU-ED">
<p class="small">Fuera del External: ${opt.outside_external === "air" ? "aire" : "según CT"}.
Estructuras de soporte conservadas: ${dens.support.map(e).join(", ") || "ninguna"}.
Densidades asignadas por estructura: ${ov}.</p></div>
<div><h2>Parámetros del cálculo</h2><dl class="kv">
<dt>Algoritmo</dt><dd>Convolución-superposición collapsed cone con kernels EGSnrc (EDKnrc), escalado por densidad electrónica</dd>
<dt>Rejilla TPS</dt><dd>${tg.shape[2]}×${tg.shape[1]}×${tg.shape[0]}, paso ${Mm.fmtF(tg.spacing[0], 2)}×${Mm.fmtF(tg.spacing[1], 2)}×${Mm.fmtF(tg.spacing[2], 2)} mm</dd>
<dt>Rejilla de cálculo</dt><dd>${cg.shape[2]}×${cg.shape[1]}×${cg.shape[0]}, paso ${Mm.fmtF(cg.spacing[0], 2)}×${Mm.fmtF(cg.spacing[1], 2)}×${Mm.fmtF(cg.spacing[2], 2)} mm</dd>
<dt>Resolución de fluencia</dt><dd>${Mm.fmtG(opt.fluence_res_mm)} mm</dd>
<dt>Paso de gantry en arcos</dt><dd>${Mm.fmtG(opt.max_gantry_step_deg)}°, sectores de superposición de ${Mm.fmtG(opt.sector_deg)}°</dd>
<dt>Suma de dosis TPS</dt><dd>${e(info.dose_summation)}; factor de fracciones aplicado ${Mm.fmtG(info.fraction_factor)}</dd>
<dt>Tiempo total</dt><dd>${Mm.fmtF(info.elapsed_s, 0)} s</dd>
<dt>Superposición</dt><dd>${e(info.superposition || "CPU")}</dd>
<dt>Navegador</dt><dd class="small">${e(navigator.userAgent)}</dd>
<dt>RTPLAN</dt><dd class="small">${e(base(info.rtplan))}</dd>
<dt>RTDOSE</dt><dd class="small">${info.rtdose_files.map(p => e(base(p))).join(", ")}</dd>
</dl></div></div>
<p class="small" style="margin-top:28px">Herramienta de verificación de desarrollo propio. No es un producto sanitario
certificado. Los resultados dependen del comisionado del modelo de haz y de la curva HU–densidad electrónica.</p>
</main></body></html>`;
    return doc;
  }

  // ------------------------------------------------------------------ comisionado
  function curvePlot(items, title) {
    const fig = new CIG.Figure(null, 750, 560, 1.4);
    const a1 = fig.axes([78, 38, 645, 336], { grid: true, ylabel: "Dosis relativa (%)", fontSize: 14, titleSize: 15, ylabelOffset: 58,
                                               title: title + " · puntos: medida, línea: cálculo",
                                               legend: "upper right", legendCols: 2, legendSize: 12, xticklabels: false });
    const a2 = fig.axes([78, 392, 645, 120], { grid: true, ylabel: "Cálc. − med. (%)", fontSize: 14, ylabelOffset: 58,
                                               xlabel: items[0].curve.kind === "pdd" ? "Profundidad (mm)" : "Posición (mm)" });
    const cols = CIG.TAB10();
    let xmin = Infinity, xmax = -Infinity;
    items.forEach((r, n) => {
      const c = r.curve;
      const xm = c.pos_mm, vm0 = c.value;
      let vm;
      if (c.kind === "pdd") { const mx = Math.max(...vm0); vm = vm0.map(v => v / mx * 100); }
      else { const c0 = M().interp1(0.0, xm, vm0); vm = vm0.map(v => v / c0 * 100); }
      const col = cols[n % 10];
      const lab = `${M().fmtG(c.field_x_mm / 10)}x${M().fmtG(c.field_y_mm / 10)}` + (c.kind === "pdd" ? "" : ` ${M().fmtG(c.depth_mm / 10)} cm ${c.axis}`);
      a1.line(xm, vm, { color: col, marker: true, ms: 1.8, markersOnly: true, alpha: 0.7 });
      a1.line(r.x_calc, r.v_calc, { color: col, width: 1.1, label: lab });
      const d = xm.map((x, i) => M().interp1(x, r.x_calc, r.v_calc) - vm[i]);
      a2.line(xm, d, { color: col, width: 0.9 });
      xmin = Math.min(xmin, Math.min(...xm), Math.min(...r.x_calc)); xmax = Math.max(xmax, Math.max(...xm), Math.max(...r.x_calc));
    });
    a2.hline(0, { color: "#000", width: 0.6 });
    a1.set({ xlim: [xmin, xmax] });
    a2.set({ xlim: [xmin, xmax], ylim: [-5, 5] });
    return fig.toDataURL();
  }
  function spectrumPlot(model) {
    const fig = new CIG.Figure(null, 550, 320, 1.4);
    const ax = fig.axes([70, 34, 460, 230], { grid: true, xlabel: "Energía (MeV)", ylabel: "Fracción de fotones", title: "Espectro ajustado", fontSize: 14, titleSize: 15, ylabelOffset: 56 });
    ax.bar(Array.from(model.energies), Array.from(model.weights), { width: 0.4, color: "#4c78a8" });
    return fig.toDataURL();
  }
  function oaPlot(model) {
    const fig = new CIG.Figure(null, 550, 320, 1.4);
    const ax = fig.axes([70, 34, 460, 230], { grid: true, xlabel: "Radio en el isocentro (mm)", ylabel: "Factor de fluencia",
                                               title: "Perfil radial de fluencia", fontSize: 14, titleSize: 15, ylabelOffset: 56 });
    ax.line(model.oa_radius_mm, model.oa_factor, { color: "#1f5fa8", marker: true, ms: 2.5 });
    return fig.toDataURL();
  }
  function commissioningReport(r, when) {
    const Mm = M();
    const m = Mm.BeamModel.fromJSON(r.model);
    const val = r.val;
    const pdds = val.filter(v => v.curve.kind === "pdd"), profs = val.filter(v => v.curve.kind === "profile");
    const figs = [];
    const bySsd = new Map();
    for (const v of pdds) { const k = v.curve.ssd_mm; if (!bySsd.has(k)) bySsd.set(k, []); bySsd.get(k).push(v); }
    for (const [ssd, items] of Array.from(bySsd.entries()).sort((a, b) => a[0] - b[0]))
      figs.push(curvePlot(items.slice().sort((a, b) => a.curve.field_x_mm - b.curve.field_x_mm), `PDD DFS ${Mm.fmtG(ssd / 10)} cm`));
    const byF = new Map();
    for (const v of profs) {
      const c = v.curve;
      const k = [c.field_x_mm, c.field_y_mm, c.ssd_mm, c.axis];
      const ks = JSON.stringify(k);
      if (!byF.has(ks)) byF.set(ks, { k, items: [] });
      byF.get(ks).items.push(v);
    }
    const sortedF = Array.from(byF.values()).sort((a, b) => (a.k[0] - b.k[0]) || (a.k[1] - b.k[1]) || (a.k[2] - b.k[2]) ||
                                                           (a.k[3] < b.k[3] ? -1 : a.k[3] > b.k[3] ? 1 : 0));
    for (const { k: [fx, fy, ssd, ax], items } of sortedF)
      figs.push(curvePlot(items.slice().sort((a, b) => a.curve.depth_mm - b.curve.depth_mm),
                          `Perfiles ${ax} campo ${Mm.fmtG(fx / 10)}x${Mm.fmtG(fy / 10)} DFS ${Mm.fmtG(ssd / 10)} cm`));
    const rows = val.map(v => {
      const c = v.curve, gp = v.gamma_pass;
      const cls = isFinite(gp) && gp >= 95 ? "ok" : "ko";
      const extra = c.kind === "pdd" ? `${Mm.fmtF(v.pdd10_meas, 1)} / ${Mm.fmtF(v.pdd10_calc, 1)}` : "";
      return `<tr><td class='l'>${e(c.label)}</td><td class='${cls}'>${Mm.fmtF(gp, 1)}</td>` +
             `<td>${Mm.fmtF(v.max_abs_diff_core, 2)}</td><td>${extra}</td></tr>`;
    });
    const ofRows = r.of.map(o => `<tr><td>${Mm.fmtG(o.fx / 10)}x${Mm.fmtG(o.fy / 10)}</td><td>${Mm.fmtF(o.meas, 4)}</td><td>${Mm.fmtF(o.calc, 4)}</td>` +
      `<td class='${Math.abs(o.diff_pct) <= 1.0 ? "ok" : (Math.abs(o.diff_pct) <= 2.0 ? "warn" : "ko")}'>${(o.diff_pct >= 0 ? "+" : "") + Mm.fmtF(o.diff_pct, 2)}</td></tr>`).join("");
    const w = m.weights, E = m.energies;
    const emean = Mm.npsum(Float64Array.from(w, (v, i) => v * E[i]));
    const sp = m.softening_power;
    const softTxt = (sp === 1 ? `μ(r) = μ (1 + s r), s = ${Mm.fmtG(m.softening_per_cm)} cm⁻¹` :
      sp === 2 ? `μ(r) = μ (1 + s r²), s = ${Mm.fmtG(m.softening_per_cm)} cm⁻²` :
      `μ(r) = μ (1 + s r^${Mm.fmtG(sp)}), s = ${Mm.fmtG(m.softening_per_cm)}`) + ` (r hasta ${Mm.fmtG(m.softening_rmax_cm)} cm)`;
    const [sx, sy] = m.ef_sigmas;
    const params = [
      ["Energía media del espectro", `${Mm.fmtF(emean, 3)} MeV`],
      ["Contaminación electrónica", `w = ${Mm.fmtF(m.econt_weight, 4)}, k = ${Mm.fmtG(m.econt_k_per_cm)} cm⁻¹, σ = ${Mm.fmtG(m.econt_sigma_mm)} mm`],
      ["Ablandamiento fuera de eje", softTxt],
      ["Fuente primaria", `σ = ${Mm.fmtG(m.primary_sigma_mm)} mm`],
      ["Colimador primario", m.primary_collimator_radius_mm > 0 ? `radio ${Mm.fmtG(m.primary_collimator_radius_mm)} mm, σ ${Mm.fmtG(m.primary_collimator_sigma_mm)} mm` : "no modelado"],
      ["Fuente extrafocal", `w = ${Mm.fmtF(m.extrafocal_weight, 4)}, σx = ${Mm.fmtG(sx)} mm, σy = ${Mm.fmtG(sy)} mm`],
      ["MLC", Object.entries(m.mlc).map(([k, v]) => `${Mm.mlcDisplayName(k)}: transmisión ${Mm.fmtG(v.transmission)}, DLG ${Mm.fmtG(v.dlg_mm)} mm, ` +
                                                  `lengüeta-ranura ${Mm.fmtG(v.tg_width_mm)} mm`).join("; ") || "ninguno"],
      ["Transmisión de mandíbulas", Mm.fmtG(m.jaw_transmission)],
      ["Inclinación del kernel", r.options.kernel_tilt && m.kernel_tilt ? `sí, direcciones nodales cada ${Mm.fmtG(r.options.tilt_tile_deg)}° ` +
        `(campos con semiapertura > ${Mm.fmtG(r.options.tilt_min_halfangle_deg)}°)` : "no"],
      ["Calibración", `${Mm.fmtG(m.calibration.dose_per_mu_cgy)} cGy/UM, DFS ${Mm.fmtG(m.calibration.ssd_mm / 10)} cm, ` +
        `prof. ${Mm.fmtG(m.calibration.depth_mm / 10)} cm, campo ${Mm.fmtG(m.calibration.field_mm / 10)} cm; ` +
        `${Mm.fmtG(m.calibration.cgy_per_unit, 5)} cGy/unidad con rejilla ${Mm.fmtG(m.calibration.grid_mm)} mm`],
    ];
    const logHtml = r.log.map(l => `<li>${e(l)}</li>`).join("");
    const times = Object.entries(r.timing).map(([k, v]) => `${k}: ${Mm.fmtF(v, 0)} s`).join(", ");
    const d = when || new Date();
    const now = Mm.fechaPy(d).slice(0, 16);
    return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Comisionado ${e(m.name)}</title><style>${CSS}</style></head><body><main>
<h1>Comisionado del modelo de haz</h1>
<div class="sub">${e(m.name)} · máquina ${e(m.machine)} · ${e(m.energy)} ${e(m.fluence_mode)} ·
generado ${now} · rejilla ${Mm.fmtG(r.cfg.grid_mm)} mm · CalcIndep ${Mm.VERSION_WEB}</div>
<div class="alert">Revise las curvas y los factores de campo antes de usar el modelo. El ajuste usa la misma
rejilla que se empleará en los cálculos clínicos; si cambia el tamaño de vóxel, repita la calibración.</div>
<h2>Parámetros del modelo</h2>
<div class="grid2"><div><dl class="kv">${params.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join("")}</dl></div>
<div><img src="${spectrumPlot(m)}" alt="Espectro"><img src="${oaPlot(m)}" alt="Perfil radial"></div></div>
<h2>Resumen por curva</h2>
<p class="small">Gamma 1D global 2%/2 mm con umbral del 10%. Diferencia máxima en la región central
(PDD más allá de dmáx; perfiles dentro del 80% del campo).</p>
<div class="scroll"><table><tr><th class='l'>Curva</th><th>γ≤1 (%)</th><th>|Dif.| máx. central (%)</th>
<th>PDD10 med. / calc.</th></tr>${rows.join("")}</table></div>
<h2>Factores de campo</h2>
<table><tr><th>Campo (cm)</th><th>Medido</th><th>Calculado</th><th>Dif. (%)</th></tr>${ofRows || "<tr><td colspan=4>Sin datos</td></tr>"}</table>
<h2>Curvas</h2>
<div class="grid2">${figs.map(fg => `<div><img src="${fg}" alt="curva"></div>`).join("")}</div>
<h2>Registro del ajuste</h2><ul class="small">${logHtml}</ul>
<p class="small">Tiempos: ${times}</p>
</main></body></html>`;
  }

  return { CSS, verificationReport, commissioningReport, reportFilename, orderStructures, isoIndex, argmax3, cut, cutMask,
           slicePanel, diffArray, stamp, personName };
})();
