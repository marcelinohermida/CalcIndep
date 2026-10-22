"""Pestaña de ajustes generales."""
import os
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from ..kernels import DEFAULT_EDK
from .settings import config_dir
from .widgets import FormGrid, WrapLabel, Worker, entry, open_path, parse_float

GPU_AUTO = "Automático (GPU comprobada y más rápida)"
GPU_CPU = "Solo CPU"


class SettingsTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=12)
        self.app = app
        s = app.settings
        cols = ttk.Frame(self)
        cols.pack(anchor="nw")
        body = ttk.Frame(cols)
        body.grid(row=0, column=0, sticky="nw")
        right = ttk.Frame(cols)
        right.grid(row=0, column=1, sticky="nw", padx=(14, 0))
        lf = ttk.LabelFrame(body, text="Carpetas", padding=10)
        lf.pack(fill="x", pady=(0, 10))
        g = FormGrid(lf)
        self.v_lib = tk.StringVar(value=s.library)
        self.v_res = tk.StringVar(value=s.results_dir)
        g.row("Biblioteca", self._path_row(lf, self.v_lib),
              tip="Contiene los modelos de haz, las curvas HU–densidad y los informes de comisionado. "
                  "Puede estar en una carpeta de red compartida por el servicio.")
        g.row("Resultados", self._path_row(lf, self.v_res),
              tip="Vacío: subcarpeta «resultados» de la biblioteca.")
        lf = ttk.LabelFrame(body, text="Cálculo", padding=10)
        lf.pack(fill="x", pady=(0, 10))
        g = FormGrid(lf)
        ncpu = os.cpu_count() or 1
        self.v_threads = tk.StringVar(value=str(s.threads or ncpu))
        g.row("Hilos de cálculo", ttk.Spinbox(lf, textvariable=self.v_threads, from_=1, to=ncpu, width=8),
              f"de {ncpu}", tip="Use menos hilos si quiere seguir trabajando con el ordenador durante el cálculo.")
        self.v_flu = tk.StringVar(value=f"{s.fluence_res_mm:g}")
        self.v_gstep = tk.StringVar(value=f"{s.max_gantry_step_deg:g}")
        self.v_sector = tk.StringVar(value=f"{s.sector_deg:g}")
        self.v_margin = tk.StringVar(value=f"{s.margin_mm:g}")
        self.v_trace = tk.BooleanVar(value=s.trace_full_ct)
        g.row("Resolución del mapa de fluencia", entry(lf, self.v_flu), "mm")
        g.row("Paso máximo de gantry en arcos", entry(lf, self.v_gstep), "grados")
        g.row("Sector de superposición en arcos", entry(lf, self.v_sector), "grados",
              tip="Las incidencias de un arco se agrupan en sectores para la superposición. Con 10° la dosis "
                  "difiere menos del 0.2% de la obtenida con 3°, y el cálculo es unas tres veces más rápido.")
        g.row("Margen alrededor del External", entry(lf, self.v_margin), "mm")
        g.full(ttk.Checkbutton(lf, text="Calcular la atenuación del TERMA a través de todo el CT",
                               variable=self.v_trace))
        lf = ttk.LabelFrame(right, text="Superposición en GPU", padding=10)
        lf.pack(fill="x", pady=(0, 10))
        g = FormGrid(lf)
        self.v_gpu = tk.StringVar(value=self._gpu_label(s.gpu_mode))
        self.gpu_cb = ttk.Combobox(lf, textvariable=self.v_gpu, state="readonly", width=40,
                                   values=[GPU_AUTO, GPU_CPU])
        g.row("Dispositivo", self.gpu_cb,
              tip="Cada ordenador decide según su GPU. La primera vez que se usa una GPU, y si cambia el "
                  "driver, se calcula un maniquí con la GPU y con la CPU: la GPU se acepta si la diferencia "
                  "es menor del 0.01% de la dosis máxima. En automático, solo si además es más rápida. "
                  "Si no hay GPU o falla, se calcula en la CPU. Se aplica al pulsar «Guardar ajustes».")
        self.gpu_lbl = WrapLabel(lf, initial=380, text="Buscando GPU…")
        g.full(self.gpu_lbl, pady=(6, 2))
        bf = ttk.Frame(lf)
        self.gpu_btn = ttk.Button(bf, text="Comprobar GPU de nuevo", command=self.check_gpu)
        self.gpu_btn.pack(side="left")
        g.full(bf, pady=(6, 0))
        ttk.Button(body, text="Guardar ajustes", style="Accent.TButton", command=self.save).pack(anchor="w")
        lf = ttk.LabelFrame(body, text="Información", padding=10)
        lf.pack(fill="x", pady=(14, 0))
        info = (f"Fichero de ajustes: {config_dir() / 'ajustes.json'}\n"
                f"Kernels: {DEFAULT_EDK}\n"
                f"Código: {Path(__file__).resolve().parents[2]}")
        ttk.Label(lf, text=info, justify="left", foreground="#5b6475").pack(anchor="w")
        ttk.Button(lf, text="Abrir carpeta de ajustes", command=lambda: open_path(config_dir())).pack(
            anchor="w", pady=(6, 0))

    # ------------------------------------------------------------------ GPU
    @staticmethod
    def _gpu_label(mode):
        if mode in (None, "", "auto"):
            return GPU_AUTO
        if mode == "cpu":
            return GPU_CPU
        return f"GPU: {mode}"

    @staticmethod
    def _gpu_mode(label):
        if label == GPU_CPU:
            return "cpu"
        if label.startswith("GPU: "):
            return label[5:]
        return "auto"

    def refresh_gpu(self, in_use=None):
        """Actualiza la lista de GPU y su estado (sin repetir comprobaciones)."""
        def job(report, cancel):
            from .. import gpu
            devs, reason = gpu.list_devices()
            return [i.name for i, _ in devs], gpu.device_summary()

        def done(r):
            names, summary = r
            self.gpu_cb.configure(values=[GPU_AUTO, GPU_CPU] + [f"GPU: {n}" for n in names])
            txt = summary
            if in_use:
                txt += f"\n\nEn uso: {in_use}"
            self.gpu_lbl.configure(text=txt)

        def error(e, tb):
            self.gpu_lbl.configure(text=f"No se puede consultar la GPU: {e}")
        Worker(self, job, on_done=done, on_error=error)

    def check_gpu(self):
        self.gpu_btn.configure(state="disabled")
        self.gpu_lbl.configure(text="Comprobando la GPU frente a la CPU (unos segundos)…")
        mode = self._gpu_mode(self.v_gpu.get())

        def job(report, cancel):
            from .. import gpu
            gpu.check_devices(force=True)
            return gpu.get_backend(mode).short()

        def done(desc):
            self.gpu_btn.configure(state="normal")
            self.refresh_gpu(desc)
            self.app.status(f"Superposición en {desc}")

        def error(e, tb):
            self.gpu_btn.configure(state="normal")
            self.gpu_lbl.configure(text=f"Error en la comprobación: {e}")
        Worker(self, job, on_done=done, on_error=error)

    def _path_row(self, parent, var):
        f = ttk.Frame(parent)
        ttk.Entry(f, textvariable=var, width=60).pack(side="left", fill="x", expand=True)

        def choose():
            d = filedialog.askdirectory(initialdir=var.get() or str(Path.home()), parent=self)
            if d:
                var.set(d)
        ttk.Button(f, text="Examinar…", command=choose).pack(side="left", padx=(4, 0))
        return f

    def save(self):
        s = self.app.settings
        try:
            threads = int(parse_float(self.v_threads.get(), "Hilos", 1))
            flu = parse_float(self.v_flu.get(), "Resolución de fluencia", 0.1, 2.5)
            gstep = parse_float(self.v_gstep.get(), "Paso de gantry", 0.5, 10)
            sector = parse_float(self.v_sector.get(), "Sector", 1, 45)
            margin = parse_float(self.v_margin.get(), "Margen", 0, 100)
        except ValueError as e:
            messagebox.showerror("Valor no válido", str(e), parent=self)
            return
        lib = self.v_lib.get().strip()
        if not lib:
            messagebox.showerror("Biblioteca", "Indique una carpeta para la biblioteca.", parent=self)
            return
        s.library = lib
        s.results_dir = self.v_res.get().strip()
        s.threads = 0 if threads >= (os.cpu_count() or 1) else threads
        s.fluence_res_mm, s.max_gantry_step_deg, s.sector_deg, s.margin_mm = flu, gstep, sector, margin
        s.trace_full_ct = self.v_trace.get()
        s.gpu_mode = self._gpu_mode(self.v_gpu.get())
        from .. import gpu
        gpu.set_default_mode(s.gpu_mode)
        try:
            s.ensure_library()
        except OSError as e:
            messagebox.showerror("Biblioteca", f"No se puede usar la carpeta: {e}", parent=self)
            return
        s.save()
        self.app.on_library_changed()
        self.app.status("Ajustes guardados")
