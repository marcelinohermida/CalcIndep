"""Ventana principal de CalcIndep."""
import logging
import sys
import tkinter as tk
import tkinter.font  # noqa: F401
from pathlib import Path
from tkinter import messagebox, ttk

from .. import __version__
from .settings import Settings, config_dir, default_library
from . import widgets
from .widgets import Worker, init_scale, open_path

TITLE = f"CalcIndep {__version__} · Cálculo independiente de dosis"
ROOT = Path(__file__).resolve().parents[2]
MANUAL = ROOT / "docs" / "Manual_CalcIndep.pdf"
README = ROOT / "README.md"


def _dpi_awareness():
    if sys.platform.startswith("win"):
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:  # noqa: BLE001
            pass


def _warmup():
    """Compila las funciones numba con un cálculo mínimo (solo tarda la primera vez)."""
    from ..beam_model import BeamModel, default_model_path
    from ..engine import DoseEngine
    from ..gamma import GammaSettings, gamma_3d
    from ..water import compute_water, square_beam, water_grid
    m = BeamModel.from_json(default_model_path())
    eng = DoseEngine(m)
    g = water_grid(10.0, 100.0, 100.0)
    d = compute_water(eng, m, square_beam(40.0), g)
    gamma_3d(d, g, d, g, GammaSettings(threshold_pct=50))


