"""Informe HTML del comisionado del modelo de haz."""
import datetime as _dt
import html
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from ..mlc import display_name  # noqa: E402
from ..report import CSS, _png  # noqa: E402


def _e(s):
    return html.escape(str(s))


def _curve_plot(items, title):
    fig, axes = plt.subplots(2, 1, figsize=(7.5, 5.6), sharex=True, gridspec_kw={"height_ratios": [3, 1]})
    cols = plt.get_cmap("tab10")
    for n, r in enumerate(items):
        c = r["curve"]
        xm, vm = c.normalized()
        col = cols(n % 10)
        lab = f"{c.field_x_mm / 10:g}x{c.field_y_mm / 10:g}" + ("" if c.kind == "pdd" else f" {c.depth_mm / 10:g} cm {c.axis}")
        axes[0].plot(xm, vm, "o", ms=2.2, color=col, alpha=0.7)
        axes[0].plot(r["x_calc"], r["v_calc"], "-", lw=1.1, color=col, label=lab)
        d = np.interp(xm, r["x_calc"], r["v_calc"]) - vm
        axes[1].plot(xm, d, "-", lw=0.9, color=col)
    axes[0].set_ylabel("Dosis relativa (%)")
    axes[0].grid(alpha=0.3)
    axes[0].legend(fontsize=7, ncol=2, frameon=False)
    axes[0].set_title(title + " · puntos: medida, línea: cálculo", fontsize=10)
    axes[1].set_ylabel("Cálc. − med. (%)")
    axes[1].set_ylim(-5, 5)
    axes[1].axhline(0, color="k", lw=0.6)
    axes[1].grid(alpha=0.3)
    axes[1].set_xlabel("Profundidad (mm)" if items[0]["curve"].kind == "pdd" else "Posición (mm)")
    fig.tight_layout()
    return _png(fig)


def _spectrum_plot(model):
    fig, ax = plt.subplots(figsize=(5.5, 3.2))
    ax.bar(model.energies, model.weights, width=0.4, color="#4c78a8")
    ax.set_xlabel("Energía (MeV)")
    ax.set_ylabel("Fracción de fotones")
    ax.set_title("Espectro ajustado", fontsize=10)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    return _png(fig)


def _oa_plot(model):
    fig, ax = plt.subplots(figsize=(5.5, 3.2))
    ax.plot(model.oa_radius_mm, model.oa_factor, "o-", color="#1f5fa8", ms=3)
    ax.set_xlabel("Radio en el isocentro (mm)")
    ax.set_ylabel("Factor de fluencia")
    ax.set_title("Perfil radial de fluencia", fontsize=10)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    return _png(fig)


