"""Informe HTML autocontenido de la verificación."""
import base64
import datetime as _dt
import html
import io
import re
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.colors import ListedColormap, TwoSlopeNorm  # noqa: E402

from . import __version__  # noqa: E402
from .dvh import cumulative_dvh  # noqa: E402

CSS = """
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
"""


def _png(fig, dpi=110):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi, bbox_inches="tight")
    plt.close(fig)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _esc(s):
    return html.escape(str(s))


def _safe(s, maxlen=60):
    s = re.sub(r"[^\w\-.]+", "_", str(s), flags=re.UNICODE).strip("_.")
    return (s or "sin_nombre")[:maxlen]


def report_filename(res, when=None):
    """Nombre del informe: informe_<ID paciente>_<plan>_<AAAAMMDD-HHMMSS>.html."""
    when = when or _dt.datetime.now()
    return (f"informe_{_safe(res.info.get('patient_id', ''))}_{_safe(res.plan.label)}_"
            f"{when.strftime('%Y%m%d-%H%M%S')}.html")


def _person_name(name):
    """Nombre DICOM (APELLIDOS^NOMBRE^…) en forma legible: «APELLIDOS, NOMBRE»."""
    parts = [p.strip() for p in str(name or "").split("^") if p.strip()]
    if not parts:
        return "Paciente sin nombre"
    if len(parts) == 1:
        return parts[0]
    return f"{parts[0]}, {' '.join(parts[1:])}"


def _f(v, nd=2):
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return "–"
    return f"{v:.{nd}f}"


def _order_structures(structures):
    def key(s):
        t = s.type
        n = s.name.upper()
        if t in ("PTV", "CTV", "GTV") or n.startswith(("PTV", "CTV", "GTV")):
            return (0, n)
        if t == "EXTERNAL":
            return (3, n)
        if t in ("SUPPORT", "FIXATION", "BOLUS", "MARKER", "REGISTRATION", "CONTROL"):
            return (4, n)
        return (1, n)
    return sorted(structures, key=key)


def _slice_point(res):
    p = None
    for b in res.plan.beams:
        if b.cps and b.cps[0].iso is not None:
            p = b.cps[0].iso
            break
    g = res.tps_grid
    if p is not None:
        f = g.world_to_index(p)
        if all(0 <= f[i] <= s - 1 for i, s in enumerate(g.shape)):
            return np.round(f).astype(int)
    k, j, i = np.unravel_index(np.nanargmax(res.tps_dose), res.tps_dose.shape)
    return np.array([k, j, i])


