"""Pestaña de verificación de planes."""
import datetime as _dt
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import numpy as np
from scipy.ndimage import map_coordinates

from .. import dicom_io
from ..engine import CalcOptions
from ..gamma import GammaSettings
from ..mlc import display_name as mlc_display_name, identify_mlc
from ..pipeline import CheckConfig, run_check, verdict
from ..report import _order_structures, write_report
from .settings import safe_name
from .viewer import DVHPanel, SliceViewer
from .widgets import (EditableTree, place_near, FormGrid, LogBox, ProgressPanel, ScrollableFrame, WrapLabel, Worker,
                      autosize_columns, combo, duration, entry, fmt, font_size, open_path, parse_float, px,
                      tree_with_scroll)

NORMS = {"Máximo de la dosis de referencia": "max", "Prescripción del plan": "prescription"}
REFS = {"Dosis del TPS": "tps", "Cálculo independiente": "calc"}


def _short(name, n=40):
    """Acorta por el centro los nombres de fichero muy largos (UID DICOM)."""
    name = str(name)
    if len(name) <= n:
        return name
    k = (n - 1) // 2
    return name[:k] + "…" + name[-(n - 1 - k):]


def _key(machine, energy, mode):
    return f"{(machine or '').upper()}|{(energy or '').upper()}|{(mode or 'STANDARD').upper()}"


class VerifyTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master)
        self.app = app
        self.index = None
        self.plan_entries = []
        self.plan = None
        self.resolved = None
        self.structures = []
        self.ct_info = {}
        self.beam_model = {}       # número de haz -> fichero de modelo
        self.overrides = {}        # estructura -> {"hu": v} o {"red": v}
        self.worker = None
        self.result = None
        self.result_dir = None
        self.report_path = None
        pw = ttk.Panedwindow(self, orient="horizontal")
        pw.pack(fill="both", expand=True)
        self.pw = pw
        self._maximized = False
        leftc = ttk.Frame(pw)
        self.leftc = leftc
        self.left = ScrollableFrame(leftc, width=470)
        self.left.pack(fill="both", expand=True)
        ttk.Separator(leftc).pack(fill="x")
        self.actions = ttk.Frame(leftc, padding=(10, 8, 10, 8))
        self.actions.pack(fill="x")
        right = ttk.Frame(pw, padding=(4, 4, 6, 6))
        pw.add(leftc, weight=0)
        pw.add(right, weight=1)
        self._build_inputs(self.left.inner)
        self._build_results(right)
        self.refresh_library()

    # ==================================================================
    # Entradas
    # ==================================================================
    def _build_inputs(self, p):
        s = self.app.settings
        # 1. Plan ----------------------------------------------------
        f1 = ttk.LabelFrame(p, text="1. Plan exportado del TPS", padding=8)
        f1.pack(fill="x", pady=(0, 8))
        row = ttk.Frame(f1)
        row.pack(fill="x")
        self.folder_var = tk.StringVar(value=s.last_folder)
        ttk.Entry(row, textvariable=self.folder_var).pack(side="left", fill="x", expand=True)
        ttk.Button(row, text="Examinar…", command=self.choose_folder).pack(side="left", padx=(6, 0))
        ttk.Button(row, text="Leer", command=self.load_folder).pack(side="left", padx=(4, 0))
        WrapLabel(f1, text="Carpeta con el CT, el RTSTRUCT, el RTPLAN y el RTDOSE (puede contener varios planes).",
                  foreground="#5b6475").pack(fill="x", pady=(2, 6))
        row = ttk.Frame(f1)
        row.pack(fill="x")
        ttk.Label(row, text="Plan").pack(side="left")
        self.plan_var = tk.StringVar()
        self.plan_cb = ttk.Combobox(row, textvariable=self.plan_var, state="readonly")
        self.plan_cb.pack(side="left", fill="x", expand=True, padx=(6, 0))
        self.plan_cb.bind("<<ComboboxSelected>>", lambda e: self.select_plan())
        self.plan_info = tk.Text(f1, height=7, wrap="word", relief="flat", state="disabled",
                                 background=self._bg(), font="TkDefaultFont", spacing1=1, spacing3=1,
                                 borderwidth=0, highlightthickness=0, padx=2)
        self.plan_info.tag_configure("b", font=("TkDefaultFont", font_size(), "bold"))
        self.plan_info.tag_configure("muted", foreground="#5b6475")
        self.plan_info.bind("<Configure>", lambda e: self._fit_info_height(), add="+")
        self.plan_info.tag_configure("warn", foreground="#9a6700")
        self.plan_info.tag_configure("err", foreground="#b42318")
        self.plan_info.pack(fill="x", pady=(6, 4))
        ttk.Label(f1, text="Haces (doble clic para cambiar el modelo de haz)").pack(anchor="w")
        tf, self.beams_tree = tree_with_scroll(
            f1, columns=("haz", "maq", "tec", "en", "um", "mlc", "modelo"), show="headings", height=4)
        for c, t, w in (("haz", "Haz", 62), ("maq", "Máquina", 62), ("tec", "Técnica", 62), ("en", "Energía", 52),
                        ("um", "UM", 50), ("mlc", "MLC", 80), ("modelo", "Modelo de haz", 140)):
            self.beams_tree.heading(c, text=t)
            self.beams_tree.column(c, width=px(w), anchor="w" if c in ("haz", "maq", "tec", "mlc", "modelo") else "e")
        autosize_columns(self.beams_tree, pad=16)
        self.beams_tree.tag_configure("missing", foreground="#b42318")
        self.beams_tree.tag_configure("warn", foreground="#9a6700")
        self.beams_tree.bind("<Double-1>", self._beam_menu)
        tf.pack(fill="x")
        self.beams_note = WrapLabel(f1, text="", foreground="#9a6700")
        self.beams_note.pack(fill="x", pady=(2, 0))
        # 2. Densidades ---------------------------------------------
        f2 = ttk.LabelFrame(p, text="2. Densidades", padding=8)
        f2.pack(fill="x", pady=(0, 8))
        g = FormGrid(f2)
        self.curve_var = tk.StringVar(value=s.last_curve)
        self.curve_cb = combo(f2, self.curve_var, [], width=28)
        g.row("Curva HU–densidad", self.curve_cb)
        self.scanner_lbl = WrapLabel(f2, text="", foreground="#5b6475")
        g.full(self.scanner_lbl)
        self.air_var = tk.BooleanVar(value=s.outside_air)
        self.support_var = tk.BooleanVar(value=s.keep_support)
        g.full(ttk.Checkbutton(f2, text="Fuera del External: aire", variable=self.air_var))
        g.full(ttk.Checkbutton(f2, text="Conservar estructuras de soporte (mesa)", variable=self.support_var))
        row = ttk.Frame(f2)
        self.ovr_lbl = ttk.Label(row, text="Sin densidades asignadas", foreground="#5b6475")
        self.ovr_lbl.pack(side="left")
        ttk.Button(row, text="Densidades por estructura…", command=self.edit_overrides).pack(side="right")
        g.full(row, pady=(4, 0))
        # 3. Cálculo ------------------------------------------------
        f3 = ttk.LabelFrame(p, text="3. Rejilla de cálculo", padding=8)
        f3.pack(fill="x", pady=(0, 8))
        self.grid_mode = tk.StringVar(value="tps" if not s.calc_spacing_mm else "custom")
        self.grid_mm = tk.StringVar(value=f"{s.calc_spacing_mm or 2.5:g}")
        ttk.Radiobutton(f3, text="La misma que la dosis del TPS", value="tps",
                        variable=self.grid_mode).pack(anchor="w")
        row = ttk.Frame(f3)
        row.pack(anchor="w")
        ttk.Radiobutton(row, text="Vóxel isótropo de", value="custom", variable=self.grid_mode).pack(side="left")
        ttk.Spinbox(row, textvariable=self.grid_mm, from_=1.0, to=5.0, increment=0.5, width=6).pack(
            side="left", padx=4)
        ttk.Label(row, text="mm").pack(side="left")
        # 4. Gamma --------------------------------------------------
        f4 = ttk.LabelFrame(p, text="4. Índice gamma", padding=8)
        f4.pack(fill="x", pady=(0, 8))
        g = FormGrid(f4)
        self.g_dose = tk.StringVar(value=f"{s.gamma_dose_pct:g}")
        self.g_dta = tk.StringVar(value=f"{s.gamma_dta_mm:g}")
        self.g_type = tk.StringVar(value="Local" if s.gamma_local else "Global")
        self.g_thr = tk.StringVar(value=f"{s.gamma_threshold_pct:g}")
        self.g_norm = tk.StringVar(value=next(k for k, v in NORMS.items() if v == s.gamma_normalization))
        self.g_ref = tk.StringVar(value=next(k for k, v in REFS.items() if v == s.gamma_reference))
        self.g_pass = tk.StringVar(value=f"{s.pass_threshold_pct:g}")
        g.row("Diferencia de dosis", ttk.Spinbox(f4, textvariable=self.g_dose, from_=0.5, to=10, increment=0.5,
                                                 width=8), "%")
        g.row("Distancia (DTA)", ttk.Spinbox(f4, textvariable=self.g_dta, from_=0.5, to=10, increment=0.5,
                                             width=8), "mm")
        g.row("Tipo", combo(f4, self.g_type, ["Global", "Local"], width=12))
        g.row("Umbral de dosis", ttk.Spinbox(f4, textvariable=self.g_thr, from_=0, to=50, increment=5,
                                             width=8), "%")
        g.row("Normalización", combo(f4, self.g_norm, list(NORMS), width=30))
        g.row("Distribución de referencia", combo(f4, self.g_ref, list(REFS), width=22))
        g.row("Aprobado si γ ≤ 1 en al menos", ttk.Spinbox(f4, textvariable=self.g_pass, from_=50, to=100,
                                                           increment=1, width=8), "%")
        # 5. Salida -------------------------------------------------
        f5 = ttk.LabelFrame(p, text="5. Resultados", padding=8)
        f5.pack(fill="x", pady=(0, 8))
        self.out_lbl = WrapLabel(f5, text="", foreground="#5b6475")
        self.out_lbl.pack(fill="x")
        self.save_rd = tk.BooleanVar(value=s.save_rtdose)
        ttk.Checkbutton(f5, text="Guardar la dosis calculada como RTDOSE (para importar en Eclipse)",
                        variable=self.save_rd).pack(anchor="w", pady=(4, 0))
        # Botones (fijos debajo del panel desplazable) ------------
        fb = ttk.Frame(self.actions)
        fb.pack(fill="x")
        self.run_btn = ttk.Button(fb, text="Calcular y comparar", style="Accent.TButton", command=self.run)
        self.run_btn.pack(side="left", fill="x", expand=True, ipady=4)
        self.cancel_btn = ttk.Button(fb, text="Cancelar", command=self.cancel, state="disabled")
        self.cancel_btn.pack(side="left", padx=(6, 0), ipady=4)
        self.progress = ProgressPanel(self.actions)
        self.progress.pack(fill="x", pady=(6, 0))
        self._update_out_label()

    def _bg(self):
        try:
            return ttk.Style().lookup("TFrame", "background") or "#f0f0f0"
        except tk.TclError:
            return "#f0f0f0"

    def _update_out_label(self):
        self.out_lbl.configure(text=f"Se guardan en: {self.app.settings.results_path}")

    # ==================================================================
    # Resultados
    # ==================================================================
    def _build_results(self, p):
        self.nb = ttk.Notebook(p)
        self.nb.pack(fill="both", expand=True)
        # Resumen
        sumf = ttk.Frame(self.nb, padding=8)
        self.nb.add(sumf, text="Resumen")
        top = ttk.Frame(sumf)
        top.pack(fill="x")
        self.verdict = tk.Label(top, text="Sin resultados", font=("TkDefaultFont", 16, "bold"),
                                width=14, padx=12, pady=10, bg="#e5e7eb", fg="#374151")
        self.verdict.pack(side="left")
        self.summary_lbl = WrapLabel(top, text="Seleccione un plan y pulse «Calcular y comparar».", initial=700)
        self.summary_lbl.pack(side="left", padx=14, fill="x", expand=True)
        btns = ttk.Frame(sumf)
        btns.pack(fill="x", pady=(8, 4))
        self.open_report_btn = ttk.Button(btns, text="Abrir informe HTML", state="disabled",
                                          command=lambda: open_path(self.report_path))
        self.open_report_btn.pack(side="left")
        self.open_dir_btn = ttk.Button(btns, text="Abrir carpeta de resultados", state="disabled",
                                       command=lambda: open_path(self.result_dir))
        self.open_dir_btn.pack(side="left", padx=6)
        self.warn_box = tk.Text(sumf, height=3, wrap="word", relief="flat", background="#fff8e6",
                                foreground="#7a5200", state="disabled", font="TkDefaultFont", padx=6, pady=4)
        self.warn_box.pack(fill="x", pady=(4, 6))
        cols = ("est", "tipo", "vol", "n", "pass", "gmean", "gp95", "gmax", "estado", "dmt", "dmc", "ddm", "dd95",
                "dd2", "ddmax")
        heads = ("Estructura", "Tipo", "Vol. (cc)", "Puntos", "γ≤1 (%)", "γ medio", "γ p95", "γ máx.", "Estado",
                 "Dmedia TPS (Gy)", "Dmedia cálc. (Gy)", "ΔDmedia (%)", "ΔD95 (%)", "ΔD2 (%)", "ΔDmáx (%)")
        tf, self.struct_tree = tree_with_scroll(sumf, columns=cols, show="headings", height=12)
        for c, h in zip(cols, heads):
            self.struct_tree.heading(c, text=h, anchor="w" if c in ("est", "tipo", "estado") else "e")
            self.struct_tree.column(c, width=px(70), anchor="w" if c in ("est", "tipo", "estado") else "e")
        autosize_columns(self.struct_tree, minwidth=56, pad=14)
        self.struct_tree.tag_configure("pass", foreground="#1b7f3b")
        self.struct_tree.tag_configure("fail", foreground="#b42318")
        self.struct_tree.tag_configure("na", foreground="#6b7280")
        tf.pack(fill="both", expand=True)
        # Visor y DVH
        self.viewer = SliceViewer(self.nb, on_maximize=self.toggle_maximize)
        self.nb.add(self.viewer, text="Visor de dosis")
        self.dvh = DVHPanel(self.nb, on_maximize=self.toggle_maximize)
        self.nb.add(self.dvh, text="DVH")
        logf = ttk.Frame(self.nb, padding=4)
        self.log = LogBox(logf, height=20)
        self.log.pack(fill="both", expand=True)
        self.nb.add(logf, text="Registro")

    def toggle_maximize(self):
        """Oculta o muestra el panel izquierdo para dar todo el ancho a los resultados."""
        panes = [str(p) for p in self.pw.panes()]
        if str(self.leftc) in panes:
            self.pw.forget(self.leftc)
            self._maximized = True
        else:
            self.pw.insert(0, self.leftc, weight=0)
            self._maximized = False
        self.viewer.set_maximized(self._maximized)
        self.dvh.set_maximized(self._maximized)

    # ==================================================================
    # Biblioteca
    # ==================================================================
    def on_default_model_changed(self):
        """Se ha cambiado el modelo por defecto en «Modelos de haz»: se reasignan los haces del plan."""
        self.models = self.app.settings.list_models()
        self._auto_models()
        self._fill_beams()

    def refresh_library(self):
        s = self.app.settings
        self.models = s.list_models()
        curves = s.list_curves()
        self.curve_cb.configure(values=curves)
        if self.curve_var.get() not in curves:
            self.curve_var.set(curves[0] if curves else "")
        self.beam_model = {n: f for n, f in self.beam_model.items() if f in self.models}
        self._fill_beams()
        self._update_out_label()

    # ==================================================================
    # Lectura del plan
    # ==================================================================
    def choose_folder(self):
        d = filedialog.askdirectory(title="Carpeta con el plan exportado",
                                    initialdir=self.folder_var.get() or str(Path.home()))
        if d:
            self.folder_var.set(d)
            self.load_folder()

    def load_folder(self):
        folder = self.folder_var.get().strip()
        if not folder or not Path(folder).is_dir():
            messagebox.showerror("Carpeta", "Seleccione una carpeta existente.", parent=self)
            return
        self.log.append(f"Leyendo cabeceras DICOM de {folder}")
        self.progress.start("Leyendo carpeta")
        self.run_btn.configure(state="disabled")

        def job(report, cancel):
            return dicom_io.index_folder(folder, progress=lambda f: report(f, None))

        def done(idx):
            self.run_btn.configure(state="normal")
            self.progress.finish(f"{idx.n_files} ficheros DICOM, {len(idx.plans)} planes")
            self.index = idx
            self.app.settings.last_folder = folder
            self.plan_entries = sorted(idx.plans, key=lambda e: e.date, reverse=True)
            self.plan_cb.configure(values=[e.describe() for e in self.plan_entries])
            if not self.plan_entries:
                self.plan_var.set("")
                self._set_info([("No se ha encontrado ningún RTPLAN en la carpeta.", "err")])
                return
            self.plan_cb.current(0)
            self.select_plan()

        def error(e, tb):
            self.run_btn.configure(state="normal")
            self.progress.finish("Error al leer la carpeta")
            self.log.append(tb, "error")
            messagebox.showerror("Error", str(e), parent=self)

        self.worker = Worker(self, job, on_progress=self.progress.update_progress, on_done=done, on_error=error)

    def select_plan(self):
        i = self.plan_cb.current()
        if i < 0 or self.index is None:
            return
        entry = self.plan_entries[i]
        if self.result is not None:
            self.clear_results()
        ct, rs, rd, problems = dicom_io.resolve_plan(self.index, entry)
        self.resolved = (ct, rs, entry.path, rd)
        try:
            self.plan = dicom_io.read_rtplan(entry.path)
        except Exception as e:  # noqa: BLE001
            self.plan = None
            problems.append(f"No se puede leer el RTPLAN: {e}")
        self.structures = []
        if rs:
            try:
                self.structures, _ = dicom_io.read_rtstruct(rs)
            except Exception as e:  # noqa: BLE001
                problems.append(f"No se puede leer el RTSTRUCT: {e}")
        # Escáner del CT
        self.ct_info = {}
        st_uid = self.index.structs.get(entry.struct_uid, {}).get("series_uid") if entry.struct_uid else None
        cts = self.index.cts
        ctrec = cts.get(st_uid) or (next(iter(cts.values())) if len(cts) == 1 else None)
        if ctrec:
            self.ct_info = ctrec
        self.overrides = {k: v for k, v in self.overrides.items() if any(s.name == k for s in self.structures)}
        self._update_ovr_label()
        # Curva por escáner
        sc = self._scanner_key()
        cmap = self.app.settings.scanner_curves
        if sc and sc in cmap and cmap[sc] in self.curve_cb.cget("values"):
            self.curve_var.set(cmap[sc])
        self.scanner_lbl.configure(
            text=(f"Escáner del CT: {sc}" + (" (curva asociada)" if sc in cmap else
                                              " · la curva elegida se asociará a este escáner"))
            if sc else "Escáner del CT: sin identificar")
        # Información
        lines = []
        if self.plan:
            p = self.plan
            rx = f" · prescripción {p.prescription_gy:.2f} Gy" if p.prescription_gy else ""
            lines.append((f"{entry.patient_id}  {entry.patient_name}\n", "b"))
            lines.append((f"Plan {p.label} · {p.n_fractions} fracciones{rx}\n", None))
        if ct:
            lines.append((f"CT: {len(ct)} cortes\n", None))
        if rs:
            st = next((v for v in self.index.structs.values() if v["path"] == rs), {})
            lines.append((f"Estructuras: {st.get('label', '')} ({len(self.structures)})\n", None))
        if rd:
            summ = {d["path"]: d["summation"] for d in self.index.doses}
            lines.append((f"Dosis TPS: {', '.join(_short(Path(x).name) for x in rd)} ({summ.get(rd[0], '')})\n",
                          None))
        if self.structures and not any(s.type == "EXTERNAL" for s in self.structures):
            problems.append("No hay estructura de tipo EXTERNAL: el cálculo y la gamma usarán toda la rejilla")
        if self.plan:
            for b in self.plan.beams:
                for w in b.warnings:
                    lines.append((f"{b.name}: {w}\n", "warn"))
        for pr in problems:
            lines.append((pr + "\n", "err"))
        self._set_info(lines)
        self._auto_models()
        self._fill_beams()

    def _scanner_key(self):
        c = self.ct_info
        if not c:
            return ""
        parts = [c.get("station", ""), c.get("manufacturer", ""), c.get("model", "")]
        return " · ".join(x for x in parts if x)

    def _set_info(self, lines):
        t = self.plan_info
        t.configure(state="normal")
        t.delete("1.0", "end")
        for text, tag in lines:
            t.insert("end", text, tag)
        if t.get("end-2c") == "\n":
            t.delete("end-2c")
        t.configure(state="disabled")
        self._fit_info_height()

    def _fit_info_height(self):
        """Ajusta la altura del cuadro de información a las líneas que ocupa (con el texto ya partido)."""
        t = self.plan_info
        try:
            n = t.count("1.0", "end", "displaylines")
        except tk.TclError:
            return
        if isinstance(n, (tuple, list)):
            n = n[0] if n else 0
        n = max(2, min(16, int(n or 0)))
        if int(t.cget("height")) != n:
            t.configure(height=n)
        t.yview_moveto(0.0)

    # ------------------------------------------------------------------
    def _treat_beams(self):
        if not self.plan:
            return []
        return [b for b in self.plan.beams if b.beam_type == "TREATMENT" and b.mu > 0 and b.radiation_type == "PHOTON"]

    def _auto_models(self):
        choice = self.app.settings.model_choice
        dflt = self.app.settings.default_model
        dm = self.models.get(dflt)
        for b in self._treat_beams():
            # 1) Modelo por defecto, si es de la misma energía y modo de fluencia que el haz.
            if dm is not None and dm.energy.upper() == b.energy.upper() and \
                    dm.fluence_mode.upper() == b.fluence_mode.upper():
                self.beam_model[b.number] = dflt
                continue
            k = _key(b.machine, b.energy, b.fluence_mode)
            f = choice.get(k)
            if f in self.models:
                self.beam_model[b.number] = f
                continue
            cands = [(fn, m) for fn, m in self.models.items()
                     if m.energy.upper() == b.energy.upper() and m.fluence_mode.upper() == b.fluence_mode.upper()]
            exact = [fn for fn, m in cands if m.machine and m.machine.upper() == b.machine.upper()]
            generic = [fn for fn, m in cands if not m.machine]
            pick = (exact or generic or [fn for fn, _ in cands] or [None])[0]
            if pick:
                self.beam_model[b.number] = pick
            else:
                self.beam_model.pop(b.number, None)

    def _fill_beams(self):
        t = self.beams_tree
        t.delete(*t.get_children())
        notes = set()
        for b in self._treat_beams():
            f = self.beam_model.get(b.number)
            m = self.models.get(f)
            tag = ()
            if m is None:
                name = "— sin modelo —"
                tag = ("missing",)
            else:
                name = m.name
                if m.energy.upper() != b.energy.upper() or m.fluence_mode.upper() != b.fluence_mode.upper():
                    notes.add(f"El modelo «{m.name}» es de otra energía o modo de fluencia.")
                    tag = ("warn",)
                elif m.machine and m.machine.upper() != b.machine.upper():
                    notes.add(f"El modelo «{m.name}» es de la máquina {m.machine} y el plan usa {b.machine}.")
                    tag = ("warn",)
                if not m.commissioned:
                    notes.add(f"El modelo «{m.name}» no está comisionado.")
                    tag = ("warn",)
            mlc_txt = "sin MLC"
            if b.leaf_boundaries is not None:
                try:
                    mk = identify_mlc(b.leaf_boundaries)
                    mlc_txt = mlc_display_name(mk)
                    if m is not None and mk not in m.mlc:
                        notes.add(f"El modelo «{m.name}» no tiene parámetros del MLC {mlc_txt}: añádalos en "
                                  f"«Modelos de haz».")
                        tag = ("missing",)
                except ValueError as e:
                    mlc_txt = "no reconocido"
                    notes.add(str(e))
                    tag = ("missing",)
            en = b.energy + ("" if b.fluence_mode == "STANDARD" else f" {b.fluence_mode}")
            if m is not None and f == self.app.settings.default_model:
                name += "  (por defecto)"
            t.insert("", "end", iid=str(b.number), values=(b.name, b.machine, b.technique, en, f"{b.mu:.1f}",
                                                           mlc_txt, name), tags=tag)
            if m is None:
                notes.add("Hay haces sin modelo de haz: haga doble clic en el haz para asignarlo.")
        autosize_columns(t, pad=16)
        n = len(t.get_children())
        t.configure(height=max(2, min(8, n)))
        self.beams_note.configure(text="\n".join(sorted(notes)))

    def _beam_menu(self, ev):
        row = self.beams_tree.identify_row(ev.y)
        if not row or not self.plan:
            return
        beam = next(b for b in self.plan.beams if str(b.number) == row)
        menu = tk.Menu(self, tearoff=0)
        same = [(f, m) for f, m in self.models.items() if m.energy.upper() == beam.energy.upper()
                and m.fluence_mode.upper() == beam.fluence_mode.upper()]
        other = [(f, m) for f, m in self.models.items() if (f, m) not in same]
        k = _key(beam.machine, beam.energy, beam.fluence_mode)
        for f, m in same + other:
            lab = f"{m.name}  [{m.machine or 'cualquier máquina'} · {m.energy}]"
            if f == self.app.settings.default_model:
                lab += "  (por defecto)"
            if (f, m) in other:
                lab += "  — otra energía"
            menu.add_command(label=lab, command=lambda f=f: self._assign_model(k, f))
        if not self.models:
            menu.add_command(label="No hay modelos en la biblioteca", state="disabled")
        menu.tk_popup(ev.x_root, ev.y_root)

    def _assign_model(self, key, fname):
        # Se asigna a todos los haces con la misma máquina, energía y modo.
        for b in self._treat_beams():
            if _key(b.machine, b.energy, b.fluence_mode) == key:
                self.beam_model[b.number] = fname
        self.app.settings.model_choice[key] = fname
        self._fill_beams()

    # ------------------------------------------------------------------
    def edit_overrides(self):
        if not self.structures:
            messagebox.showinfo("Densidades", "Primero seleccione un plan.", parent=self)
            return
        OverridesDialog(self, self.structures, self.overrides, self._set_overrides)

    def _set_overrides(self, ovr):
        self.overrides = ovr
        self._update_ovr_label()

    def _update_ovr_label(self):
        n = len(self.overrides)
        rs = sum(1 for s in self.structures if s.rel_elec_density is not None and s.name not in self.overrides)
        txt = f"{n} asignadas aquí" if n else "Ninguna asignada aquí"
        if rs:
            txt += f" · {rs} del RTSTRUCT"
        self.ovr_lbl.configure(text=txt)

    # ==================================================================
    # Cálculo
    # ==================================================================
    def _collect(self):
        s = self.app.settings
        if not self.plan or not self.resolved:
            raise ValueError("Seleccione un plan.")
        ct, rs, rp, rd = self.resolved
        if not ct or not rs or not rd:
            raise ValueError("Faltan objetos DICOM del plan (CT, RTSTRUCT o RTDOSE). Revise los avisos.")
        missing = [b.name for b in self._treat_beams() if b.number not in self.beam_model]
        if missing:
            raise ValueError("Haces sin modelo de haz: " + ", ".join(missing))
        if not self.curve_var.get():
            raise ValueError("Seleccione una curva HU–densidad.")
        gs = GammaSettings(
            dose_pct=parse_float(self.g_dose.get(), "Diferencia de dosis", 0.1, 20),
            dta_mm=parse_float(self.g_dta.get(), "DTA", 0.1, 20),
            local=self.g_type.get() == "Local",
            threshold_pct=parse_float(self.g_thr.get(), "Umbral", 0, 99),
            normalization=NORMS[self.g_norm.get()],
            reference=REFS[self.g_ref.get()])
        if gs.normalization == "prescription" and not self.plan.prescription_gy:
            raise ValueError("El plan no tiene dosis de prescripción: use la normalización al máximo.")
        pass_thr = parse_float(self.g_pass.get(), "Umbral de aprobación", 0, 100)
        spacing = None
        if self.grid_mode.get() == "custom":
            spacing = parse_float(self.grid_mm.get(), "Tamaño de vóxel", 0.5, 10)
        opts = CalcOptions(fluence_res_mm=s.fluence_res_mm, max_gantry_step_deg=s.max_gantry_step_deg,
                           sector_deg=s.sector_deg, trace_full_ct=s.trace_full_ct, margin_mm=s.margin_mm,
                           outside_external="air" if self.air_var.get() else "ct",
                           keep_support_structures=self.support_var.get(),
                           structure_overrides=dict(self.overrides), gpu=s.gpu_mode)
        cfg = CheckConfig(beam_models=[], hu_ed_csv=str(s.curves_dir / self.curve_var.get()), gamma=gs,
                          options=opts, pass_threshold_pct=pass_thr, calc_spacing_mm=spacing,
                          save_rtdose=self.save_rd.get())
        models_by_beam = {n: str(s.models_dir / f) for n, f in self.beam_model.items()}
        # Recordar valores
        s.gamma_dose_pct, s.gamma_dta_mm, s.gamma_local = gs.dose_pct, gs.dta_mm, gs.local
        s.gamma_threshold_pct, s.gamma_normalization, s.gamma_reference = (gs.threshold_pct, gs.normalization,
                                                                           gs.reference)
        s.pass_threshold_pct = pass_thr
        s.outside_air, s.keep_support = self.air_var.get(), self.support_var.get()
        s.calc_spacing_mm = spacing or 0.0
        s.save_rtdose = self.save_rd.get()
        s.last_curve = self.curve_var.get()
        sc = self._scanner_key()
        if sc:
            s.scanner_curves[sc] = self.curve_var.get()
        s.save()
        stamp = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        out = s.results_path / f"{safe_name(self.plan_entries[self.plan_cb.current()].patient_id)}_" \
                               f"{safe_name(self.plan.label)}_{stamp}"
        return cfg, models_by_beam, out

    def run(self):
        if self.worker is not None and self.worker.running:
            return
        try:
            cfg, mbb, out = self._collect()
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("Datos incompletos", str(e), parent=self)
            return
        ct, rs, rp, rd = self.resolved
        threads = self.app.settings.threads
        self.log.append(f"Inicio del cálculo: plan {self.plan.label}, resultados en {out}")
        self.clear_results()
        self.verdict.configure(text="Calculando…", bg="#e5e7eb", fg="#374151")
        self.summary_lbl.configure(text=f"Plan {self.plan.label}. El avance se muestra debajo del botón "
                                        "«Calcular y comparar» y en la pestaña «Registro».")
        self.run_btn.configure(state="disabled")
        self.cancel_btn.configure(state="normal")
        self.progress.start("Preparando")
        self.app.set_busy(True)

        def job(report, cancel):
            if threads:
                import numba
                numba.set_num_threads(int(threads))
            res = run_check(ct_files=ct, rtstruct=rs, rtplan=rp, rtdose=rd, config=cfg, out_dir=out,
                            progress=lambda m: report(None, m), fraction=lambda f: report(f, None),
                            cancel=cancel, models_by_beam=mbb)
            report(None, "Generando informe")
            res.report_path = write_report(res, out)
            return res

        def prog(frac, msg):
            if msg:
                self.log.append(msg)
            self.progress.update_progress(frac, msg)

        def done(res):
            self._finish()
            self.result = res
            self.result_dir = out
            self.report_path = getattr(res, "report_path", None)
            el = self.worker.elapsed()
            self.progress.finish(f"Terminado en {duration(el)}")
            self.log.append(f"Terminado en {duration(el)}", "ok")
            self.log.append(f"  Superposición: {res.info.get('superposition', 'CPU (numba)')}", stamp=False)
            for b in res.beams:
                self.log.append(f"  {b.name}: {b.seconds:.0f} s, {b.n_subbeams} incidencias, "
                                f"{b.n_superpositions} superposiciones, modelo {b.model}", stamp=False)
            self.show_result(res)

        def error(e, tb):
            self._finish()
            self.verdict.configure(text="Error", bg="#e5e7eb", fg="#b42318")
            self.progress.finish("Error")
            self.log.append(tb, "error")
            msg = str(e)
            if isinstance(e, KeyError):
                msg = f"No se ha encontrado un modelo de haz: {e}"
            messagebox.showerror("Error en el cálculo", msg, parent=self)

        def cancelled():
            self._finish()
            self.verdict.configure(text="Cancelado", bg="#e5e7eb", fg="#374151")
            self.progress.finish("Cálculo cancelado")
            self.log.append("Cálculo cancelado por el usuario", "error")

        self.worker = Worker(self, job, on_progress=prog, on_done=done, on_error=error, on_cancel=cancelled)

    def cancel(self):
        if self.worker is not None and self.worker.running:
            self.worker.cancel.set()
            self.progress.update_progress(None, "Cancelando (se detiene al terminar el paso en curso)…")

    def _finish(self):
        self.run_btn.configure(state="normal")
        self.cancel_btn.configure(state="disabled")
        self.app.set_busy(False)

    # ==================================================================
    # Mostrar resultados
    # ==================================================================
    def clear_results(self, text="Seleccione un plan y pulse «Calcular y comparar»."):
        self.result = None
        self.result_dir = None
        self.verdict.configure(text="Sin resultados", bg="#e5e7eb", fg="#374151")
        self.summary_lbl.configure(text=text)
        self.warn_box.configure(state="normal")
        self.warn_box.delete("1.0", "end")
        self.warn_box.configure(state="disabled", height=1)
        self.struct_tree.delete(*self.struct_tree.get_children())
        autosize_columns(self.struct_tree, minwidth=56, pad=14)
        self.open_report_btn.configure(state="disabled")
        self.open_dir_btn.configure(state="disabled")
        self.viewer.res = None
        self.viewer.lb.delete(0, "end")
        self.viewer._placeholder()
        self.dvh.res = None
        self.dvh.lb.delete(0, "end")
        self.dvh.draw()

    def show_result(self, res):
        cfg = res.config
        st = res.gamma.stats
        thr = cfg.pass_threshold_pct
        ok, _fails = verdict(res)
        self.verdict.configure(text="CUMPLE" if ok else "NO CUMPLE", bg="#1b7f3b" if ok else "#b42318", fg="white")
        gset = res.gamma.settings
        # Dosis en el isocentro
        iso_txt = []
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
            if dt > 0:
                iso_txt.append(f"Isocentro: TPS {dt:.3f} Gy, cálculo {dc:.3f} Gy ({(dc - dt) / dt * 100:+.2f}%)")
        fails = []
        rows = []
        for s in _order_structures(res.structures):
            g = res.gamma_struct.get(s.name, {})
            mt = res.dvh_tps.get(s.name, {})
            mc = res.dvh_calc.get(s.name, {})
            n = g.get("n", 0)
            if n >= cfg.min_points_structure:
                passed = g["pass_pct"] >= thr
                estado, tag = ("Cumple", "pass") if passed else ("No cumple", "fail")
                if not passed and s.name in _fails:
                    fails.append(s.name)
                elif not passed:
                    estado = "No cumple (no cuenta)"
            else:
                estado, tag = "Sin puntos", "na"

            def dd(k, mt=mt, mc=mc):
                a, b = mt.get(k), mc.get(k)
                if a is None or b is None or not np.isfinite(a) or a <= 0:
                    return "–"
                return f"{(b - a) / a * 100:+.1f}"
            rows.append(((s.name, s.type, fmt(mt.get("volume_cc", 0), 1), n, fmt(g.get("pass_pct"), 1),
                          fmt(g.get("mean")), fmt(g.get("p95")), fmt(g.get("max")), estado,
                          fmt(mt.get("Dmean"), 3), fmt(mc.get("Dmean"), 3), dd("Dmean"), dd("D95"), dd("D2"),
                          dd("Dmax_0.03cc")), tag))
        t = self.struct_tree
        t.delete(*t.get_children())
        for vals, tag in rows:
            t.insert("", "end", values=vals, tags=(tag,))
        autosize_columns(t, minwidth=56, pad=14)
        txt = (f"Gamma {gset.dose_pct:g}%/{gset.dta_mm:g} mm {'local' if gset.local else 'global'}, "
               f"umbral {gset.threshold_pct:g}%: {fmt(st['pass_pct'], 1)}% de {st['n']} puntos con γ ≤ 1 "
               f"(aprobado si ≥ {thr:g}% en el External y en cada estructura)\n"
               f"γ medio {fmt(st['mean'])} · γ p95 {fmt(st['p95'])} · γ máx. {fmt(st['max'])} · "
               f"normalización {res.gamma.norm_gy:.3f} Gy\n")
        txt += "\n".join(iso_txt)
        if fails:
            txt += "\nNo cumple porque estas estructuras quedan por debajo del umbral: " + ", ".join(fails)
        self.summary_lbl.configure(text=txt)
        self.warn_box.configure(state="normal")
        self.warn_box.delete("1.0", "end")
        if res.warnings:
            self.warn_box.insert("end", "Avisos:\n" + "\n".join(f"• {w}" for w in res.warnings))
            self.warn_box.configure(height=min(8, len(res.warnings) + 1))
        else:
            self.warn_box.insert("end", "Sin avisos.")
            self.warn_box.configure(height=1)
        self.warn_box.configure(state="disabled")
        self.open_report_btn.configure(state="normal")
        self.open_dir_btn.configure(state="normal")
        self.viewer.set_result(res)
        self.dvh.set_result(res)
        self.nb.select(0)