def write_commissioning_report(path, comm, val, of_res):
    m = comm.model
    pdds = [r for r in val if r["curve"].kind == "pdd"]
    profs = [r for r in val if r["curve"].kind == "profile"]
    figs = []
    by_ssd = {}
    for r in pdds:
        by_ssd.setdefault(r["curve"].ssd_mm, []).append(r)
    for ssd, items in sorted(by_ssd.items()):
        figs.append(_curve_plot(sorted(items, key=lambda r: r["curve"].field_x_mm), f"PDD DFS {ssd / 10:g} cm"))
    by_f = {}
    for r in profs:
        c = r["curve"]
        by_f.setdefault((c.field_x_mm, c.field_y_mm, c.ssd_mm, c.axis), []).append(r)
    for (fx, fy, ssd, ax), items in sorted(by_f.items()):
        figs.append(_curve_plot(sorted(items, key=lambda r: r["curve"].depth_mm),
                                f"Perfiles {ax} campo {fx / 10:g}x{fy / 10:g} DFS {ssd / 10:g} cm"))
    rows = []
    for r in val:
        c = r["curve"]
        gp = r["gamma_pass"]
        cls = "ok" if np.isfinite(gp) and gp >= 95 else "ko"
        extra = ""
        if c.kind == "pdd":
            extra = f"{r['pdd10_meas']:.1f} / {r['pdd10_calc']:.1f}"
        rows.append(f"<tr><td class='l'>{_e(c.label)}</td><td class='{cls}'>{gp:.1f}</td>"
                    f"<td>{r['max_abs_diff_core']:.2f}</td><td>{extra}</td></tr>")
    of_rows = "".join(
        f"<tr><td>{o['fx'] / 10:g}x{o['fy'] / 10:g}</td><td>{o['meas']:.4f}</td><td>{o['calc']:.4f}</td>"
        f"<td class='{'ok' if abs(o['diff_pct']) <= 1.0 else ('warn' if abs(o['diff_pct']) <= 2.0 else 'ko')}'>{o['diff_pct']:+.2f}</td></tr>"
        for o in of_res)
    params = [
        ("Energía media del espectro", f"{np.sum(m.weights * m.energies):.3f} MeV"),
        ("Contaminación electrónica", f"w = {m.econt_weight:.4f}, k = {m.econt_k_per_cm:g} cm⁻¹, σ = {m.econt_sigma_mm:g} mm"),
        ("Ablandamiento fuera de eje", (f"μ(r) = μ (1 + s r), s = {m.softening_per_cm:g} cm⁻¹" if m.softening_power == 1
                                        else f"μ(r) = μ (1 + s r²), s = {m.softening_per_cm:g} cm⁻²" if m.softening_power == 2
                                        else f"μ(r) = μ (1 + s r^{m.softening_power:g}), s = {m.softening_per_cm:g}")
                                       + f" (r hasta {m.softening_rmax_cm:g} cm)"),
        ("Fuente primaria", f"σ = {m.primary_sigma_mm:g} mm"),
        ("Colimador primario", (f"radio {m.primary_collimator_radius_mm:g} mm, σ {m.primary_collimator_sigma_mm:g} mm"
                                if m.primary_collimator_radius_mm > 0 else "no modelado")),
        ("Fuente extrafocal", f"w = {m.extrafocal_weight:.4f}, σx = {m.ef_sigmas[0]:g} mm, σy = {m.ef_sigmas[1]:g} mm"),
        ("MLC", "; ".join(f"{display_name(k)}: transmisión {v['transmission']:g}, DLG {v['dlg_mm']:g} mm, "
                          f"lengüeta-ranura {v['tg_width_mm']:g} mm" for k, v in m.mlc.items()) or "ninguno"),
        ("Transmisión de mandíbulas", f"{m.jaw_transmission:g}"),
        ("Inclinación del kernel", (f"sí, direcciones nodales cada {comm.engine.options.tilt_tile_deg:g}° "
                                    f"(campos con semiapertura > {comm.engine.options.tilt_min_halfangle_deg:g}°)"
                                    if comm.engine.options.kernel_tilt and m.kernel_tilt else "no")),
        ("Calibración", f"{m.calibration.dose_per_mu_cgy:g} cGy/UM, DFS {m.calibration.ssd_mm / 10:g} cm, "
                        f"prof. {m.calibration.depth_mm / 10:g} cm, campo {m.calibration.field_mm / 10:g} cm; "
                        f"{m.calibration.cgy_per_unit:.5g} cGy/unidad con rejilla {m.calibration.grid_mm:g} mm"),
    ]
    log_html = "".join(f"<li>{_e(l)}</li>" for l in comm.log)
    times = ", ".join(f"{k}: {v:.0f} s" for k, v in comm.timing.items())
    doc = f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Comisionado {_e(m.name)}</title><style>{CSS}</style></head><body><main>
<h1>Comisionado del modelo de haz</h1>
<div class="sub">{_e(m.name)} · máquina {_e(m.machine)} · {_e(m.energy)} {_e(m.fluence_mode)} ·
generado {_dt.datetime.now().strftime('%Y-%m-%d %H:%M')} · rejilla {comm.cfg.grid_mm:g} mm</div>
<div class="alert">Revise las curvas y los factores de campo antes de usar el modelo. El ajuste usa la misma
rejilla que se empleará en los cálculos clínicos; si cambia el tamaño de vóxel, repita la calibración.</div>
<h2>Parámetros del modelo</h2>
<div class="grid2"><div><dl class="kv">{''.join(f'<dt>{_e(k)}</dt><dd>{_e(v)}</dd>' for k, v in params)}</dl></div>
<div><img src="{_spectrum_plot(m)}" alt="Espectro"><img src="{_oa_plot(m)}" alt="Perfil radial"></div></div>
<h2>Resumen por curva</h2>
<p class="small">Gamma 1D global 2%/2 mm con umbral del 10%. Diferencia máxima en la región central
(PDD más allá de dmáx; perfiles dentro del 80% del campo).</p>
<div class="scroll"><table><tr><th class='l'>Curva</th><th>γ≤1 (%)</th><th>|Dif.| máx. central (%)</th>
<th>PDD10 med. / calc.</th></tr>{''.join(rows)}</table></div>
<h2>Factores de campo</h2>
<table><tr><th>Campo (cm)</th><th>Medido</th><th>Calculado</th><th>Dif. (%)</th></tr>{of_rows or '<tr><td colspan=4>Sin datos</td></tr>'}</table>
<h2>Curvas</h2>
<div class="grid2">{''.join(f'<div><img src="{f}" alt="curva"></div>' for f in figs)}</div>
<h2>Registro del ajuste</h2><ul class="small">{log_html}</ul>
<p class="small">Tiempos: {times}</p>
</main></body></html>"""
    Path(path).write_text(doc, encoding="utf-8")
    return path