def _slices_figures(res):
    """Una figura 2×2 por orientación (TPS, cálculo, diferencia y gamma), legible también en un móvil."""
    g = res.tps_grid
    k, j, i = _slice_point(res)
    norm = res.gamma.norm_gy
    x, y, z = g.axes()
    views = [
        ("Axial", lambda a: a[k], [x[0], x[-1], y[-1], y[0]], (x, y, lambda a: a[k])),
        ("Coronal", lambda a: a[:, j, :][::-1], [x[0], x[-1], z[0], z[-1]], (x, z, lambda a: a[:, j, :])),
        ("Sagital", lambda a: a[:, :, i][::-1], [y[0], y[-1], z[0], z[-1]], (y, z, lambda a: a[:, :, i])),
    ]
    diff = (res.calc_dose - res.tps_dose) / norm * 100.0
    low = res.tps_dose < 0.1 * norm
    diff = np.where(low & (res.calc_dose < 0.1 * norm), np.nan, diff)
    gam = res.gamma.gamma
    cmap_d = plt.get_cmap("jet").copy()
    cmap_g = ListedColormap(plt.get_cmap("Greens_r")(np.linspace(0.15, 0.85, 128)).tolist()
                            + plt.get_cmap("Reds")(np.linspace(0.45, 1.0, 128)).tolist())
    struct_cols = {s.name: tuple(c / 255 for c in s.color) for s in res.structures}
    out = []
    for title, cut, ext, hv in views:
        ct = cut(res.ct_on_grid)
        h_mm = abs(ext[3] - ext[2])
        w_mm = abs(ext[1] - ext[0])
        aspect = h_mm / max(w_mm, 1e-6)
        fig, axes = plt.subplots(2, 2, figsize=(6.6, 1.2 + 5.6 * min(max(aspect, 0.45), 1.4)))
        axes = axes.ravel()
        for c, (lab, arr) in enumerate((("TPS", res.tps_dose), ("CalcIndep", res.calc_dose))):
            ax = axes[c]
            ax.imshow(ct, cmap="gray", vmin=-500, vmax=500, extent=ext, interpolation="nearest")
            dm = np.ma.masked_less(cut(arr), 0.1 * norm)
            im = ax.imshow(dm, cmap=cmap_d, vmin=0.1 * norm, vmax=1.1 * norm, alpha=0.55, extent=ext,
                           interpolation="nearest")
            ax.set_title(f"{lab} (Gy)", fontsize=13)
            cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.02)
            cb.ax.tick_params(labelsize=11)
        ax = axes[2]
        ax.imshow(ct, cmap="gray", vmin=-500, vmax=500, extent=ext, interpolation="nearest")
        im = ax.imshow(cut(diff), cmap="RdBu_r", norm=TwoSlopeNorm(0, -5, 5), extent=ext, alpha=0.85,
                       interpolation="nearest")
        ax.set_title(f"Diferencia (% de {norm:.2f} Gy)", fontsize=13)
        cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.02)
        cb.ax.tick_params(labelsize=11)
        ax = axes[3]
        ax.imshow(ct, cmap="gray", vmin=-500, vmax=500, extent=ext, interpolation="nearest")
        im = ax.imshow(np.ma.masked_invalid(cut(gam)), cmap=cmap_g, vmin=0, vmax=2, extent=ext,
                       interpolation="nearest")
        ax.set_title("Gamma", fontsize=13)
        cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.02)
        cb.ax.tick_params(labelsize=11)
        for ax in axes:
            for name, m in res.masks.items():
                mm = hv[2](m)
                if mm.any() and not mm.all():
                    ax.contour(hv[0], hv[1], mm.astype(float), levels=[0.5],
                               colors=[struct_cols.get(name, (1, 1, 0))], linewidths=0.8)
            ax.set_xticks([])
            ax.set_yticks([])
        fig.suptitle(title, fontsize=15, fontweight="bold")
        fig.tight_layout()
        out.append((title, _png(fig, dpi=100)))
    return out, (x[i], y[j], z[k])


def _dvh_figure(res, structs):
    """DVH sin leyenda de estructuras (va en HTML debajo de la imagen). Devuelve la imagen y la lista
    de estructuras dibujadas con su color."""
    dmax = max(np.nanmax(res.tps_dose), np.nanmax(res.calc_dose))
    fig, ax = plt.subplots(figsize=(6.2, 4.2))
    drawn = []
    for s in structs:
        m = res.masks.get(s.name)
        if m is None or not m.any():
            continue
        col = tuple(c / 255 for c in s.color)
        d, v = cumulative_dvh(res.tps_dose, m, bin_gy=dmax / 500, dmax=dmax)
        ax.plot(d, v, "-", color=col, lw=1.5)
        d, v = cumulative_dvh(res.calc_dose, m, bin_gy=dmax / 500, dmax=dmax)
        ax.plot(d, v, "--", color=col, lw=1.5)
        drawn.append(s)
    ax.set_xlabel("Dosis (Gy)", fontsize=14)
    ax.set_ylabel("Volumen (%)", fontsize=14)
    ax.tick_params(labelsize=13)
    ax.set_ylim(0, 102)
    ax.set_xlim(0, dmax * 1.05)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    return _png(fig), drawn


