"""Visor de cortes (TPS, cálculo, diferencia y gamma), perfiles de dosis e histograma dosis-volumen (DVH)."""
import tkinter as tk
from tkinter import ttk

import numpy as np
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg, NavigationToolbar2Tk
from matplotlib.cm import ScalarMappable
from matplotlib.colors import ListedColormap, Normalize, TwoSlopeNorm
from matplotlib.figure import Figure
import matplotlib
from scipy.ndimage import map_coordinates

from ..dvh import cumulative_dvh
from .widgets import WrapLabel, px

GAMMA_CMAP = ListedColormap(
    matplotlib.colormaps["Greens_r"](np.linspace(0.15, 0.85, 128)).tolist()
    + matplotlib.colormaps["Reds"](np.linspace(0.45, 1.0, 128)).tolist())
NON_ANATOMIC = ("SUPPORT", "MARKER", "REGISTRATION", "FIXATION", "CONTROL", "BOLUS")
COL_TPS = "#1f5fa8"
COL_CALC = "#d62728"
MAX_TXT = "Maximizar visor"
RESTORE_TXT = "Restaurar panel"
PROFILE_DIRS = ("Libre", "Horizontal", "Vertical")


def _rgb(s):
    return tuple(c / 255.0 for c in s.color)


def _toolbar_busy(tb):
    """True si la barra de matplotlib está en modo zoom o desplazamiento."""
    mode = getattr(tb, "mode", "")
    return bool(getattr(mode, "value", mode))


