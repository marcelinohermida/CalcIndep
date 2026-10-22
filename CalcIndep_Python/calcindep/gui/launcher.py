"""Arranque de la interfaz.

Muestra una ventana de arranque antes de importar numpy, scipy, numba y
matplotlib (la primera vez puede tardar uno o dos minutos) y, si el arranque
falla, enseña el error en un diálogo y lo guarda en el registro. Así el
programa nunca se cierra sin dar señales, aunque se lance con pythonw.
"""
import os
import sys
import time
import traceback
from pathlib import Path


def _config_dir():
    if sys.platform.startswith("win"):
        base = Path(os.environ.get("APPDATA") or Path.home())
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config"))
    return base / "calcindep"


def _write_error(text):
    """Guarda el error en la carpeta de ajustes y, si se puede, junto al programa."""
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    places = []
    for folder in (_config_dir(), Path(__file__).resolve().parents[2]):
        try:
            folder.mkdir(parents=True, exist_ok=True)
            p = folder / "error_arranque.txt"
            p.write_text(f"{stamp}\n{sys.executable}\n{sys.version}\n\n{text}", encoding="utf-8")
            places.append(p)
        except OSError:
            continue
    return places


def _splash():
    import tkinter as tk
    root = tk.Tk()
    root.overrideredirect(True)
    w, h = 460, 150
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    root.geometry(f"{w}x{h}+{(sw - w) // 2}+{(sh - h) // 3}")
    root.configure(bg="#1f3b5a")
    tk.Label(root, text="CalcIndep", font=("Segoe UI", 18, "bold"), fg="white", bg="#1f3b5a").pack(pady=(22, 4))
    msg = tk.Label(root, text="Cargando… La primera vez puede tardar uno o dos minutos.",
                   font=("Segoe UI", 10), fg="#d6e2ef", bg="#1f3b5a")
    msg.pack()
    root.attributes("-topmost", True)
    root.update()
    return root, msg


def run():
    splash = None
    try:
        splash, msg = _splash()
    except Exception:  # noqa: BLE001  (sin pantalla: se sigue sin ventana de arranque)
        splash = None
    try:
        if splash is not None:
            msg.configure(text="Cargando librerías de cálculo…")
            splash.update()
        from .app import App, setup_logging
        setup_logging()
        if splash is not None:
            msg.configure(text="Abriendo la ventana principal…")
            splash.update()
            splash.destroy()
            splash = None
        app = App()
        app.mainloop()
    except Exception:  # noqa: BLE001
        text = traceback.format_exc()
        places = _write_error(text)
        try:
            import logging
            logging.getLogger("calcindep").error(text)
        except Exception:  # noqa: BLE001
            pass
        try:
            import tkinter as tk
            from tkinter import messagebox
            if splash is not None:
                splash.destroy()
            r = tk.Tk()
            r.withdraw()
            where = "\n".join(str(p) for p in places)
            messagebox.showerror("CalcIndep no ha podido arrancar",
                                 f"{text[-1500:]}\n\nEl detalle se ha guardado en:\n{where}", parent=r)
            r.destroy()
        except Exception:  # noqa: BLE001
            sys.stderr and sys.stderr.write(text)
        sys.exit(1)


if __name__ == "__main__":
    run()