def _dvh_legend_html(drawn):
    items = "".join(
        f"<div class='it'><span class='sw' style='border-top-color:#{s.color[0]:02x}{s.color[1]:02x}"
        f"{s.color[2]:02x}'></span>{_esc(s.name)}</div>" for s in drawn)
    return f"<div class='legend'>{items}</div>"


def _gamma_hist(res):
    v = res.gamma.gamma[res.gamma.evaluated & np.isfinite(res.gamma.gamma)]
    fig, ax = plt.subplots(figsize=(6.4, 3.8))
    ax.hist(v, bins=np.linspace(0, res.gamma.settings.max_gamma, 81), color="#4c78a8")
    ax.axvline(1.0, color="#b42318", lw=1)
    ax.set_xlabel("γ", fontsize=12)
    ax.set_ylabel("Número de puntos", fontsize=12)
    ax.tick_params(labelsize=11)
    ax.set_title("Distribución de gamma (puntos evaluados)", fontsize=12)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    return _png(fig)


def _curve_fig(curve):
    fig, ax = plt.subplots(figsize=(6.4, 3.8))
    h = np.linspace(min(-1000, curve.hu[0]), max(3000, curve.hu[-1]), 400)
    ax.plot(h, curve(h), color="#1f5fa8")
    ax.plot(curve.hu, curve.red, "o", color="#1f5fa8", ms=4)
    ax.set_xlabel("Número CT (HU)", fontsize=12)
    ax.set_ylabel("Densidad electrónica relativa", fontsize=12)
    ax.tick_params(labelsize=11)
    ax.grid(alpha=0.3)
    ax.set_title(f"Curva HU–densidad electrónica ({curve.name})", fontsize=12)
    fig.tight_layout()
    return _png(fig)