class SliceViewer(ttk.Frame):
    TITLES = ("Dosis TPS (Gy)", "Cálculo independiente (Gy)", "Diferencia (% de la normalización)", "Gamma")

    def __init__(self, master, on_maximize=None):
        super().__init__(master)
        self.res = None
        self.orient = tk.StringVar(value="Axial")
        self.show_contours = tk.BooleanVar(value=True)
        self.profile_on = tk.BooleanVar(value=False)
        self.profile_dir = tk.StringVar(value="Libre")
        self.idx = {"Axial": 0, "Coronal": 0, "Sagital": 0}
        self.profiles = {}          # orientación -> ((h0, v0), (h1, v1)) en mm
        self._drag = None
        self._drag_lines = []
        self._prof_data = None
        self._pending = None
        self._last_orient = None
        # Controles (dos filas para que quepan aunque el panel sea estrecho)
        top = ttk.Frame(self)
        top.pack(fill="x", pady=(0, 2))
        if on_maximize is not None:
            self.max_btn = ttk.Button(top, text=MAX_TXT, command=on_maximize)
            self.max_btn.pack(side="right", padx=(8, 0))
        else:
            self.max_btn = None
        for o in ("Axial", "Coronal", "Sagital"):
            ttk.Radiobutton(top, text=o, value=o, variable=self.orient, command=self._orient_changed).pack(
                side="left", padx=(0, 8))
        ttk.Button(top, text="Ir al isocentro", command=self.goto_iso).pack(side="left", padx=(8, 4))
        ttk.Button(top, text="Ir al máximo de dosis", command=self.goto_max).pack(side="left", padx=4)
        ttk.Checkbutton(top, text="Contornos", variable=self.show_contours,
                        command=self.schedule).pack(side="left", padx=8)
        top2 = ttk.Frame(self)
        top2.pack(fill="x", pady=(0, 4))
        ttk.Checkbutton(top2, text="Perfil", variable=self.profile_on, style="Toolbutton",
                        command=self._profile_toggled).pack(side="left", padx=(0, 6), ipadx=8)
        ttk.Label(top2, text="Dirección").pack(side="left", padx=(4, 4))
        self.dir_cb = ttk.Combobox(top2, textvariable=self.profile_dir, values=PROFILE_DIRS, state="disabled",
                                   width=11)
        self.dir_cb.pack(side="left", padx=(0, 4))
        self.clear_prof_btn = ttk.Button(top2, text="Borrar perfil", command=self.clear_profile, state="disabled")
        self.clear_prof_btn.pack(side="left", padx=4)
        self.slice_lbl = ttk.Label(top2, text="")
        self.slice_lbl.pack(side="right", padx=(8, 0))
        self.scale = ttk.Scale(self, orient="horizontal", from_=0, to=1, command=self._scale_moved)
        self.scale.pack(fill="x")
        self.readout = ttk.Label(self, text="Mueva el cursor sobre la imagen para ver los valores.",
                                 foreground="#5b6475")
        self.readout.pack(side="bottom", fill="x", pady=(2, 0))
        # Imágenes arriba y perfil abajo, con separador ajustable
        self.vpw = ttk.Panedwindow(self, orient="vertical")
        self.vpw.pack(fill="both", expand=True)
        body = ttk.Frame(self.vpw)
        self.vpw.add(body, weight=3)
        side = ttk.Frame(body)
        side.pack(side="right", fill="y", padx=(6, 0))
        ttk.Label(side, text="Estructuras").pack(anchor="w")
        self.lb = tk.Listbox(side, selectmode="extended", exportselection=False, width=18, height=10,
                             selectbackground="#e3e8ef", activestyle="none")
        self.lb.pack(fill="y", expand=True)
        self.lb.bind("<<ListboxSelect>>", lambda e: self.schedule())
        figf = ttk.Frame(body)
        figf.pack(side="left", fill="both", expand=True)
        # Tamaño inicial pequeño: el lienzo se adapta al espacio disponible.
        self.fig = Figure(figsize=(5, 4), dpi=96)
        self.canvas = FigureCanvasTkAgg(self.fig, master=figf)
        self.toolbar = NavigationToolbar2Tk(self.canvas, figf, pack_toolbar=False)
        self.toolbar.update()
        self.toolbar.pack(side="bottom", fill="x")
        self.canvas.get_tk_widget().pack(fill="both", expand=True)
        self.canvas.mpl_connect("motion_notify_event", self._motion)
        self.canvas.mpl_connect("button_press_event", self._press)
        self.canvas.mpl_connect("button_release_event", self._release)
        # Panel del perfil (solo visible con la herramienta activa)
        self.prof_frame = ttk.Frame(self.vpw)
        self.prof_lbl = WrapLabel(self.prof_frame, text="", foreground="#374151", initial=600)
        self.prof_lbl.pack(fill="x", padx=4, pady=(4, 0))
        self.pfig = Figure(figsize=(5, 1.6), dpi=96, layout="tight")
        self.pcanvas = FigureCanvasTkAgg(self.pfig, master=self.prof_frame)
        self.pcanvas.get_tk_widget().pack(fill="both", expand=True)
        self.pcanvas.mpl_connect("motion_notify_event", self._profile_motion)
        self.axes = []
        self._placeholder()

    # ------------------------------------------------------------------
    def set_maximized(self, maximized):
        if self.max_btn is not None:
            self.max_btn.configure(text=RESTORE_TXT if maximized else MAX_TXT)

    def _placeholder(self):
        self.fig.clf()
        self.axes = []
        ax = self.fig.add_subplot(111)
        ax.text(0.5, 0.5, "Sin resultados.\nCalcule un plan para ver las distribuciones.",
                ha="center", va="center", color="#6b7280", fontsize=11)
        ax.set_axis_off()
        self.canvas.draw_idle()
        self.profiles = {}
        self._draw_profile()

    def set_result(self, res):
        self.res = res
        g = res.tps_grid
        self.x, self.y, self.z = g.axes()
        self.norm = res.gamma.norm_gy
        n = self.norm
        d = (res.calc_dose - res.tps_dose) / n * 100.0
        low = (res.tps_dose < 0.1 * n) & (res.calc_dose < 0.1 * n)
        self.diff = np.where(low, np.nan, d)
        self.profiles = {}
        self.structs = [s for s in res.structures if res.masks.get(s.name) is not None and res.masks[s.name].any()]
        self.lb.delete(0, "end")
        for i, s in enumerate(self.structs):
            self.lb.insert("end", s.name)
            col = "#%02x%02x%02x" % tuple(s.color)
            self.lb.itemconfigure(i, foreground=col, selectforeground=col)
            if s.type not in NON_ANATOMIC:
                self.lb.selection_set(i)
        # Figura con 4 paneles de ejes compartidos y barras de color fijas.
        self.fig.clf()
        a0 = self.fig.add_subplot(221)
        self.axes = [a0] + [self.fig.add_subplot(222 + i, sharex=a0, sharey=a0) for i in range(3)]
        dose_n = Normalize(0.1 * n, 1.1 * n)
        self.maps = [("dose", "jet", dose_n), ("dose", "jet", dose_n),
                     ("diff", "RdBu_r", TwoSlopeNorm(0, -5, 5)), ("gamma", GAMMA_CMAP, Normalize(0, 2))]
        labels = ("Gy", "Gy", "%", "γ")
        for ax, (kind, cmap, nrm), lab in zip(self.axes, self.maps, labels):
            cb = self.fig.colorbar(ScalarMappable(nrm, cmap), ax=ax, fraction=0.046, pad=0.02)
            cb.set_label(lab, fontsize=9)
            cb.ax.tick_params(labelsize=8)
        self.fig.subplots_adjust(left=0.07, right=0.94, top=0.94, bottom=0.06, wspace=0.10, hspace=0.18)
        self._last_orient = None
        self.goto_iso()

    # ------------------------------------------------------------------
    def _iso_index(self):
        res = self.res
        for b in res.plan.beams:
            if b.cps and b.cps[0].iso is not None:
                f = res.tps_grid.world_to_index(b.cps[0].iso)
                k, j, i = np.round(f).astype(int)
                sh = res.tps_grid.shape
                if 0 <= k < sh[0] and 0 <= j < sh[1] and 0 <= i < sh[2]:
                    return k, j, i
        return np.unravel_index(int(np.nanargmax(res.tps_dose)), res.tps_dose.shape)

    def goto_iso(self):
        if self.res is None:
            return
        self._goto(*self._iso_index())

    def goto_max(self):
        if self.res is None:
            return
        self._goto(*np.unravel_index(int(np.nanargmax(self.res.tps_dose)), self.res.tps_dose.shape))

    def _goto(self, k, j, i):
        self.idx = {"Axial": int(k), "Coronal": int(j), "Sagital": int(i)}
        self._sync_scale()
        self.schedule()

    def _nslices(self):
        sh = self.res.tps_grid.shape
        return {"Axial": sh[0], "Coronal": sh[1], "Sagital": sh[2]}[self.orient.get()]

    def _sync_scale(self):
        if self.res is None:
            return
        n = self._nslices()
        self.scale.configure(from_=0, to=max(n - 1, 0))
        self.scale.set(self.idx[self.orient.get()])

    def _orient_changed(self):
        self._sync_scale()
        self.schedule()

    def _scale_moved(self, val):
        if self.res is None:
            return
        o = self.orient.get()
        v = int(round(float(val)))
        if v != self.idx[o]:
            self.idx[o] = v
            self.schedule()

    def schedule(self):
        if self._pending is not None:
            self.after_cancel(self._pending)
        self._pending = self.after(40, self.draw)

    # ------------------------------------------------------------------
    def _cut(self, a):
        o = self.orient.get()
        k = self.idx[o]
        if o == "Axial":
            return a[k]
        if o == "Coronal":
            return a[:, k, :]
        return a[:, :, k]

    def _coords(self):
        o = self.orient.get()
        if o == "Axial":
            return self.x, self.y
        if o == "Coronal":
            return self.x, self.z
        return self.y, self.z

    def _hv_names(self):
        return {"Axial": ("x", "y"), "Coronal": ("x", "z"), "Sagital": ("y", "z")}[self.orient.get()]

    def draw(self):
        self._pending = None
        if self.res is None:
            return
        res = self.res
        o = self.orient.get()
        h, v = self._coords()
        dh = h[1] - h[0] if h.size > 1 else 1.0
        dv = v[1] - v[0] if v.size > 1 else 1.0
        if o == "Axial":
            ext = [h[0] - dh / 2, h[-1] + dh / 2, v[-1] + dv / 2, v[0] - dv / 2]
            origin = "upper"
        else:
            ext = [h[0] - dh / 2, h[-1] + dh / 2, v[0] - dv / 2, v[-1] + dv / 2]
            origin = "lower"
        keep = None
        if self._last_orient == o and self.axes:
            keep = (self.axes[0].get_xlim(), self.axes[0].get_ylim())
        ct = self._cut(res.ct_on_grid)
        arrays = (res.tps_dose, res.calc_dose, self.diff, res.gamma.gamma)
        sel = [self.structs[i] for i in self.lb.curselection()] if self.show_contours.get() else []
        prof = self.profiles.get(o) if self.profile_on.get() else None
        self._drag_lines = []
        for ax, arr, (kind, cmap, nrm), title in zip(self.axes, arrays, self.maps, self.TITLES):
            ax.clear()
            ax.imshow(ct, cmap="gray", vmin=-500, vmax=500, extent=ext, origin=origin, interpolation="nearest")
            sl = self._cut(arr)
            if kind == "dose":
                sl = np.ma.masked_less(sl, 0.1 * self.norm)
                alpha = 0.55
            else:
                sl = np.ma.masked_invalid(sl)
                alpha = 0.85
            ax.imshow(sl, cmap=cmap, norm=nrm, alpha=alpha, extent=ext, origin=origin, interpolation="nearest")
            for s in sel:
                m = self._cut(res.masks[s.name])
                if m.any() and not m.all():
                    ax.contour(h, v, m.astype(float), levels=[0.5], colors=[_rgb(s)], linewidths=0.9)
            ax.set_autoscale_on(False)
            if prof is not None:
                self._draw_profile_line(ax, *prof)
            ax.set_title(title, fontsize=10)
            ax.tick_params(labelsize=8)
            ax.set_aspect("equal")
        # Ejes compartidos: solo se rotulan la columna izquierda y la fila inferior.
        for i, ax in enumerate(self.axes):
            ax.tick_params(labelleft=i in (0, 2), labelbottom=i in (2, 3))
        if keep:
            self.axes[0].set_xlim(keep[0])
            self.axes[0].set_ylim(keep[1])
        self._last_orient = o
        k = self.idx[o]
        pos = {"Axial": self.z, "Coronal": self.y, "Sagital": self.x}[o][k]
        axis = {"Axial": "z", "Coronal": "y", "Sagital": "x"}[o]
        self.slice_lbl.configure(text=f"Corte {k + 1}/{self._nslices()}  ·  {axis} = {pos:.1f} mm")
        self.canvas.draw_idle()
        self._draw_profile()

    @staticmethod
    def _draw_profile_line(ax, p0, p1):
        xs, ys = [p0[0], p1[0]], [p0[1], p1[1]]
        ax.plot(xs, ys, "-", color="black", lw=3.0, alpha=0.6, solid_capstyle="round")
        ax.plot(xs, ys, "-", color="#ffd400", lw=1.5)
        for (x, y), lab in ((p0, "A"), (p1, "B")):
            ax.plot([x], [y], "o", ms=5, mfc="#ffd400", mec="black", mew=0.8)
            ax.annotate(lab, (x, y), xytext=(4, 4), textcoords="offset points", fontsize=9, color="#ffd400",
                        fontweight="bold")

    # ------------------------------------------------------------------
    # Herramienta de perfil
    # ------------------------------------------------------------------
    def _profile_toggled(self):
        on = self.profile_on.get()
        self.dir_cb.configure(state="readonly" if on else "disabled")
        self.clear_prof_btn.configure(state="normal" if on else "disabled")
        panes = [str(p) for p in self.vpw.panes()]
        if on and str(self.prof_frame) not in panes:
            self.vpw.add(self.prof_frame, weight=1)
            self.after(80, self._place_sash)
        elif not on and str(self.prof_frame) in panes:
            self.vpw.forget(self.prof_frame)
        if on:
            self.readout.configure(text="Perfil: arrastre sobre una imagen para trazar la línea (dirección «Libre»), "
                                        "o haga clic con «Horizontal» o «Vertical». Los iconos de zoom y "
                                        "desplazamiento de la barra deben estar desactivados.")
        self.schedule()

    def _place_sash(self):
        try:
            h = self.vpw.winfo_height()
            if h > 100:
                self.vpw.sashpos(0, int(h * 0.62))
        except tk.TclError:
            pass

    def clear_profile(self):
        self.profiles.pop(self.orient.get(), None)
        self.schedule()

    def _clip_hv(self, x, y):
        h, v = self._coords()
        return (float(np.clip(x, min(h[0], h[-1]), max(h[0], h[-1]))),
                float(np.clip(y, min(v[0], v[-1]), max(v[0], v[-1]))))

    def _press(self, ev):
        if (not self.profile_on.get() or self.res is None or ev.button != 1 or ev.inaxes not in self.axes
                or ev.xdata is None or _toolbar_busy(self.toolbar)):
            return
        o = self.orient.get()
        h, v = self._coords()
        mode = self.profile_dir.get()
        x, y = self._clip_hv(ev.xdata, ev.ydata)
        if mode == "Horizontal":
            self.profiles[o] = ((float(h[0]), y), (float(h[-1]), y))
            self.schedule()
            return
        if mode == "Vertical":
            v0, v1 = (v[0], v[-1]) if o == "Axial" else (v[-1], v[0])   # de arriba abajo en pantalla
            self.profiles[o] = ((x, float(v0)), (x, float(v1)))
            self.schedule()
            return
        self._drag = (x, y)
        self._drag_lines = [ax.plot([x, x], [y, y], "-", color="#ffd400", lw=1.5)[0] for ax in self.axes]
        self.canvas.draw_idle()

    def _release(self, ev):
        if self._drag is None:
            return
        p0 = self._drag
        self._drag = None
        if ev.inaxes in self.axes and ev.xdata is not None:
            p1 = self._clip_hv(ev.xdata, ev.ydata)
        elif self._drag_lines:
            xd, yd = self._drag_lines[0].get_data()
            p1 = (float(xd[-1]), float(yd[-1]))
        else:
            p1 = p0
        if np.hypot(p1[0] - p0[0], p1[1] - p0[1]) >= 2.0:
            self.profiles[self.orient.get()] = (p0, p1)
        self.schedule()

    def _sample_profile(self):
        """Dosis TPS y calculada a lo largo de la línea del perfil en el corte actual."""
        o = self.orient.get()
        prof = self.profiles.get(o)
        if self.res is None or prof is None:
            return None
        (h0, v0), (h1, v1) = prof
        g = self.res.tps_grid
        sp, org = g.spacing, g.origin
        length = float(np.hypot(h1 - h0, v1 - v0))
        step = 0.25 * float(min(sp))
        n = max(2, int(np.ceil(length / step)) + 1)
        t = np.linspace(0.0, 1.0, n)
        hs, vs = h0 + t * (h1 - h0), v0 + t * (v1 - v0)
        k = self.idx[o]
        if o == "Axial":
            xs, ys, zs = hs, vs, np.full(n, self.z[k])
        elif o == "Coronal":
            xs, ys, zs = hs, np.full(n, self.y[k]), vs
        else:
            xs, ys, zs = np.full(n, self.x[k]), hs, vs
        fi, fj, fk = (xs - org[0]) / sp[0], (ys - org[1]) / sp[1], (zs - org[2]) / sp[2]
        coords = np.vstack([fk, fj, fi])
        sh = g.shape
        inside = ((fk >= -0.5) & (fk <= sh[0] - 0.5) & (fj >= -0.5) & (fj <= sh[1] - 0.5)
                  & (fi >= -0.5) & (fi <= sh[2] - 0.5))
        dt = map_coordinates(self.res.tps_dose, coords, order=1, mode="nearest")
        dc = map_coordinates(self.res.calc_dose, coords, order=1, mode="nearest")
        dt = np.where(inside, dt, np.nan)
        dc = np.where(inside, dc, np.nan)
        diff = (dc - dt) / self.norm * 100.0
        diff = np.where((dt < 0.1 * self.norm) & (dc < 0.1 * self.norm), np.nan, diff)
        return {"d": t * length, "tps": dt, "calc": dc, "diff": diff, "xyz": (xs, ys, zs), "length": length,
                "p0": (h0, v0), "p1": (h1, v1)}

    def _draw_profile(self):
        if not self.profile_on.get():
            self._prof_data = None
            return
        self.pfig.clf()
        ax = self.pfig.add_subplot(111)
        data = self._sample_profile()
        self._prof_data = data
        if data is None:
            self.prof_lbl.configure(text="")
            ax.text(0.5, 0.5, "Trace un perfil sobre cualquiera de las imágenes de este corte." if self.res
                    else "Sin resultados.", ha="center", va="center", color="#6b7280", fontsize=11,
                    transform=ax.transAxes)
            ax.set_axis_off()
            self.pcanvas.draw_idle()
            return
        d = data["d"]
        ax.plot(d, data["tps"], "-", color=COL_TPS, lw=1.8, label="TPS")
        ax.plot(d, data["calc"], "--", color=COL_CALC, lw=1.8, label="CalcIndep")
        ax.set_xlabel("Distancia desde A (mm)", fontsize=11)
        ax.set_ylabel("Dosis (Gy)", fontsize=11)
        ax.tick_params(labelsize=10)
        ax.grid(alpha=0.3)
        ax.set_xlim(0, max(data["length"], 1e-6))
        ax.set_ylim(bottom=0)
        ax2 = ax.twinx()
        ax2.plot(d, data["diff"], "-", color="#6b7280", lw=0.9, alpha=0.8, label="Diferencia")
        ax2.axhline(0, color="#9ca3af", lw=0.6)
        lim = np.nanmax(np.abs(data["diff"])) if np.isfinite(data["diff"]).any() else 5.0
        lim = float(min(max(5.0, np.ceil(lim)), 50.0))
        ax2.set_ylim(-lim, lim)
        ax2.set_ylabel("Dif. (%)", fontsize=10, color="#4b5563")
        ax2.tick_params(labelsize=9, colors="#4b5563")
        h1_, l1_ = ax.get_legend_handles_labels()
        h2_, l2_ = ax2.get_legend_handles_labels()
        ax.legend(h1_ + h2_, l1_ + l2_, fontsize=10, frameon=False, loc="lower center", ncol=3,
                  bbox_to_anchor=(0.5, 1.0), borderaxespad=0.2)
        o = self.orient.get()
        hn, vn = self._hv_names()
        k = self.idx[o]
        pos = {"Axial": self.z, "Coronal": self.y, "Sagital": self.x}[o][k]
        axis = {"Axial": "z", "Coronal": "y", "Sagital": "x"}[o]
        (a_h, a_v), (b_h, b_v) = data["p0"], data["p1"]
        self.prof_lbl.configure(text=f"Perfil en el corte {o.lower()} {axis} = {pos:.1f} mm   ·   "
                                     f"A ({hn} = {a_h:.1f}, {vn} = {a_v:.1f} mm)  →  "
                                     f"B ({hn} = {b_h:.1f}, {vn} = {b_v:.1f} mm)   ·   longitud {data['length']:.1f} mm"
                                     f"   ·   diferencia en % de la normalización ({self.norm:.3f} Gy)")
        self._pax = ax
        self.pfig.tight_layout()
        self.pcanvas.draw_idle()

    def _profile_motion(self, ev):
        data = self._prof_data
        if data is None or ev.xdata is None or ev.inaxes is None:
            return
        i = int(np.clip(np.searchsorted(data["d"], ev.xdata), 0, len(data["d"]) - 1))
        t, c, df = data["tps"][i], data["calc"][i], data["diff"][i]
        x, y, z = (a[i] for a in data["xyz"])

        def f(v, nd=3, sign=False):
            if v != v:
                return "–"
            return f"{v:+.{nd}f}" if sign else f"{v:.{nd}f}"
        self.readout.configure(text=f"Perfil: {data['d'][i]:.1f} mm desde A   ·   x = {x:.1f}  y = {y:.1f}  "
                                    f"z = {z:.1f} mm   ·   TPS {f(t)} Gy   ·   CalcIndep {f(c)} Gy   ·   "
                                    f"dif. {f(df, 2, True)}% (norm.)")

    # ------------------------------------------------------------------
    def _motion(self, ev):
        if self.res is None or ev.inaxes not in self.axes or ev.xdata is None:
            return
        if self._drag is not None and self._drag_lines:
            x, y = self._clip_hv(ev.xdata, ev.ydata)
            for ln in self._drag_lines:
                ln.set_data([self._drag[0], x], [self._drag[1], y])
            self.canvas.draw_idle()
        o = self.orient.get()
        g = self.res.tps_grid
        sp = g.spacing
        org = g.origin
        k = self.idx[o]
        if o == "Axial":
            i = int(round((ev.xdata - org[0]) / sp[0]))
            j = int(round((ev.ydata - org[1]) / sp[1]))
        elif o == "Coronal":
            i = int(round((ev.xdata - org[0]) / sp[0]))
            j = k
            k = int(round((ev.ydata - org[2]) / sp[2]))
        else:
            i = k
            j = int(round((ev.xdata - org[1]) / sp[1]))
            k = int(round((ev.ydata - org[2]) / sp[2]))
        if o == "Axial":
            k = self.idx[o]
        sh = g.shape
        if not (0 <= k < sh[0] and 0 <= j < sh[1] and 0 <= i < sh[2]):
            return
        t = self.res.tps_dose[k, j, i]
        c = self.res.calc_dose[k, j, i]
        gm = self.res.gamma.gamma[k, j, i]
        d = (c - t) / self.norm * 100.0
        dl = (c - t) / t * 100.0 if t > 0.01 * self.norm else float("nan")
        hu = self.res.ct_on_grid[k, j, i]
        x, y, z = self.x[i], self.y[j], self.z[k]
        txt = (f"x = {x:.1f}  y = {y:.1f}  z = {z:.1f} mm   ·   HU {hu:.0f}   ·   TPS {t:.3f} Gy   ·   "
               f"cálculo {c:.3f} Gy   ·   dif. {d:+.2f}% (norm.)  {dl:+.2f}% (local)   ·   "
               f"γ {'–' if gm != gm else f'{gm:.2f}'}")
        self.readout.configure(text=txt)