class OverridesDialog(tk.Toplevel):
    """Asignación de densidad por estructura (en HU o en densidad electrónica relativa)."""

    def __init__(self, master, structures, current, on_ok):
        super().__init__(master)
        self.title("Densidades por estructura")
        self.transient(master.winfo_toplevel())
        self.on_ok = on_ok
        self.geometry(f"{px(620)}x{px(460)}")
        ttk.Label(self, padding=(10, 8, 10, 4), wraplength=px(590), justify="left",
                  text="Escriba un valor en HU o en densidad electrónica relativa (RED) para forzar la densidad "
                       "de una estructura (por ejemplo, la mesa o el bolus). Deje ambas columnas vacías para usar "
                       "el CT. Doble clic en una celda para editarla. La columna «RTSTRUCT» muestra la densidad "
                       "asignada en Eclipse, que se aplica si no se indica otra aquí.").pack(fill="x")
        f, self.tree = tree_with_scroll(self, tree_cls=EditableTree, columns=("est", "tipo", "rs", "hu", "red"),
                                        editable=("hu", "red"), on_edit=self._edit)
        for c, h, w in (("est", "Estructura", 160), ("tipo", "Tipo", 90), ("rs", "RTSTRUCT (RED)", 130),
                        ("hu", "HU", 80), ("red", "RED", 80)):
            self.tree.heading(c, text=h)
            self.tree.column(c, width=px(w), anchor="w" if c in ("est", "tipo") else "e")
        for s in structures:
            cur = current.get(s.name, {})
            self.tree.insert("", "end", iid=s.name, values=(
                s.name, s.type, "" if s.rel_elec_density is None else f"{s.rel_elec_density:.3f}",
                "" if "hu" not in cur else f"{cur['hu']:g}", "" if "red" not in cur else f"{cur['red']:g}"))
        f.pack(fill="both", expand=True, padx=10)
        b = ttk.Frame(self, padding=10)
        b.pack(fill="x")
        ttk.Button(b, text="Aceptar", style="Accent.TButton", command=self._ok).pack(side="right")
        ttk.Button(b, text="Cancelar", command=self.destroy).pack(side="right", padx=6)
        ttk.Button(b, text="Borrar todo", command=self._clear).pack(side="left")
        place_near(self, master)
        self.grab_set()

    def _edit(self, row, col, new, old):
        new = new.strip()
        if new == "":
            return True
        try:
            parse_float(new, col.upper())
        except ValueError as e:
            messagebox.showerror("Valor no válido", str(e), parent=self)
            return False
        other = "red" if col == "hu" else "hu"
        self.tree.set(row, other, "")
        return True

    def _clear(self):
        for r in self.tree.get_children():
            self.tree.set(r, "hu", "")
            self.tree.set(r, "red", "")

    def _ok(self):
        out = {}
        for r in self.tree.get_children():
            hu = self.tree.set(r, "hu").strip()
            red = self.tree.set(r, "red").strip()
            if hu:
                out[r] = {"hu": parse_float(hu, "HU")}
            elif red:
                v = parse_float(red, "RED", 0, 10)
                out[r] = {"red": v}
        self.on_ok(out)
        self.destroy()