def write_report(res, path, title="Cálculo independiente de dosis", when=None):
    """Escribe el informe. `path` puede ser el fichero .html o la carpeta de resultados; en ese caso
    el nombre es informe_<ID paciente>_<plan>_<AAAAMMDD-HHMMSS>.html. Devuelve la ruta del fichero."""
    when = when or _dt.datetime.now()
    path = Path(path)
    if path.suffix.lower() not in (".html", ".htm"):
        path.mkdir(parents=True, exist_ok=True)
        path = path / report_filename(res, when)
    cfg = res.config
    gset = res.gamma.settings
    gstats = res.gamma.stats
    thr = cfg.pass_threshold_pct
    ext_name = res.info["density"].get("external")
    global_pass = gstats["pass_pct"]
    structs = _order_structures(res.structures)
    rows = []
    for s in structs:
        st = res.gamma_struct.get(s.name, {})
        mt = res.dvh_tps.get(s.name, {})
        mc = res.dvh_calc.get(s.name, {})
        n = st.get("n", 0)
        gp = st.get("pass_pct")
        gcls = "l"
        if n >= cfg.min_points_structure:
            passed = gp >= thr
            badge = f'<span class="badge {"ok" if passed else "ko"}">{"Cumple" if passed else "No cumple"}</span>'
            gcls = "ok" if passed else "ko"
        else:
            badge = '<span class="badge na">Sin puntos</span>'
            gcls = ""

        def dd(key):
            a, b = mt.get(key), mc.get(key)
            if a is None or b is None or not np.isfinite(a) or a <= 0:
                return "–"
            return f"{(b - a) / a * 100:+.1f}"
        rows.append(
            f"<tr><td class='l'>{_esc(s.name)}</td><td class='l'>{_esc(s.type or '')}</td>"
            f"<td class='{gcls}'>{_f(gp, 1)}</td><td class='l'>{badge}</td>"
            f"<td>{_f(mt.get('volume_cc', 0), 1)}</td><td>{n}</td>"
            f"<td>{_f(st.get('mean'))}</td><td>{_f(st.get('p95'))}</td><td>{_f(st.get('max'))}</td>"
            f"<td>{_f(mt.get('Dmean'))}</td><td>{_f(mc.get('Dmean'))}</td><td>{dd('Dmean')}</td>"
            f"<td>{dd('D95')}</td><td>{dd('D2')}</td><td>{dd('Dmax_0.03cc')}</td></tr>")
    slices, pt = _slices_figures(res)
    dvh_png, dvh_drawn = _dvh_figure(res, [s for s in structs if s.type not in ("SUPPORT", "MARKER",
                                                                              "REGISTRATION")])
    hist_png = _gamma_hist(res)
    curve_png = _curve_fig(res.curve)
    # Dosis en el isocentro
    from scipy.ndimage import map_coordinates
    iso_rows = []
    seen = set()
    for b in res.plan.beams:
        if not b.cps or b.cps[0].iso is None:
            continue
        key = tuple(np.round(b.cps[0].iso, 1))
        if key in seen:
            continue
        seen.add(key)
        f = res.tps_grid.world_to_index(b.cps[0].iso).reshape(3, 1)
        dt = float(map_coordinates(res.tps_dose, f, order=1)[0])
        dc = float(map_coordinates(res.calc_dose, f, order=1)[0])
        diff = (dc - dt) / dt * 100 if dt > 0 else np.nan
        iso_rows.append(f"<tr><td class='l'>({key[0]:.1f}, {key[1]:.1f}, {key[2]:.1f})</td>"
                        f"<td>{dt:.3f}</td><td>{dc:.3f}</td><td>{_f(diff)}</td></tr>")
    beam_rows = []
    for br, b in zip(res.beams, [b for b in res.plan.beams if b.beam_type == "TREATMENT" and b.mu > 0
                                 and b.radiation_type == "PHOTON"]):
        g0 = b.cps[0].gantry
        g1 = b.cps[-1].gantry
        gtxt = f"{g0:.1f}" if not b.is_arc else f"{g0:.1f} → {g1:.1f}"
        beam_rows.append(
            f"<tr><td class='l'>{_esc(b.name)}</td><td class='l'>{_esc(b.machine)}</td><td>{_esc(b.energy)}"
            f"{'' if b.fluence_mode == 'STANDARD' else ' ' + _esc(b.fluence_mode)}</td>"
            f"<td class='l'>{_esc(b.technique)}</td><td>{gtxt}</td><td>{b.cps[0].coll:.1f}</td>"
            f"<td>{b.cps[0].couch:.1f}</td><td>{b.mu:.1f}</td><td>{len(b.cps)}</td>"
            f"<td>{br.n_subbeams}</td><td>{br.n_superpositions}</td><td>{br.seconds:.1f}</td>"
            f"<td class='l'>{_esc(br.model)}</td><td class='l'>{_esc(br.mlc or '–')}</td></tr>")
    warn_html = ""
    if res.warnings:
        warn_html = "<div class='alert'><strong>Avisos</strong><ul>" + "".join(
            f"<li>{_esc(w)}</li>" for w in res.warnings) + "</ul></div>"
    info = res.info
    tg = info["tps_grid"]
    cg = info["calc_grid"]
    dens = info["density"]
    plan = res.plan
    from .pipeline import verdict as _verdict
    ok, fails = _verdict(res)
    verdict_cls = "ok" if ok else "ko"
    verdict_txt = "Cumple" if ok else "No cumple"
    if fails:
        fails_txt = ("No cumple porque estas estructuras quedan por debajo del umbral: "
                     + ", ".join(_esc(f) for f in fails))
    else:
        fails_txt = "Todas las estructuras con puntos evaluados superan el umbral."
    now = when.strftime("%Y-%m-%d %H:%M:%S")
    models_html = "".join(
        f"<tr><td class='l'>{_esc(m['name'])}</td><td>{_esc(m['energy'])}</td><td>{_esc(m['fluence_mode'])}</td>"
        f"<td>{'Sí' if m['commissioned'] else '<span class=ko>No</span>'}</td><td>{m['cgy_per_unit']:.4g}</td></tr>"
        for m in info["models"])
    ov = ", ".join(f"{_esc(n)} = {v:.3f}" for n, v in dens["overrides"]) or "ninguna"
    rx = '' if not plan.prescription_gy else f' · prescripción {plan.prescription_gy:.2f} Gy'
    slices_html = "".join(f'<img src="{png}" alt="Corte {t.lower()}: dosis, diferencia y gamma">'
                          for t, png in slices)
    pname = _person_name(info.get("patient_name"))
    doc = f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_esc(info['patient_id'])} · {_esc(plan.label)} · {_esc(title)}</title><style>{CSS}</style></head><body><main>