class App(tk.Tk):
    def __init__(self):
        _dpi_awareness()
        super().__init__()
        init_scale(self)
        self.title(TITLE)
        self.settings = Settings.load()
        from .. import gpu
        gpu.set_default_mode(self.settings.gpu_mode)
        try:
            self.settings.ensure_library()
        except OSError as e:
            messagebox.showwarning("Biblioteca", f"No se puede usar la biblioteca {self.settings.library}: {e}\n"
                                                 f"Se usará {default_library()}.")
            self.settings.library = str(default_library())
            self.settings.ensure_library()
        self._style()
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        sc = widgets.UI_SCALE
        w, h = min(int(1560 * sc), sw - 40), min(int(960 * sc), sh - 80)
        self.geometry(f"{w}x{h}+{max(0, (sw - w) // 2)}+{max(0, (sh - h) // 3)}")
        self.minsize(1100, 680)
        self._busy = 0
        self._menu()
        from .commission_tab import CommissionTab
        from .hu_tab import HUTab
        from .models_tab import ModelsTab
        from .settings_tab import SettingsTab
        from .verify_tab import VerifyTab
        self.nb = ttk.Notebook(self)
        self.nb.pack(fill="both", expand=True, padx=6, pady=(6, 0))
        self.verify = VerifyTab(self.nb, self)
        self.models = ModelsTab(self.nb, self)
        self.commission = CommissionTab(self.nb, self)
        self.hu = HUTab(self.nb, self)
        self.settings_tab = SettingsTab(self.nb, self)
        self.nb.add(self.verify, text="  Verificar plan  ")
        self.nb.add(self.models, text="  Modelos de haz  ")
        self.nb.add(self.commission, text="  Comisionado  ")
        self.nb.add(self.hu, text="  Curvas HU–densidad  ")
        self.nb.add(self.settings_tab, text="  Ajustes  ")
        sb = ttk.Frame(self, padding=(8, 3))
        sb.pack(fill="x")
        self.status_lbl = ttk.Label(sb, text="", foreground="#5b6475")
        self.status_lbl.pack(side="left")
        ttk.Label(sb, text="Herramienta de verificación de desarrollo propio, sin certificación como producto "
                           "sanitario.", foreground="#9ca3af").pack(side="right")
        self.protocol("WM_DELETE_WINDOW", self.on_close)
        self._start_warmup()

    # ------------------------------------------------------------------
    def report_callback_exception(self, exc, val, tb):
        """Errores no previstos en la interfaz: se registran y se muestran en un diálogo."""
        import traceback
        txt = "".join(traceback.format_exception(exc, val, tb))
        logging.getLogger("calcindep").error(txt)
        messagebox.showerror("Error inesperado", f"{val}\n\nEl detalle se ha guardado en el registro de la "
                                                 f"aplicación:\n{log_path()}", parent=self)

    def _style(self):
        st = ttk.Style(self)
        themes = st.theme_names()
        if "vista" in themes:
            st.theme_use("vista")
        elif "clam" in themes:
            st.theme_use("clam")
        base = tk.font.nametofont("TkDefaultFont")
        size = base.cget("size")
        st.configure("Accent.TButton", font=(base.cget("family"), abs(size), "bold"))
        line = tk.font.Font(font=base).metrics("linespace")
        st.configure("Treeview", rowheight=int(line * 1.45))
        st.configure("TLabelframe.Label", font=(base.cget("family"), abs(size), "bold"))
        st.configure("TNotebook.Tab", padding=(10, 4))
        st.configure("Treeview.Heading", padding=(4, 2))

    def _menu(self):
        m = tk.Menu(self)
        f = tk.Menu(m, tearoff=0)
        f.add_command(label="Abrir carpeta de la biblioteca", command=lambda: open_path(self.settings.lib))
        f.add_command(label="Abrir carpeta de resultados", command=lambda: open_path(self.settings.results_path))
        f.add_separator()
        f.add_command(label="Salir", command=self.on_close)
        m.add_cascade(label="Archivo", menu=f)
        h = tk.Menu(m, tearoff=0)
        h.add_command(label="Manual de usuario (PDF)", accelerator="F1", command=self.open_manual)
        h.add_command(label="Abrir carpeta de ajustes y registro", command=lambda: self._open(config_dir()))
        h.add_separator()
        h.add_command(label="Acerca de CalcIndep", command=self._about)
        m.add_cascade(label="Ayuda", menu=h)
        self.config(menu=m)
        self.bind_all("<F1>", lambda e: self.open_manual())

    def _open(self, path):
        """Abre un fichero o carpeta; si el sistema no puede, lo dice y muestra la ruta."""
        path = Path(path)
        try:
            if not path.suffix:            # carpeta: se crea si aún no existe
                path.mkdir(parents=True, exist_ok=True)
            open_path(path)
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("No se puede abrir", f"{path}\n\n{e}", parent=self)

    def open_manual(self):
        """Abre el manual en PDF con el visor del sistema (o el README si falta el PDF)."""
        if MANUAL.exists():
            self._open(MANUAL)
        elif README.exists():
            messagebox.showwarning("Manual", f"No se encuentra el manual en PDF:\n{MANUAL}\n\n"
                                             f"Se abre la documentación en texto.", parent=self)
            self._open(README)
        else:
            messagebox.showerror("Manual", f"No se encuentra el manual:\n{MANUAL}", parent=self)

    def _about(self):
        messagebox.showinfo(
            "Acerca de CalcIndep",
            f"CalcIndep {__version__}\n\n"
            "Cálculo independiente de dosis para radioterapia externa con fotones: "
            "convolución-superposición collapsed cone con kernels EGSnrc y comparación gamma "
            "(Low et al. 1998) por estructura.\n\n"
            "Herramienta de desarrollo propio. No es un producto sanitario certificado: "
            "valide el sistema antes de usarlo en clínica.\n\n"
            "Manual: menú Ayuda o tecla F1.", parent=self)

    def _start_warmup(self):
        self.status("Preparando el motor de cálculo (la primera vez tarda alrededor de un minuto)…")

        def job(report, cancel):
            _warmup()
            from .. import gpu
            return gpu.get_backend(None).short()

        def done(desc):
            self.status(f"Motor de cálculo listo · superposición en {desc}")
            self.settings_tab.refresh_gpu(desc)

        def error(e, tb):
            logging.getLogger(__name__).error(tb)
            self.status(f"Aviso: no se ha podido preparar el motor de cálculo ({e})")
        Worker(self, job, on_done=done, on_error=error)

    # ------------------------------------------------------------------
    def status(self, msg):
        self.status_lbl.configure(text=msg)

    def set_busy(self, busy):
        self._busy += 1 if busy else -1
        self._busy = max(self._busy, 0)

    def on_library_changed(self):
        for t in (self.verify, self.models, self.hu):
            t.refresh_library()

    def show_model(self, fname):
        self.models.current = fname
        self.models.refresh_library()
        self.nb.select(self.models)

    def on_close(self):
        if self._busy and not messagebox.askyesno(
                "Salir", "Hay un cálculo en curso. ¿Salir de todos modos? El cálculo se perderá.", parent=self):
            return
        try:
            self.settings.save()
        except OSError:
            pass
        self.destroy()


def log_path():
    from .settings import config_dir
    return config_dir() / "calcindep.log"


def setup_logging():
    from logging.handlers import RotatingFileHandler
    handlers = []
    if sys.stderr is not None:          # con pythonw no hay consola
        handlers.append(logging.StreamHandler())
    try:
        log_path().parent.mkdir(parents=True, exist_ok=True)
        handlers.append(RotatingFileHandler(log_path(), maxBytes=1_000_000, backupCount=2, encoding="utf-8"))
    except OSError:
        pass
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=handlers or None)


def main():
    from .launcher import run
    run()


if __name__ == "__main__":
    main()
