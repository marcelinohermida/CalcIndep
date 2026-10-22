"""Pestaña de comisionado de modelos de haz a partir de datos medidos."""
import datetime as _dt
import json
import tkinter as tk
from dataclasses import asdict
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import numpy as np
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure

from ..commissioning.fit import CommissioningConfig, Commissioner
from ..commissioning.measured import load_measured, read_output_factors
from ..commissioning.report import write_commissioning_report
from ..engine import Cancelled
from .settings import safe_name
from ..mlc import MLCParams
from .widgets import (MLCTable, FormGrid, place_near, LogBox, ProgressPanel, ScrollableFrame, WrapLabel, Worker,
                      autosize_columns, combo, duration, entry, fmt, open_path, parse_float, px, tree_with_scroll)

STEPS = [("primary_collimator", "Colimador primario (perfiles diagonales)"), ("spectrum", "Espectro"), ("econt", "Contaminación electrónica"), ("output_factors", "Factores de campo"),
         ("horns", "Perfil radial (cuernos)"), ("softening", "Ablandamiento fuera de eje"),
         ("source", "Tamaño de fuente")]


class CommissionTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master)
        self.app = app
        self.sources = []          # dicts: {"kind": "w2cad"|"pdd"|"profile", "file": ..., ...}
        self.curves = []
        self.worker = None
        self.last = None
        pw = ttk.Panedwindow(self, orient="horizontal")
        pw.pack(fill="both", expand=True)
        leftc = ttk.Frame(pw)
        self.left = ScrollableFrame(leftc, width=480)
        self.left.pack(fill="both", expand=True)
        ttk.Separator(leftc).pack(fill="x")
        self.actions = ttk.Frame(leftc, padding=(10, 8, 10, 8))
        self.actions.pack(fill="x")
        right = ttk.Frame(pw, padding=(4, 4, 6, 6))
        pw.add(leftc, weight=0)
        pw.add(right, weight=1)
        self._build_form(self.left.inner)
        self._build_right(right)

    # ------------------------------------------------------------------
    def _build_form(self, p):
        lf = ttk.LabelFrame(p, text="1. Máquina y energía", padding=8)
        lf.pack(fill="x", pady=(0, 8))
        g = FormGrid(lf)
        self.v_name = tk.StringVar()
        self.v_machine = tk.StringVar()
        self.v_energy = tk.StringVar(value="6X")
        self.v_mode = tk.StringVar(value="STANDARD")
        g.row("Nombre del modelo", entry(lf, self.v_name, 26))
        g.row("Máquina", entry(lf, self.v_machine, 26),
              tip="Igual que TreatmentMachineName en el plan (por ejemplo, el nombre de la unidad en Eclipse).")
        cb = combo(lf, self.v_energy, ["6X", "6FFF"], width=10, state="normal")
        cb.bind("<<ComboboxSelected>>", lambda e: self.v_mode.set("FFF" if "FFF" in self.v_energy.get() else
                                                                  "STANDARD"))
        g.row("Energía", cb)
        g.row("Modo de fluencia", combo(lf, self.v_mode, ["STANDARD", "FFF"], width=12))
        # Curvas
        lf = ttk.LabelFrame(p, text="2. Curvas medidas (PDD y perfiles)", padding=8)
        lf.pack(fill="x", pady=(0, 8))
        tf, self.src_tree = tree_with_scroll(lf, columns=("fich", "fmt", "det"), show="headings", height=5)
        for c, h, w in (("fich", "Fichero", 170), ("fmt", "Formato", 60), ("det", "Descripción", 180)):
            self.src_tree.heading(c, text=h)
            self.src_tree.column(c, width=px(w), anchor="w")
        tf.pack(fill="x")
        row = ttk.Frame(lf)
        row.pack(fill="x", pady=(6, 0))
        ttk.Button(row, text="Añadir w2CAD…", command=self.add_w2cad).pack(side="left")
        ttk.Button(row, text="Añadir CSV…", command=self.add_csv).pack(side="left", padx=4)
        ttk.Button(row, text="Quitar", command=self.remove_source).pack(side="left")
        WrapLabel(lf, foreground="#5b6475", padding=(0, 6, 0, 0),
                  text="w2CAD (.asc) es el formato de los golden beam data de Varian. Se recomiendan PDD de "
                       "3×3, 10×10, 20×20 y 40×40 cm y perfiles X, Y y diagonales a varias profundidades.").pack(
            fill="x")
        # Factores de campo
        lf = ttk.LabelFrame(p, text="3. Factores de campo", padding=8)
        lf.pack(fill="x", pady=(0, 8))
        g = FormGrid(lf)
        self.v_of_file = tk.StringVar()
        row = ttk.Frame(lf)
        ttk.Entry(row, textvariable=self.v_of_file, width=10).pack(side="left", fill="x", expand=True)
        ttk.Button(row, text="Examinar…", command=self.choose_of).pack(side="left", padx=(4, 0))
        g.row("Fichero", row, tip="Tabla 2D de Varian (p. ej. 06X_00.txt) o CSV con columnas campo_x_mm, "
                                  "campo_y_mm, factor (decimal con punto).")
        self.v_of_ssd = tk.StringVar(value="950")
        self.v_of_depth = tk.StringVar(value="50")
        self.v_of_ref = tk.StringVar(value="100")
        g.row("DFS de medida", entry(lf, self.v_of_ssd), "mm")
        g.row("Profundidad de medida", entry(lf, self.v_of_depth), "mm")
        g.row("Campo de referencia", entry(lf, self.v_of_ref), "mm")
        self.of_msg = WrapLabel(lf, text="")
        g.full(self.of_msg)
        # Colimación
        lf = ttk.LabelFrame(p, text="4. Colimación (valores de la configuración de Eclipse)", padding=8)
        lf.pack(fill="x", pady=(0, 8))
        g = FormGrid(lf)
        self.v_jaw_t = tk.StringVar(value="0.001")
        self.mlc_table = MLCTable(lf)
        self.mlc_table.set({"Millennium120": MLCParams().to_dict()})
        g.full(self.mlc_table, pady=(2, 8))
        g.row("Transmisión de mandíbulas", entry(lf, self.v_jaw_t), "fracción")
        # Calibración
        lf = ttk.LabelFrame(p, text="5. Calibración de UM", padding=8)
        lf.pack(fill="x", pady=(0, 8))
        g = FormGrid(lf)
        self.v_cal_d = tk.StringVar(value="1.0")
        self.v_cal_ssd = tk.StringVar(value="1000")
        self.v_cal_depth = tk.StringVar(value="15")
        self.v_cal_field = tk.StringVar(value="100")
        g.row("Dosis por UM", entry(lf, self.v_cal_d), "cGy/UM")
        g.row("DFS", entry(lf, self.v_cal_ssd), "mm")
        g.row("Profundidad", entry(lf, self.v_cal_depth), "mm")
        g.row("Campo cuadrado", entry(lf, self.v_cal_field), "mm")
        # Opciones
        lf = ttk.LabelFrame(p, text="6. Ajuste", padding=8)
        lf.pack(fill="x", pady=(0, 8))
        g = FormGrid(lf)
        self.v_grid = tk.StringVar(value="2.5")
        g.row("Rejilla de cálculo", ttk.Spinbox(lf, textvariable=self.v_grid, from_=1.0, to=5.0, increment=0.5,
                                                width=8), "mm",
              tip="Use el mismo tamaño de vóxel que en la verificación de planes.")
        self.v_steps = {}
        for k, lab in STEPS:
            v = tk.BooleanVar(value=True)
            g.full(ttk.Checkbutton(lf, text=lab, variable=v), pady=0)
            self.v_steps[k] = v
        # Botones
        row = ttk.Frame(p)
        row.pack(fill="x", pady=(2, 6))
        ttk.Button(row, text="Cargar configuración…", command=self.load_config).pack(side="left")
        ttk.Button(row, text="Guardar configuración…", command=self.save_config).pack(side="left", padx=4)
        row = ttk.Frame(self.actions)
        row.pack(fill="x")
        self.run_btn = ttk.Button(row, text="Comisionar", style="Accent.TButton", command=self.run)
        self.run_btn.pack(side="left", fill="x", expand=True, ipady=4)
        self.cancel_btn = ttk.Button(row, text="Cancelar", state="disabled", command=self.cancel)
        self.cancel_btn.pack(side="left", padx=(6, 0), ipady=4)
        self.progress = ProgressPanel(self.actions)
        self.progress.pack(fill="x", pady=(6, 0))
        WrapLabel(p, foreground="#5b6475", padding=(0, 6, 0, 0),
                  text="El ajuste tarda entre 15 y 60 minutos según el número de curvas y el ordenador. "
                       "El modelo se guarda en la biblioteca al terminar.").pack(fill="x")

    def _build_right(self, p):
        self.nb = ttk.Notebook(p)
        self.nb.pack(fill="both", expand=True)
        cf = ttk.Frame(self.nb, padding=6)
        self.nb.add(cf, text="Curvas medidas")
        tf, self.curve_tree = tree_with_scroll(cf, columns=("tipo", "campo", "dfs", "prof", "eje", "n", "orig"),
                                               show="headings", height=9, selectmode="extended")
        for c, h, w in (("tipo", "Tipo", 60), ("campo", "Campo (cm)", 80), ("dfs", "DFS (cm)", 65),
                        ("prof", "Prof. (cm)", 70), ("eje", "Eje", 40), ("n", "Puntos", 60),
                        ("orig", "Fichero", 200)):
            self.curve_tree.heading(c, text=h)
            self.curve_tree.column(c, width=px(w), anchor="w" if c in ("tipo", "orig") else "e")
        self.curve_tree.bind("<<TreeviewSelect>>", lambda e: self._plot_curves())
        tf.pack(fill="x")
        self.curve_msg = WrapLabel(cf, text="Añada ficheros de curvas para verlas aquí.", foreground="#5b6475")
        self.curve_msg.pack(fill="x", pady=4)
        self.fig = Figure(figsize=(6, 4), dpi=96, layout="tight")
        self.canvas = FigureCanvasTkAgg(self.fig, master=cf)
        self.canvas.get_tk_widget().pack(fill="both", expand=True)
        rf = ttk.Frame(self.nb, padding=6)
        self.nb.add(rf, text="Resultado")
        self.res_lbl = WrapLabel(rf, text="Sin resultados.")
        self.res_lbl.pack(fill="x")
        bb = ttk.Frame(rf)
        bb.pack(fill="x", pady=6)
        self.rep_btn = ttk.Button(bb, text="Abrir informe de comisionado", state="disabled",
                                  command=lambda: open_path(self.last["report"]))
        self.rep_btn.pack(side="left")
        self.goto_btn = ttk.Button(bb, text="Ver el modelo", state="disabled",
                                   command=lambda: self.app.show_model(self.last["model_file"]))
        self.goto_btn.pack(side="left", padx=6)
        tf, self.val_tree = tree_with_scroll(rf, columns=("curva", "g", "d", "pdd"), show="headings", height=12)
        for c, h, w in (("curva", "Curva", 300), ("g", "γ 2%/2 mm (%)", 110), ("d", "|Dif.| máx. central (%)", 150),
                        ("pdd", "PDD10 med. / calc.", 130)):
            self.val_tree.heading(c, text=h)
            self.val_tree.column(c, width=px(w), anchor="w" if c == "curva" else "e")
        self.val_tree.tag_configure("ko", foreground="#b42318")
        tf.pack(fill="both", expand=True)
        tf, self.of_tree = tree_with_scroll(rf, columns=("campo", "med", "calc", "dif"), show="headings", height=7)
        for c, h in (("campo", "Campo (cm)"), ("med", "Medido"), ("calc", "Calculado"), ("dif", "Dif. (%)")):
            self.of_tree.heading(c, text=h)
            self.of_tree.column(c, width=px(100), anchor="e")
        self.of_tree.tag_configure("ko", foreground="#b42318")
        tf.pack(fill="x", pady=(6, 0))
        lf = ttk.Frame(self.nb, padding=4)
        self.log = LogBox(lf, height=20)
        self.log.pack(fill="both", expand=True)
        self.nb.add(lf, text="Registro")

    # ------------------------------------------------------------------
    def _initial_dir(self):
        return self.app.settings.last_commission_dir or str(Path.home())

    def add_w2cad(self):
        fs = filedialog.askopenfilenames(title="Ficheros w2CAD", initialdir=self._initial_dir(),
                                         filetypes=[("w2CAD", "*.asc *.ASC *.txt"), ("Todos", "*.*")], parent=self)
        for f in fs:
            self.sources.append({"kind": "w2cad", "file": f})
            self.app.settings.last_commission_dir = str(Path(f).parent)
        self._refresh_sources()

    def add_csv(self):
        fs = filedialog.askopenfilenames(title="Curvas en CSV (posición, valor)", initialdir=self._initial_dir(),
                                         filetypes=[("CSV", "*.csv *.txt"), ("Todos", "*.*")], parent=self)
        if not fs:
            return
        self.app.settings.last_commission_dir = str(Path(fs[0]).parent)
        CsvCurveDialog(self, fs, self._add_csv_sources)

    def _add_csv_sources(self, items):
        self.sources += items
        self._refresh_sources()

    def remove_source(self):
        sel = [int(i) for i in self.src_tree.selection()]
        self.sources = [s for i, s in enumerate(self.sources) if i not in sel]
        self._refresh_sources()

    def choose_of(self):
        f = filedialog.askopenfilename(title="Factores de campo", initialdir=self._initial_dir(),
                                       filetypes=[("CSV", "*.csv *.txt"), ("Todos", "*.*")], parent=self)
        if f:
            self.v_of_file.set(f)
            self._read_of_meta(f)

    def _read_of_meta(self, f):
        """Si el fichero es la tabla 2D de Varian, se rellenan DFS, profundidad y campo de referencia."""
        try:
            rows, meta = read_output_factors(f)
        except Exception as e:  # noqa: BLE001
            self.of_msg.configure(text=f"No se puede leer: {e}", foreground="#b42318")
            return
        if meta.get("format") == "tabla_2d":
            if "ssd_mm" in meta:
                self.v_of_ssd.set(f"{meta['ssd_mm']:g}")
                self.v_of_depth.set(f"{meta['depth_mm']:g}")
            if "ref_field_mm" in meta:
                self.v_of_ref.set(f"{meta['ref_field_mm'][0]:g}")
            self.of_msg.configure(text=f"Tabla 2D de Varian: {len(rows)} combinaciones X×Y (campos en cm). DFS, "
                                       "profundidad y campo de referencia leídos de la cabecera.",
                                  foreground="#1b7f3b")
        else:
            self.of_msg.configure(text=f"{len(rows)} factores leídos.", foreground="#1b7f3b" if rows else "#b42318")

    def _describe(self, s):
        if s["kind"] == "w2cad":
            return "PDD y perfiles"
        f = f"{s['field_x_mm'] / 10:g}x{s['field_y_mm'] / 10:g} cm, DFS {s['ssd_mm'] / 10:g}"
        if s["kind"] == "pdd":
            return f"PDD {f}"
        return f"Perfil {s['axis']} {f}, prof. {s['depth_mm'] / 10:g} cm"

    def _refresh_sources(self):
        t = self.src_tree
        t.delete(*t.get_children())
        for i, s in enumerate(self.sources):
            t.insert("", "end", iid=str(i), values=(Path(s["file"]).name,
                                                    "w2CAD" if s["kind"] == "w2cad" else "CSV", self._describe(s)))
        autosize_columns(t)
        self._load_curves()

    def _measured(self):
        m = {"w2cad": [s["file"] for s in self.sources if s["kind"] == "w2cad"],
             "pdd": [], "profiles": []}
        for s in self.sources:
            if s["kind"] == "w2cad":
                continue
            d = {k: v for k, v in s.items() if k != "kind"}
            m["pdd" if s["kind"] == "pdd" else "profiles"].append(d)
        if self.v_of_file.get().strip():
            m["output_factors"] = {"file": self.v_of_file.get().strip(),
                                   "ssd_mm": parse_float(self.v_of_ssd.get(), "DFS de los factores de campo", 500),
                                   "depth_mm": parse_float(self.v_of_depth.get(), "Profundidad de los factores", 0),
                                   "ref_field_mm": parse_float(self.v_of_ref.get(), "Campo de referencia", 10)}
        return m

    def _load_curves(self):
        self.curve_tree.delete(*self.curve_tree.get_children())
        self.curves = []
        if not self.sources:
            self.curve_msg.configure(text="Añada ficheros de curvas para verlas aquí.")
            self._plot_curves()
            return
        try:
            m = self._measured()
            m.pop("output_factors", None)
            info = {}
            self.curves, _ = load_measured(m, ".", info)
        except Exception as e:  # noqa: BLE001
            self.curve_msg.configure(text=f"Error al leer las curvas: {e}")
            return
        for i, c in enumerate(self.curves):
            self.curve_tree.insert("", "end", iid=str(i), values=(
                "PDD" if c.kind == "pdd" else "Perfil", f"{c.field_x_mm / 10:g}x{c.field_y_mm / 10:g}",
                f"{c.ssd_mm / 10:g}", "" if c.depth_mm is None else f"{c.depth_mm / 10:g}",
                "" if c.kind == "pdd" else c.axis, len(c.pos_mm), Path(c.source).name))
        autosize_columns(self.curve_tree)
        npdd = sum(c.kind == "pdd" for c in self.curves)
        txt = (f"{len(self.curves)} curvas de campo abierto: {npdd} PDD y {len(self.curves) - npdd} perfiles "
               f"({sum(c.is_half for c in self.curves)} medidos a un solo lado).")
        if info.get("skipped"):
            from collections import Counter
            cnt = Counter(t for _, t, _ in info["skipped"])
            txt += (" Descartadas por ser de cuña u otro tipo: "
                    + ", ".join(f"{v} {k}" for k, v in cnt.items()) + ".")
        if info.get("repeated_files") or info.get("duplicates"):
            txt += f" Repetidas: {info.get('repeated_files', 0)} ficheros, {info.get('duplicates', 0)} curvas."
        self.curve_msg.configure(text=txt + " Seleccione curvas para verlas.")
        if self.curves:
            self.curve_tree.selection_set("0")

    def _plot_curves(self):
        self.fig.clf()
        ax = self.fig.add_subplot(111)
        sel = [self.curves[int(i)] for i in self.curve_tree.selection() if int(i) < len(self.curves)]
        for c in sel:
            x, v = c.normalized()
            ax.plot(x, v, lw=1.2, label=c.label)
        ax.set_xlabel("Profundidad o posición (mm)", fontsize=11)
        ax.set_ylabel("Dosis relativa (%)", fontsize=11)
        ax.tick_params(labelsize=10)
        ax.grid(alpha=0.3)
        if sel:
            ax.legend(fontsize=9, frameon=False)
        self.fig.tight_layout()
        self.canvas.draw_idle()

    # ------------------------------------------------------------------
    def _config(self):
        name = self.v_name.get().strip()
        if not name:
            raise ValueError("Escriba un nombre para el modelo.")
        if not self.sources:
            raise ValueError("Añada curvas medidas.")
        if not any(c.kind == "pdd" for c in self.curves):
            raise ValueError("Hace falta al menos una PDD.")
        energy = self.v_energy.get().strip().upper()
        if energy not in ("6X", "6FFF"):
            if not messagebox.askyesno(
                    "Energía", "Los kernels incluidos llegan a 6 MeV y solo son adecuados para 6X y 6FFF. "
                               "¿Continuar de todos modos?", parent=self):
                raise ValueError("Comisionado cancelado.")
        cfg = CommissioningConfig(
            machine=self.v_machine.get().strip(), energy=energy, fluence_mode=self.v_mode.get(), name=name,
            measured=self._measured(),
            mlc=self.mlc_table.get(),
            jaw_transmission=parse_float(self.v_jaw_t.get(), "Transmisión de mandíbulas", 0, 0.1),
            calibration={"dose_per_mu_cgy": parse_float(self.v_cal_d.get(), "Dosis por UM", 0.01),
                         "ssd_mm": parse_float(self.v_cal_ssd.get(), "DFS de calibración", 500),
                         "depth_mm": parse_float(self.v_cal_depth.get(), "Profundidad de calibración", 0),
                         "field_mm": parse_float(self.v_cal_field.get(), "Campo de calibración", 10)},
            grid_mm=parse_float(self.v_grid.get(), "Rejilla", 0.5, 10),
            steps={k: v.get() for k, v in self.v_steps.items()})
        return cfg

    def save_config(self):
        try:
            cfg = self._config()
        except ValueError as e:
            messagebox.showerror("Configuración", str(e), parent=self)
            return
        f = filedialog.asksaveasfilename(title="Guardar configuración de comisionado", defaultextension=".json",
                                         initialfile=f"comisionado_{safe_name(cfg.name)}.json",
                                         initialdir=self._initial_dir(), filetypes=[("JSON", "*.json")], parent=self)
        if f:
            d = asdict(cfg)
            Path(f).write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")

    def load_config(self):
        f = filedialog.askopenfilename(title="Cargar configuración de comisionado", initialdir=self._initial_dir(),
                                       filetypes=[("JSON", "*.json")], parent=self)
        if not f:
            return
        try:
            d = json.loads(Path(f).read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("Configuración", f"No se puede leer: {e}", parent=self)
            return
        base = Path(f).parent

        def absp(x):
            return str(x if Path(x).is_absolute() else (base / x).resolve())
        self.v_name.set(d.get("name", ""))
        self.v_machine.set(d.get("machine", ""))
        self.v_energy.set(d.get("energy", "6X"))
        self.v_mode.set(d.get("fluence_mode", "STANDARD"))
        meas = d.get("measured", {})
        self.sources = [{"kind": "w2cad", "file": absp(x)} for x in meas.get("w2cad", [])]
        for kind, key in (("pdd", "pdd"), ("profile", "profiles")):
            for c in meas.get(key, []):
                c = dict(c)
                c["file"] = absp(c["file"])
                c.setdefault("field_x_mm", c.get("field_mm"))
                c.setdefault("field_y_mm", c.get("field_mm"))
                c.setdefault("ssd_mm", 1000.0)
                self.sources.append({"kind": kind, **c})
        of = meas.get("output_factors")
        if of:
            self.v_of_file.set(absp(of["file"]))
            self._read_of_meta(self.v_of_file.get())
            self.v_of_ssd.set(f"{of.get('ssd_mm', 1000):g}")
            self.v_of_depth.set(f"{of.get('depth_mm', 100):g}")
            self.v_of_ref.set(f"{of.get('ref_field_mm', 100):g}")
        if "mlc" in d:
            self.mlc_table.set(d["mlc"])
        else:   # configuraciones antiguas: un solo MLC (Millennium 120)
            self.mlc_table.set({"Millennium120": {"transmission": d.get("mlc_transmission", 0.013),
                                                  "dlg_mm": d.get("mlc_dlg_mm", 1.3), "tg_width_mm": 0.0}})
        self.v_jaw_t.set(f"{d.get('jaw_transmission', 0.001):g}")
        cal = d.get("calibration", {})
        self.v_cal_d.set(f"{cal.get('dose_per_mu_cgy', 1.0):g}")
        self.v_cal_ssd.set(f"{cal.get('ssd_mm', 1000):g}")
        self.v_cal_depth.set(f"{cal.get('depth_mm', 15):g}")
        self.v_cal_field.set(f"{cal.get('field_mm', 100):g}")
        self.v_grid.set(f"{d.get('grid_mm', 2.5):g}")
        for k, v in d.get("steps", {}).items():
            if k in self.v_steps:
                self.v_steps[k].set(bool(v))
        self.app.settings.last_commission_dir = str(base)
        self._refresh_sources()

    # ------------------------------------------------------------------
    def run(self):
        if self.worker is not None and self.worker.running:
            return
        try:
            cfg = self._config()
        except ValueError as e:
            if str(e) != "Comisionado cancelado.":
                messagebox.showerror("Datos incompletos", str(e), parent=self)
            return
        s = self.app.settings
        model_path = s.models_dir / f"{safe_name(cfg.name)}.json"
        if model_path.exists() and not messagebox.askyesno(
                "Sobrescribir", f"Ya existe un modelo con el fichero {model_path.name}. ¿Sustituirlo?", parent=self):
            return
        stamp = _dt.datetime.now().strftime("%Y%m%d_%H%M")
        rep_dir = s.commissioning_dir / f"{safe_name(cfg.name)}_{stamp}"
        threads = s.threads
        self.log.clear()
        self.log.append(f"Comisionado de «{cfg.name}» ({len(self.curves)} curvas)")
        self.run_btn.configure(state="disabled")
        self.cancel_btn.configure(state="normal")
        self.progress.start("Comisionando")
        self.app.set_busy(True)
        self.nb.select(2)

        def job(report, cancel):
            if threads:
                import numba
                numba.set_num_threads(int(threads))
            comm = Commissioner(cfg, base_dir=".", progress=lambda m: report(None, m),
                                fraction=lambda f: report(f, None))
            val, of_res = comm.run()
            if cancel.is_set():
                raise Cancelled()
            rep_dir.mkdir(parents=True, exist_ok=True)
            rep = write_commissioning_report(rep_dir / "informe_comisionado.html", comm, val, of_res)
            d = asdict(cfg)
            (rep_dir / "configuracion.json").write_text(json.dumps(d, indent=2, ensure_ascii=False),
                                                        encoding="utf-8")
            comm.model.commissioning_report = str(rep)
            comm.model.to_json(model_path)
            comm.model.to_json(rep_dir / model_path.name)
            return {"comm": comm, "val": val, "of": of_res, "report": rep, "model_file": model_path.name}

        def prog(frac, msg):
            if msg:
                self.log.append(msg, stamp=not msg.startswith("  "))
                if not msg.startswith("  "):
                    self.progress.update_progress(frac, msg)
            else:
                self.progress.update_progress(frac, None)

        def done(r):
            self._finish()
            self.last = r
            self.progress.finish(f"Terminado en {duration(self.worker.elapsed())}. Modelo guardado en la biblioteca.")
            self.log.append("Comisionado terminado", "ok")
            self._show(r)
            self.app.on_library_changed()

        def error(e, tb):
            self._finish()
            self.progress.finish("Error en el comisionado")
            self.log.append(tb, "error")
            messagebox.showerror("Error en el comisionado", str(e), parent=self)

        def cancelled():
            self._finish()
            self.progress.finish("Comisionado cancelado")
            self.log.append("Cancelado por el usuario", "error")

        self.worker = Worker(self, job, on_progress=prog, on_done=done, on_error=error, on_cancel=cancelled)

    def cancel(self):
        if self.worker is not None and self.worker.running:
            self.worker.cancel.set()
            self.progress.update_progress(None, "Cancelando (se detiene al terminar el paso en curso)…")

    def _finish(self):
        self.run_btn.configure(state="normal")
        self.cancel_btn.configure(state="disabled")
        self.app.set_busy(False)

    def _show(self, r):
        m = r["comm"].model
        val = r["val"]
        ok = sum(1 for v in val if v["gamma_pass"] >= 95)
        txt = (f"Modelo «{m.name}» guardado ({r['model_file']}).\n"
               f"{ok} de {len(val)} curvas con γ 2%/2 mm ≥ 95%. Energía media del espectro "
               f"{np.sum(m.weights * m.energies):.2f} MeV · σ fuente {m.primary_sigma_mm:g} mm · fuente extrafocal "
               f"w = {m.extrafocal_weight:.3f}, σ = {m.extrafocal_sigma_mm:g} mm.\n"
               "Revise el informe antes de marcar el modelo como validado para uso clínico.")
        self.res_lbl.configure(text=txt)
        self.val_tree.delete(*self.val_tree.get_children())
        for v in val:
            c = v["curve"]
            pdd = "" if c.kind != "pdd" else f"{v['pdd10_meas']:.1f} / {v['pdd10_calc']:.1f}"
            self.val_tree.insert("", "end", values=(c.label, fmt(v["gamma_pass"], 1), fmt(v["max_abs_diff_core"]),
                                                    pdd), tags=() if v["gamma_pass"] >= 95 else ("ko",))
        self.of_tree.delete(*self.of_tree.get_children())
        for o in r["of"]:
            self.of_tree.insert("", "end", values=(f"{o['fx'] / 10:g}x{o['fy'] / 10:g}", f"{o['meas']:.4f}",
                                                   f"{o['calc']:.4f}", f"{o['diff_pct']:+.2f}"),
                                tags=() if abs(o["diff_pct"]) <= 1.0 else ("ko",))
        autosize_columns(self.val_tree)
        autosize_columns(self.of_tree)
        self.rep_btn.configure(state="normal")
        self.goto_btn.configure(state="normal")
        self.nb.select(1)


class CsvCurveDialog(tk.Toplevel):
    """Metadatos de curvas en CSV: tipo, campo, DFS, profundidad, eje y unidades."""

    def __init__(self, master, files, on_ok):
        super().__init__(master)
        self.title("Curvas en CSV")
        self.transient(master.winfo_toplevel())
        self.files = list(files)
        self.on_ok = on_ok
        f = ttk.Frame(self, padding=12)
        f.pack(fill="both", expand=True)
        ttk.Label(f, text=f"{len(self.files)} fichero(s): " + ", ".join(Path(x).name for x in self.files[:4])
                  + ("…" if len(self.files) > 4 else ""), wraplength=px(420)).pack(anchor="w")
        ttk.Label(f, foreground="#5b6475", wraplength=px(420), justify="left", padding=(0, 4, 0, 8),
                  text="Dos columnas: profundidad (PDD) o posición (perfil) y valor. Los datos indicados aquí se "
                       "aplican a todos los ficheros seleccionados.").pack(anchor="w")
        gfr = ttk.Frame(f)
        gfr.pack(fill="x")
        g = FormGrid(gfr)
        self.kind = tk.StringVar(value="PDD")
        self.fx = tk.StringVar(value="100")
        self.fy = tk.StringVar(value="100")
        self.ssd = tk.StringVar(value="1000")
        self.depth = tk.StringVar(value="100")
        self.axis = tk.StringVar(value="X")
        self.units = tk.StringVar(value="mm")
        g.row("Tipo", combo(gfr, self.kind, ["PDD", "Perfil"], width=10))
        g.row("Campo X", entry(gfr, self.fx), "mm")
        g.row("Campo Y", entry(gfr, self.fy), "mm")
        g.row("DFS", entry(gfr, self.ssd), "mm")
        g.row("Profundidad (perfiles)", entry(gfr, self.depth), "mm")
        g.row("Eje (perfiles)", combo(gfr, self.axis, ["X", "Y", "D"], width=6),
              tip="X: crossline, Y: inline, D: diagonal.")
        g.row("Unidades de posición", combo(gfr, self.units, ["mm", "cm"], width=6))
        b = ttk.Frame(f, padding=(0, 10, 0, 0))
        b.pack(fill="x")
        ttk.Button(b, text="Añadir", style="Accent.TButton", command=self._ok).pack(side="right")
        ttk.Button(b, text="Cancelar", command=self.destroy).pack(side="right", padx=6)
        place_near(self, master)
        self.grab_set()

    def _ok(self):
        try:
            fx = parse_float(self.fx.get(), "Campo X", 1)
            fy = parse_float(self.fy.get(), "Campo Y", 1)
            ssd = parse_float(self.ssd.get(), "DFS", 100)
            depth = parse_float(self.depth.get(), "Profundidad", 0)
        except ValueError as e:
            messagebox.showerror("Valor no válido", str(e), parent=self)
            return
        kind = "pdd" if self.kind.get() == "PDD" else "profile"
        items = []
        for fl in self.files:
            d = {"kind": kind, "file": fl, "field_x_mm": fx, "field_y_mm": fy, "ssd_mm": ssd,
                 "units": self.units.get()}
            if kind == "profile":
                d["depth_mm"] = depth
                d["axis"] = self.axis.get()
            items.append(d)
        self.on_ok(items)
        self.destroy()