<header class="head">
<div class="kicker">{_esc(title)}</div>
<div class="patient">{_esc(pname)}</div>
<div class="pid">ID {_esc(info['patient_id'])}</div>
<div class="plan">Plan {_esc(plan.label)}</div>
<div class="sub">{plan.n_fractions} fracciones{rx} · generado {now} con CalcIndep {__version__}</div>
</header>
<div class="verdict">
 <div class="card"><div class="k">Resultado global</div><div class="v {verdict_cls}">{verdict_txt}</div>
   <div class="small">Umbral {thr:g}% en el External ({_esc(ext_name or 'toda la rejilla')}) y en cada estructura</div></div>
 <div class="card"><div class="k">Gamma {gset.dose_pct:g}%/{gset.dta_mm:g} mm</div>
   <div class="v">{_f(global_pass, 1)}%</div><div class="small">{gstats['n']} puntos evaluados</div></div>
 <div class="card"><div class="k">γ medio / p95</div><div class="v">{_f(gstats['mean'])} / {_f(gstats['p95'])}</div>
   <div class="small">γ máx. {_f(gstats['max'])}</div></div>
 <div class="card"><div class="k">Normalización</div><div class="v">{res.gamma.norm_gy:.2f} Gy</div>
   <div class="small">{_esc(gset.normalization)}</div></div>
</div>
<p class="small">{fails_txt}</p>
{warn_html}

<h2>Gamma y dosimetría por estructura</h2>
<p class="small">Criterio: {_esc(gset.describe())}. Radio de búsqueda {gset.max_gamma:g} × DTA, paso de
interpolación DTA/{gset.interp_fraction}. γ = {gset.max_gamma:g} indica γ ≥ {gset.max_gamma:g}. En verde, las
estructuras con γ ≤ 1 en al menos el {thr:g}% de los puntos; en rojo, las que no llegan. Las diferencias
dosimétricas son (cálculo − TPS)/TPS en %.</p>
<div class="scroll"><table>
<tr><th class='l'>Estructura</th><th class='l'>Tipo</th><th>γ≤1 (%)</th><th class='l'>Estado</th><th>Vol. (cc)</th>
<th>Puntos</th><th>γ medio</th><th>γ p95</th><th>γ máx.</th><th>Dmedia TPS (Gy)</th><th>Dmedia calc. (Gy)</th>
<th>ΔDmedia %</th><th>ΔD95 %</th><th>ΔD2 %</th><th>ΔDmáx 0.03cc %</th></tr>
{''.join(rows)}
</table></div>

<h2>Cortes por el isocentro</h2>
<p class="small">Punto: x = {pt[0]:.1f} mm, y = {pt[1]:.1f} mm, z = {pt[2]:.1f} mm. La diferencia se muestra donde
alguna de las dos dosis supera el 10% de la normalización.</p>
<div class="imgs">{slices_html}</div>

