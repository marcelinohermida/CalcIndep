"""Pestaña de gestión de modelos de haz."""
import shutil
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, simpledialog, ttk

import numpy as np
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure

from ..beam_model import BeamModel, default_model_path
from ..calibration import calibrate
from .settings import safe_name
from .widgets import MLCTable, FormGrid, ProgressPanel, ScrollableFrame, WrapLabel, Worker, autosize_columns, \
    checkbox_images, combo, entry, font_size, open_path, parse_float, px, tree_with_scroll

# (atributo, etiqueta, tipo, unidad, ¿afecta a la calibración?)
FIELDS = {
    "Identificación": [
        ("name", "Nombre", "str", None, False),
        ("machine", "Máquina (TreatmentMachineName)", "str", None, False),
        ("energy", "Energía", "energy", None, False),
        ("fluence_mode", "Modo de fluencia", "mode", None, False),
        ("commissioned", "Comisionado y validado", "bool", None, False),
    ],
    "Colimación": [
        ("jaw_transmission", "Transmisión de mandíbulas", "float", "fracción", True),
    ],
    "Fuentes": [
        ("primary_sigma_mm", "σ de la fuente primaria", "float", "mm", True),
        ("primary_collimator_radius_mm", "Radio del colimador primario (0: no)", "float", "mm", True),
        ("primary_collimator_sigma_mm", "σ del colimador primario", "float", "mm", True),
        ("extrafocal_weight", "Peso de la fuente extrafocal", "float", None, True),
        ("extrafocal_sigma_mm", "σ de la fuente extrafocal en X", "float", "mm", True),
        ("extrafocal_sigma_y_mm", "σ de la fuente extrafocal en Y (0: igual)", "float", "mm", True),
        ("monitor_backscatter_k", "Retrodispersión a la cámara monitora", "float", None, True),
    ],
    "Espectro y contaminación electrónica": [
        ("softening_per_cm", "Ablandamiento fuera de eje: coeficiente s", "float", "cm⁻ⁿ", True),
        ("softening_power", "Forma del ablandamiento n (1: lineal, 2: cuadrática)", "float", None, True),
        ("econt_weight", "Peso de la contaminación electrónica", "float", None, True),
        ("econt_k_per_cm", "Atenuación de la contaminación", "float", "cm⁻¹", True),
        ("econt_sigma_mm", "σ de la contaminación", "float", "mm", True),
    ],
    "Cálculo": [
        ("kernel_tilt", "Inclinar el kernel con la divergencia (campos grandes)", "bool", None, True),
    ],
}
CAL_FIELDS = [("dose_per_mu_cgy", "Dosis por UM", "cGy/UM"), ("ssd_mm", "DFS", "mm"),
              ("depth_mm", "Profundidad", "mm"), ("field_mm", "Campo cuadrado", "mm")]


class ModelsTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master)
        self.app = app
        self.current = None       # nombre de fichero
        self.model = None
        self.worker = None
        pw = ttk.Panedwindow(self, orient="horizontal")
        pw.pack(fill="both", expand=True)
        left = ttk.Frame(pw, padding=8)
        pw.add(left, weight=0)
        ttk.Label(left, text="Modelos de la biblioteca", font=("TkDefaultFont", font_size(1), "bold")).pack(
            anchor="w")
        tf, self.tree = tree_with_scroll(left, columns=("nombre", "maq", "en", "com"), show="tree headings",
                                         height=12, selectmode="browse")
        self._img_off, self._img_on = checkbox_images(self)
        self.tree.heading("#0", text="Default", anchor="center")
        self.tree.column("#0", width=px(78), minwidth=px(60), stretch=False, anchor="center")
        for c, h, w in (("nombre", "Nombre", 180), ("maq", "Máquina", 90), ("en", "Energía", 70),
                        ("com", "Comisionado", 85)):
            self.tree.heading(c, text=h)
            self.tree.column(c, width=px(w), anchor="w")
        self.tree.tag_configure("nocom", foreground="#9a6700")
        self.tree.bind("<<TreeviewSelect>>", lambda e: self._select())
        self.tree.bind("<Button-1>", self._click_default, add="+")
        self.tree.bind("<space>", lambda e: self._toggle_default(self.current))
        tf.pack(fill="both", expand=True, pady=(4, 6))
        bb = ttk.Frame(left)
        bb.pack(fill="x")
        for txt, cmd in (("Nuevo", self.new), ("Duplicar", self.duplicate), ("Importar…", self.import_),
                         ("Eliminar", self.delete)):
            ttk.Button(bb, text=txt, command=cmd).pack(side="left", padx=(0, 4))
        ttk.Button(left, text="Abrir carpeta de modelos",
                   command=lambda: open_path(self.app.settings.models_dir)).pack(anchor="w", pady=(6, 0))
        WrapLabel(left, foreground="#5b6475", padding=(0, 10, 0, 0),
                  text="Marque la casilla «Default» del modelo que se usará por defecto en la verificación "
                       "de planes (solo puede haber uno). Se aplica a los haces de la misma energía y modo "
                       "de fluencia; para los demás se elige el modelo de forma automática.\n\n"
                       "Para crear un modelo a partir de datos medidos use la pestaña «Comisionado». "
                       "Aquí puede revisar y retocar los parámetros. Si cambia un parámetro físico, el modelo "
                       "se recalibra al guardar.").pack(fill="x")
        right = ttk.Frame(pw)
        pw.add(right, weight=1)
        formc = ttk.Frame(right)
        formc.pack(side="left", fill="y")
        self.sf = ScrollableFrame(formc, width=480)
        self.sf.pack(fill="both", expand=True)
        ttk.Separator(formc).pack(fill="x")
        self.actions = ttk.Frame(formc, padding=(10, 8, 10, 8))
        self.actions.pack(fill="x")
        plots = ttk.Frame(right, padding=6)
        plots.pack(side="left", fill="both", expand=True)
        self.fig = Figure(figsize=(4, 5), dpi=96, layout="tight")
        self.canvas = FigureCanvasTkAgg(self.fig, master=plots)
        self.canvas.get_tk_widget().pack(fill="both", expand=True)
        self._build_form(self.sf.inner)
        self.refresh_library()

    # ------------------------------------------------------------------
    def _build_form(self, p):
        self.vars = {}
        for sec, fields in FIELDS.items():
            lf = ttk.LabelFrame(p, text=sec, padding=8)
            lf.pack(fill="x", pady=(0, 8))
            g = FormGrid(lf)
            for attr, label, typ, unit, _ in fields:
                if typ == "bool":
                    v = tk.BooleanVar()
                    g.full(ttk.Checkbutton(lf, text=label, variable=v))
                else:
                    v = tk.StringVar()
                    if typ == "energy":
                        w = combo(lf, v, ["6X", "6FFF", "10X", "10FFF", "15X", "18X"], width=12, state="normal")
                    elif typ == "mode":
                        w = combo(lf, v, ["STANDARD", "FFF", "SRS"], width=12, state="normal")
                    else:
                        w = entry(lf, v, width=24 if typ == "str" else 12)
                    g.row(label, w, unit)
                self.vars[attr] = v
            if sec == "Colimación":
                # Parámetros por MLC: no intervienen en la calibración (campo de mandíbulas).
                self.mlc_table = MLCTable(lf)
                g.full(self.mlc_table, pady=(6, 2))
        lf = ttk.LabelFrame(p, text="Calibración de UM", padding=8)
        lf.pack(fill="x", pady=(0, 8))
        g = FormGrid(lf)
        self.cal_vars = {}
        for attr, label, unit in CAL_FIELDS:
            v = tk.StringVar()
            g.row(label, entry(lf, v, width=12), unit)
            self.cal_vars[attr] = v
        self.cal_lbl = WrapLabel(lf, text="", foreground="#5b6475")
        g.full(self.cal_lbl)
        row = ttk.Frame(lf)
        ttk.Label(row, text="Rejilla de calibración").pack(side="left")
        self.cal_grid = tk.StringVar(value="2.5")
        ttk.Spinbox(row, textvariable=self.cal_grid, from_=1.0, to=5.0, increment=0.5, width=6).pack(
            side="left", padx=4)
        ttk.Label(row, text="mm").pack(side="left")
        ttk.Button(row, text="Recalibrar", command=self.recalibrate).pack(side="right")
        g.full(row, pady=(4, 0))
        lf = ttk.LabelFrame(p, text="Notas", padding=8)
        lf.pack(fill="x", pady=(0, 8))
        self.notes = tk.Text(lf, height=4, wrap="word")
        self.notes.pack(fill="x")
        bb = ttk.Frame(self.actions)
        bb.pack(fill="x")
        self.save_btn = ttk.Button(bb, text="Guardar cambios", style="Accent.TButton", command=self.save)
        self.save_btn.pack(side="left")
        ttk.Button(bb, text="Descartar cambios", command=self._select).pack(side="left", padx=6)
        self.report_btn = ttk.Button(bb, text="Informe de comisionado", command=self.open_report)
        self.report_btn.pack(side="right")
        self.progress = ProgressPanel(self.actions)
        self.progress.pack(fill="x", pady=(6, 0))

    # ------------------------------------------------------------------
    def refresh_library(self):
        self.models = self.app.settings.list_models()
        s = self.app.settings
        if s.default_model and s.default_model not in self.models:
            s.default_model = ""
        sel = self.current
        self.tree.delete(*self.tree.get_children())
        for f, m in self.models.items():
            self.tree.insert("", "end", iid=f, image=self._img_on if f == s.default_model else self._img_off,
                             values=(m.name, m.machine or "cualquiera",
                                     m.energy + ("" if m.fluence_mode == "STANDARD" else f" {m.fluence_mode}"),
                                     "Sí" if m.commissioned else "No"),
                             tags=() if m.commissioned else ("nocom",))
        autosize_columns(self.tree, maxwidth=240, pad=14)
        if sel in self.models:
            self.tree.selection_set(sel)
        elif self.models:
            self.tree.selection_set(next(iter(self.models)))

    def _click_default(self, ev):
        if self.tree.identify_column(ev.x) != "#0" or self.tree.identify_region(ev.x, ev.y) not in ("tree", "cell"):
            return
        row = self.tree.identify_row(ev.y)
        if row:
            self._toggle_default(row)

    def _toggle_default(self, fname):
        """Marca o desmarca un modelo como modelo por defecto. Solo puede haber uno."""
        if not fname or fname not in self.models:
            return
        s = self.app.settings
        s.default_model = "" if s.default_model == fname else fname
        for f in self.tree.get_children():
            self.tree.item(f, image=self._img_on if f == s.default_model else self._img_off)
        try:
            s.save()
        except OSError:
            pass
        m = self.models.get(s.default_model)
        self.app.status(f"Modelo por defecto: {m.name}" if m else "Sin modelo por defecto")
        self.app.verify.on_default_model_changed()

    def _select(self):
        sel = self.tree.selection()
        if not sel:
            return
        self.current = sel[0]
        self.model = BeamModel.from_json(self.app.settings.models_dir / self.current)
        m = self.model
        for sec in FIELDS.values():
            for attr, _, typ, _, _ in sec:
                v = getattr(m, attr)
                self.vars[attr].set(v if typ == "bool" else (f"{v:.4g}" if isinstance(v, float) else str(v)))
        for attr, _, _ in CAL_FIELDS:
            self.cal_vars[attr].set(f"{getattr(m.calibration, attr):g}")
        self.mlc_table.set(m.mlc)
        c = m.calibration
        self.cal_lbl.configure(text=(f"Factor actual: {c.cgy_per_unit:.5g} cGy por unidad interna, obtenido con "
                                     f"rejilla de {c.grid_mm:g} mm." if c.cgy_per_unit > 0 else
                                     "Modelo sin calibrar."))
        self.cal_grid.set(f"{c.grid_mm:g}")
        self.notes.delete("1.0", "end")
        self.notes.insert("1.0", m.notes)
        self.report_btn.configure(state="normal" if m.commissioning_report and
                                  Path(m.commissioning_report).exists() else "disabled")
        self._plot()

    def _plot(self):
        m = self.model
        self.fig.clf()
        a1 = self.fig.add_subplot(211)
        a1.bar(m.energies, m.weights, width=0.35, color="#4c78a8")
        a1.set_xlabel("Energía (MeV)", fontsize=10)
        a1.set_ylabel("Fracción de fotones", fontsize=10)
        a1.set_title("Espectro", fontsize=11)
        a1.text(0.97, 0.95, f"E media\n{np.sum(m.energies * m.weights):.2f} MeV", transform=a1.transAxes,
                ha="right", va="top", fontsize=9)
        a1.tick_params(labelsize=9)
        a1.grid(alpha=0.3)
        a2 = self.fig.add_subplot(212)
        a2.plot(m.oa_radius_mm, m.oa_factor, "o-", ms=3, color="#1f5fa8")
        a2.set_xlabel("Radio en el isocentro (mm)", fontsize=9)
        a2.set_ylabel("Factor de fluencia", fontsize=10)
        a2.set_title("Perfil radial", fontsize=11)
        a2.tick_params(labelsize=9)
        a2.grid(alpha=0.3)
        self.fig.tight_layout()
        self.canvas.draw_idle()

    # ------------------------------------------------------------------
    def _read_form(self):
        m = BeamModel.from_json(self.app.settings.models_dir / self.current)
        phys_changed = False
        for sec in FIELDS.values():
            for attr, label, typ, _, phys in sec:
                if typ == "bool":
                    new = bool(self.vars[attr].get())
                elif typ == "float":
                    txt = self.vars[attr].get().strip()
                    old = float(getattr(m, attr))
                    # Si el texto no se ha tocado se conserva el valor completo (se muestra redondeado).
                    new = old if txt == f"{old:.4g}" else parse_float(txt, label, 0)
                else:
                    new = self.vars[attr].get().strip()
                    if typ in ("energy", "mode"):
                        new = new.upper()
                if phys and abs(float(new) - float(getattr(m, attr))) > 1e-12:
                    phys_changed = True
                setattr(m, attr, new)
        for attr, label, _ in CAL_FIELDS:
            txt = self.cal_vars[attr].get().strip()
            old = float(getattr(m.calibration, attr))
            new = old if txt == f"{old:g}" else parse_float(txt, label, 0)
            if abs(new - getattr(m.calibration, attr)) > 1e-12:
                phys_changed = True
            setattr(m.calibration, attr, new)
        m.mlc = self.mlc_table.get()
        m.notes = self.notes.get("1.0", "end").strip()
        if not m.name:
            raise ValueError("El modelo necesita un nombre.")
        return m, phys_changed

    def save(self):
        if not self.current:
            return
        try:
            m, changed = self._read_form()
        except ValueError as e:
            messagebox.showerror("Valor no válido", str(e), parent=self)
            return
        path = self.app.settings.models_dir / self.current
        if changed or m.calibration.cgy_per_unit <= 0:
            grid = parse_float(self.cal_grid.get(), "Rejilla", 0.5, 10)
            self._calibrate_and_save(m, path, grid, "Recalibrando el modelo con los nuevos parámetros")
        else:
            m.to_json(path)
            self.app.on_library_changed()

    def recalibrate(self):
        if not self.current:
            return
        try:
            m, _ = self._read_form()
            grid = parse_float(self.cal_grid.get(), "Rejilla", 0.5, 10)
        except ValueError as e:
            messagebox.showerror("Valor no válido", str(e), parent=self)
            return
        self._calibrate_and_save(m, self.app.settings.models_dir / self.current, grid, "Calibrando")

    def _calibrate_and_save(self, m, path, grid, text):
        if self.worker is not None and self.worker.running:
            return
        self.save_btn.configure(state="disabled")
        self.progress.start(text)
        self.progress.bar.configure(mode="indeterminate")
        self.progress.bar.start(15)

        def job(report, cancel):
            calibrate(m, spacing_mm=grid)
            return m

        def end():
            self.progress.bar.stop()
            self.progress.bar.configure(mode="determinate")
            self.save_btn.configure(state="normal")

        def done(mm):
            end()
            mm.to_json(path)
            self.progress.finish(f"Guardado. Factor de calibración {mm.calibration.cgy_per_unit:.5g} "
                                 f"(rejilla {grid:g} mm).")
            self.app.on_library_changed()

        def error(e, tb):
            end()
            self.progress.finish("Error en la calibración")
            messagebox.showerror("Error", str(e), parent=self)

        self.worker = Worker(self, job, on_done=done, on_error=error)

    # ------------------------------------------------------------------
    def _unique(self, stem):
        d = self.app.settings.models_dir
        name = f"{safe_name(stem)}.json"
        i = 2
        while (d / name).exists():
            name = f"{safe_name(stem)}_{i}.json"
            i += 1
        return d / name

    def new(self):
        name = simpledialog.askstring("Nuevo modelo", "Nombre del modelo (parte del modelo genérico 6X):",
                                      parent=self)
        if not name:
            return
        m = BeamModel.from_json(default_model_path())
        m.name = name
        m.commissioned = False
        m.commissioning_report = ""
        p = self._unique(name)
        m.to_json(p)
        self.current = p.name
        self.app.on_library_changed()

    def duplicate(self):
        if not self.current:
            return
        m = BeamModel.from_json(self.app.settings.models_dir / self.current)
        name = simpledialog.askstring("Duplicar modelo", "Nombre de la copia:", initialvalue=m.name + " (copia)",
                                      parent=self)
        if not name:
            return
        m.name = name
        p = self._unique(name)
        m.to_json(p)
        self.current = p.name
        self.app.on_library_changed()

    def import_(self):
        f = filedialog.askopenfilename(title="Importar modelo de haz", filetypes=[("Modelo JSON", "*.json")],
                                       parent=self)
        if not f:
            return
        try:
            m = BeamModel.from_json(f)
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("Importar", f"No es un modelo válido: {e}", parent=self)
            return
        p = self._unique(Path(f).stem)
        shutil.copy(f, p)
        self.current = p.name
        self.app.on_library_changed()
        messagebox.showinfo("Importar", f"Modelo «{m.name}» importado.", parent=self)

    def delete(self):
        if not self.current:
            return
        m = self.models.get(self.current)
        if not messagebox.askyesno("Eliminar", f"¿Eliminar el modelo «{m.name if m else self.current}»?",
                                   parent=self):
            return
        (self.app.settings.models_dir / self.current).unlink(missing_ok=True)
        if self.app.settings.default_model == self.current:
            self.app.settings.default_model = ""
            self.app.settings.save()
        self.current = None
        self.app.on_library_changed()

    def open_report(self):
        if self.model and self.model.commissioning_report:
            open_path(self.model.commissioning_report)