class DVHPanel(ttk.Frame):
    def __init__(self, master, on_maximize=None):
        super().__init__(master)
        self.res = None
        if on_maximize is not None:
            top = ttk.Frame(self)
            top.pack(fill="x", pady=(0, 4))
            self.max_btn = ttk.Button(top, text=MAX_TXT, command=on_maximize)
            self.max_btn.pack(side="right")
        else:
            self.max_btn = None
        side = ttk.Frame(self)
        side.pack(side="right", fill="y", padx=(6, 0))
        ttk.Label(side, text="Estructuras").pack(anchor="w")
        self.lb = tk.Listbox(side, selectmode="extended", exportselection=False, width=22, height=20,
                             selectbackground="#e3e8ef", activestyle="none")
        self.lb.pack(fill="y", expand=True)
        self.lb.bind("<<ListboxSelect>>", lambda e: self.draw())
        figf = ttk.Frame(self)
        figf.pack(side="left", fill="both", expand=True)
        self.fig = Figure(figsize=(6, 4), dpi=96, layout="tight")
        self.canvas = FigureCanvasTkAgg(self.fig, master=figf)
        tb = NavigationToolbar2Tk(self.canvas, figf, pack_toolbar=False)
        tb.update()
        tb.pack(side="bottom", fill="x")
        self.canvas.get_tk_widget().pack(fill="both", expand=True)
        self.cache = {}

    def set_maximized(self, maximized):
        if self.max_btn is not None:
            self.max_btn.configure(text=RESTORE_TXT if maximized else MAX_TXT)

    def set_result(self, res):
        self.res = res
        self.cache = {}
        self.structs = [s for s in res.structures if res.masks.get(s.name) is not None and res.masks[s.name].any()]
        self.lb.delete(0, "end")
        for i, s in enumerate(self.structs):
            self.lb.insert("end", s.name)
            col = "#%02x%02x%02x" % tuple(s.color)
            self.lb.itemconfigure(i, foreground=col, selectforeground=col)
            if s.type not in NON_ANATOMIC:
                self.lb.selection_set(i)
        self.dmax = float(max(np.nanmax(res.tps_dose), np.nanmax(res.calc_dose)))
        self.draw()

    def _dvh(self, name, which):
        key = (name, which)
        if key not in self.cache:
            arr = self.res.tps_dose if which == "tps" else self.res.calc_dose
            self.cache[key] = cumulative_dvh(arr, self.res.masks[name], bin_gy=self.dmax / 500, dmax=self.dmax)
        return self.cache[key]

    def draw(self):
        self.fig.clf()
        ax = self.fig.add_subplot(111)
        if self.res is None:
            ax.set_axis_off()
            self.canvas.draw_idle()
            return
        for i in self.lb.curselection():
            s = self.structs[i]
            d, v = self._dvh(s.name, "tps")
            ax.plot(d, v, "-", color=_rgb(s), lw=1.8, label=s.name)
            d, v = self._dvh(s.name, "calc")
            ax.plot(d, v, "--", color=_rgb(s), lw=1.8)
        ax.set_xlabel("Dosis (Gy)", fontsize=13)
        ax.set_ylabel("Volumen (%)", fontsize=13)
        ax.tick_params(labelsize=12)
        ax.set_xlim(0, self.dmax * 1.05)
        ax.set_ylim(0, 102)
        ax.grid(alpha=0.3)
        if self.lb.curselection():
            ax.legend(fontsize=11, ncol=2, frameon=False, loc="upper right")
        ax.set_title("DVH  ·  continua: TPS  ·  discontinua: CalcIndep", fontsize=13)
        self.fig.tight_layout()
        self.canvas.draw_idle()