<h2>Histograma dosis-volumen (DVH)</h2>
<div class="figwrap">
<div class="legend styles"><div class="it"><span class="sw" style="border-top-color:#374151"></span>TPS</div>
<div class="it"><span class="sw d" style="border-top-color:#374151"></span>CalcIndep</div></div>
<img src="{dvh_png}" alt="DVH">
{_dvh_legend_html(dvh_drawn)}
</div>

<div class="grid2">
<div><h2>Distribución de gamma</h2><img src="{hist_png}" alt="Histograma gamma"></div>
<div><h2>Dosis en el isocentro</h2><div class="scroll"><table><tr><th class='l'>Isocentro (mm)</th><th>TPS (Gy)</th>
<th>Cálculo (Gy)</th><th>Dif. %</th></tr>
{''.join(iso_rows)}</table></div></div>
</div>

<h2>Haces</h2>
<div class="scroll"><table><tr><th class='l'>Haz</th><th class='l'>Máquina</th><th>Energía</th><th class='l'>Técnica</th>
<th>Gantry</th><th>Colim.</th><th>Mesa</th><th>UM</th><th>Puntos control</th><th>Incidencias</th>
<th>Superposiciones</th><th>Tiempo (s)</th><th class='l'>Modelo</th><th class='l'>MLC y parámetros</th></tr>{''.join(beam_rows)}</table></div>

<h2>Modelos de haz</h2>
<div class="scroll"><table><tr><th class='l'>Modelo</th><th>Energía</th><th>Fluencia</th><th>Comisionado</th><th>cGy/unidad</th></tr>{models_html}</table></div>

<div class="grid2">
<div><h2>Densidades</h2><img src="{curve_png}" alt="Curva HU-ED">
<p class="small">Fuera del External: {'aire' if res.config.options.outside_external == 'air' else 'según CT'}.
Estructuras de soporte conservadas: {', '.join(_esc(s) for s in dens['support']) or 'ninguna'}.
Densidades asignadas por estructura: {ov}.</p></div>
<div><h2>Parámetros del cálculo</h2><dl class="kv">
<dt>Algoritmo</dt><dd>Convolución-superposición collapsed cone con kernels EGSnrc (EDKnrc), escalado por densidad electrónica</dd>
<dt>Rejilla TPS</dt><dd>{tg.shape[2]}×{tg.shape[1]}×{tg.shape[0]}, paso {tg.spacing[0]:.2f}×{tg.spacing[1]:.2f}×{tg.spacing[2]:.2f} mm</dd>
<dt>Rejilla de cálculo</dt><dd>{cg.shape[2]}×{cg.shape[1]}×{cg.shape[0]}, paso {cg.spacing[0]:.2f}×{cg.spacing[1]:.2f}×{cg.spacing[2]:.2f} mm</dd>
<dt>Resolución de fluencia</dt><dd>{res.config.options.fluence_res_mm:g} mm</dd>
<dt>Paso de gantry en arcos</dt><dd>{res.config.options.max_gantry_step_deg:g}°, sectores de superposición de {res.config.options.sector_deg:g}°</dd>
<dt>Suma de dosis TPS</dt><dd>{_esc(info['dose_summation'])}; factor de fracciones aplicado {info['fraction_factor']:g}</dd>
<dt>Tiempo total</dt><dd>{info['elapsed_s']:.0f} s</dd>
<dt>Superposición</dt><dd>{_esc(info.get('superposition', 'CPU (numba)'))}</dd>
<dt>RTPLAN</dt><dd class="small">{_esc(Path(info['rtplan']).name)}</dd>
<dt>RTDOSE</dt><dd class="small">{', '.join(_esc(Path(p).name) for p in info['rtdose_files'])}</dd>
</dl></div></div>
<p class="small" style="margin-top:28px">Herramienta de verificación de desarrollo propio. No es un producto sanitario
certificado. Los resultados dependen del comisionado del modelo de haz y de la curva HU–densidad electrónica.</p>
</main></body></html>"""
    path.write_text(doc, encoding="utf-8")
    return path
