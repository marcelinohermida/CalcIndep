"""Componentes comunes de la interfaz."""
import os
import queue
import subprocess
import sys
import threading
import time
import traceback
import tkinter as tk
from tkinter import ttk

from ..engine import Cancelled

# Factor de escala de la pantalla respecto a 96 ppp. Con la ventana declarada
# «DPI aware» Tk escala las fuentes, pero no las medidas en píxeles (anchos de
# columna, wraplength, anchos de lienzo): esas medidas se pasan por px().
UI_SCALE = 1.0


def init_scale(root):
    global UI_SCALE
    try:
        UI_SCALE = max(1.0, float(root.winfo_fpixels("1i")) / 96.0)
    except tk.TclError:
        UI_SCALE = 1.0
    return UI_SCALE


def px(n):
    """Convierte una medida pensada para 96 ppp a píxeles de la pantalla actual."""
    return int(round(n * UI_SCALE))


def font_size(delta=0):
    """Tamaño en puntos de la fuente por defecto de la interfaz más un incremento."""
    import tkinter.font as tkfont
    try:
        return abs(int(tkfont.nametofont("TkDefaultFont").cget("size"))) + delta
    except (tk.TclError, RuntimeError):
        return 9 + delta


# ----------------------------------------------------------------------------
def open_path(path):
    """Abre un fichero o carpeta con la aplicación del sistema."""
    p = str(path)
    if sys.platform.startswith("win"):
        os.startfile(p)  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", p])
    else:
        subprocess.Popen(["xdg-open", p])


def parse_float(text, name, lo=None, hi=None):
    """Convierte un texto en número. Acepta coma decimal por comodidad."""
    t = str(text).strip().replace(",", ".")
    try:
        v = float(t)
    except ValueError:
        raise ValueError(f"«{name}» debe ser un número (valor actual: «{text}»)") from None
    if lo is not None and v < lo:
        raise ValueError(f"«{name}» debe ser ≥ {lo:g}")
    if hi is not None and v > hi:
        raise ValueError(f"«{name}» debe ser ≤ {hi:g}")
    return v


def fmt(v, nd=2):
    try:
        if v is None or v != v:
            return "–"
        return f"{v:.{nd}f}"
    except TypeError:
        return str(v)


def duration(s):
    s = int(round(s))
    if s < 60:
        return f"{s} s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m} min {s:02d} s"
    h, m = divmod(m, 60)
    return f"{h} h {m:02d} min"


# ----------------------------------------------------------------------------
class Worker:
    """Ejecuta una tarea larga en un hilo y entrega el progreso al hilo de la interfaz.

    target(report, cancel) -> resultado
        report(fracción, mensaje): cualquiera de los dos puede ser None.
        cancel: threading.Event.
    """

    def __init__(self, widget, target, on_progress=None, on_done=None, on_error=None, on_cancel=None):
        self.widget = widget
        self.q = queue.Queue()
        self.cancel = threading.Event()
        self.t0 = time.time()
        self.on_progress = on_progress
        self.on_done = on_done
        self.on_error = on_error
        self.on_cancel = on_cancel

        def run():
            try:
                r = target(self.report, self.cancel)
                self.q.put(("done", r))
            except Cancelled:
                self.q.put(("cancel", None))
            except Exception as e:  # noqa: BLE001
                self.q.put(("error", (e, traceback.format_exc())))

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        widget.after(100, self._poll)

    def report(self, frac=None, msg=None):
        if self.cancel.is_set():
            raise Cancelled()
        self.q.put(("progress", (frac, msg)))

    @property
    def running(self):
        return self.thread.is_alive()

    def elapsed(self):
        return time.time() - self.t0

    def _poll(self):
        try:
            while True:
                kind, val = self.q.get_nowait()
                if kind == "progress" and self.on_progress:
                    self.on_progress(*val)
                elif kind == "done" and self.on_done:
                    self.on_done(val)
                elif kind == "error" and self.on_error:
                    self.on_error(*val)
                elif kind == "cancel" and self.on_cancel:
                    self.on_cancel()
        except queue.Empty:
            pass
        if self.thread.is_alive() or not self.q.empty():
            try:
                self.widget.after(100, self._poll)
            except tk.TclError:
                pass


# ----------------------------------------------------------------------------
class LogBox(ttk.Frame):
    def __init__(self, master, height=10):
        super().__init__(master)
        fam = "Consolas" if sys.platform.startswith("win") else "DejaVu Sans Mono"
        self.text = tk.Text(self, height=height, wrap="word", state="disabled", relief="flat",
                            font=(fam, max(11, font_size(2))), padx=6, pady=4, spacing1=1, spacing3=1)
        sb = ttk.Scrollbar(self, orient="vertical", command=self.text.yview)
        self.text.configure(yscrollcommand=sb.set)
        self.text.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.text.tag_configure("error", foreground="#b42318")
        self.text.tag_configure("ok", foreground="#1b7f3b")
        self.text.tag_configure("muted", foreground="#6b7280")

    def append(self, msg, tag=None, stamp=True):
        self.text.configure(state="normal")
        if stamp:
            self.text.insert("end", time.strftime("%H:%M:%S  "), "muted")
        self.text.insert("end", msg + "\n", tag)
        self.text.see("end")
        self.text.configure(state="disabled")

    def clear(self):
        self.text.configure(state="normal")
        self.text.delete("1.0", "end")
        self.text.configure(state="disabled")


# ----------------------------------------------------------------------------
class ScrollableFrame(ttk.Frame):
    """Marco con barra de desplazamiento vertical. Los widgets van en `.inner`."""

    def __init__(self, master, width=440, **kw):
        super().__init__(master, **kw)
        self.canvas = tk.Canvas(self, width=px(width), highlightthickness=0, borderwidth=0)
        self.sb = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.inner = ttk.Frame(self.canvas, padding=(8, 6, 8, 6))
        self._win = self.canvas.create_window((0, 0), window=self.inner, anchor="nw")
        self.canvas.configure(yscrollcommand=self.sb.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        self.sb.pack(side="right", fill="y")
        self.inner.bind("<Configure>", lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", lambda e: self.canvas.itemconfigure(self._win, width=e.width))
        self.inner.bind("<Enter>", self._bind_wheel)
        self.inner.bind("<Leave>", self._unbind_wheel)
        try:
            bg = ttk.Style().lookup("TFrame", "background")
            if bg:
                self.canvas.configure(background=bg)
        except tk.TclError:
            pass

    def _bind_wheel(self, _e):
        self.canvas.bind_all("<MouseWheel>", self._wheel)
        self.canvas.bind_all("<Button-4>", lambda e: self.canvas.yview_scroll(-3, "units"))
        self.canvas.bind_all("<Button-5>", lambda e: self.canvas.yview_scroll(3, "units"))

    def _unbind_wheel(self, _e):
        self.canvas.unbind_all("<MouseWheel>")
        self.canvas.unbind_all("<Button-4>")
        self.canvas.unbind_all("<Button-5>")

    def _wheel(self, e):
        # No desplazar el marco si el cursor está sobre una lista con su propio desplazamiento.
        w = e.widget
        if isinstance(w, (ttk.Treeview, tk.Listbox, tk.Text)):
            return
        self.canvas.yview_scroll(int(-e.delta / 120) or (-1 if e.delta > 0 else 1), "units")


# ----------------------------------------------------------------------------
class EditableTree(ttk.Treeview):
    """Treeview con edición de celdas (doble clic) mediante un Entry superpuesto."""

    def __init__(self, master, columns, editable=None, on_edit=None, **kw):
        super().__init__(master, columns=columns, show="headings", **kw)
        self.editable = set(editable if editable is not None else columns)
        self.on_edit = on_edit
        self._ed = None
        self.bind("<Double-1>", self._begin)

    def _begin(self, ev):
        if self.identify_region(ev.x, ev.y) != "cell":
            return
        row = self.identify_row(ev.y)
        col = self.identify_column(ev.x)
        cname = self["columns"][int(col[1:]) - 1]
        if not row or cname not in self.editable:
            return
        self.edit_cell(row, cname)

    def edit_cell(self, row, cname):
        if self._ed is not None:
            self._ed.destroy()
        bbox = self.bbox(row, cname)
        if not bbox:
            return
        x, y, w, h = bbox
        old = self.set(row, cname)
        ed = ttk.Entry(self)
        ed.insert(0, old)
        ed.select_range(0, "end")
        ed.place(x=x, y=y, width=w, height=h)
        ed.focus_set()
        self._ed = ed
        done = {"v": False}

        def commit(_e=None):
            if done["v"]:
                return
            done["v"] = True
            new = ed.get()
            ed.destroy()
            self._ed = None
            if new == old:
                return
            self.set(row, cname, new)
            if self.on_edit and self.on_edit(row, cname, new, old) is False:
                self.set(row, cname, old)

        def cancel(_e=None):
            done["v"] = True
            ed.destroy()
            self._ed = None

        ed.bind("<Return>", commit)
        ed.bind("<KP_Enter>", commit)
        ed.bind("<Tab>", commit)
        ed.bind("<FocusOut>", commit)
        ed.bind("<Escape>", cancel)


def tree_with_scroll(master, tree_cls=ttk.Treeview, **kw):
    """Crea un Treeview con barras de desplazamiento dentro de un marco."""
    f = ttk.Frame(master)
    t = tree_cls(f, **kw)
    sy = ttk.Scrollbar(f, orient="vertical", command=t.yview)
    sx = ttk.Scrollbar(f, orient="horizontal", command=t.xview)
    t.configure(yscrollcommand=sy.set, xscrollcommand=sx.set)
    t.grid(row=0, column=0, sticky="nsew")
    sy.grid(row=0, column=1, sticky="ns")
    sx.grid(row=1, column=0, sticky="ew")
    f.rowconfigure(0, weight=1)
    f.columnconfigure(0, weight=1)
    return f, t


# ----------------------------------------------------------------------------
class FormGrid:
    """Ayuda para maquetar formularios etiqueta + control en una rejilla."""

    def __init__(self, parent, label_width=None):
        self.p = parent
        self.r = 0
        self.lw = label_width
        parent.columnconfigure(1, weight=1)

    def row(self, label, widget, unit=None, tip=None, sticky=None):
        ttk.Label(self.p, text=label, width=self.lw).grid(row=self.r, column=0, sticky="w", padx=(0, px(8)),
                                                          pady=2)
        if sticky is None:
            # Los campos numéricos cortos no se estiran.
            sticky = "ew"
            if isinstance(widget, ttk.Entry):
                try:
                    if int(str(widget.cget("width"))) <= 18:
                        sticky = "w"
                except (ValueError, tk.TclError):
                    pass
        if unit:
            # La unidad va pegada al control, en la misma celda, para que no se separe del valor
            # cuando la columna se ensancha por otro control más ancho.
            cell = ttk.Frame(self.p)
            stretch = "e" in sticky
            widget.pack(in_=cell, side="left", fill="x" if stretch else "none", expand=stretch)
            widget.lift(cell)
            ttk.Label(cell, text=unit, foreground="#5b6475").pack(side="left", padx=(px(5), 0))
            cell.grid(row=self.r, column=1, sticky=sticky, pady=2)
        else:
            widget.grid(row=self.r, column=1, sticky=sticky, pady=2)
        if tip:
            self.r += 1
            WrapLabel(self.p, text=tip, foreground="#5b6475").grid(
                row=self.r, column=0, columnspan=3, sticky="ew", pady=(0, 4))
        self.r += 1
        return widget

    def full(self, widget, pady=2):
        widget.grid(row=self.r, column=0, columnspan=3, sticky="ew", pady=pady)
        self.r += 1
        return widget


def entry(parent, var, width=10, **kw):
    return ttk.Entry(parent, textvariable=var, width=width, **kw)


def combo(parent, var, values, width=18, state="readonly"):
    return ttk.Combobox(parent, textvariable=var, values=values, width=width, state=state)


class ProgressPanel(ttk.Frame):
    """Barra de progreso con mensaje, tiempo transcurrido y estimación del tiempo restante."""

    def __init__(self, master):
        super().__init__(master)
        self.var = tk.DoubleVar(value=0.0)
        self.bar = ttk.Progressbar(self, variable=self.var, maximum=100.0)
        self.bar.pack(fill="x")
        self.msg = WrapLabel(self, text="", foreground="#5b6475")
        self.msg.pack(fill="x", pady=(2, 0))
        self._t0 = None
        self._text = ""
        self._frac = 0.0

    def start(self, text=""):
        self._t0 = time.time()
        self._frac = 0.0
        self._text = text
        self.var.set(0.0)
        self._refresh()
        self._tick()

    def _tick(self):
        # Actualiza el tiempo transcurrido cada segundo mientras dura la tarea.
        if self._t0 is None:
            return
        self._refresh()
        try:
            self.after(1000, self._tick)
        except tk.TclError:
            pass

    def update_progress(self, frac=None, text=None):
        if frac is not None:
            self._frac = frac
            self.var.set(100.0 * frac)
        if text:
            self._text = text
        self._refresh()

    def _refresh(self):
        if self._t0 is None:
            self.msg.configure(text=self._text)
            return
        el = time.time() - self._t0
        s = f"{self._text}  ·  {int(round(self._frac * 100))}%  ·  {duration(el)}"
        if 0.12 < self._frac < 0.995 and el > 10:
            s += f"  ·  quedan ~{duration(el * (1 - self._frac) / self._frac)}"
        self.msg.configure(text=s)

    def finish(self, text):
        self._t0 = None
        self.msg.configure(text=text)


def place_near(win, master):
    """Coloca un diálogo centrado sobre la ventana principal."""
    win.update_idletasks()
    top = master.winfo_toplevel()
    x = top.winfo_rootx() + max(0, (top.winfo_width() - win.winfo_reqwidth()) // 2)
    y = top.winfo_rooty() + max(0, (top.winfo_height() - win.winfo_reqheight()) // 3)
    win.geometry(f"+{x}+{y}")


class MLCTable(ttk.Frame):
    """Tabla de parámetros por tipo de MLC: transmisión, DLG y ancho lengüeta-ranura.

    get() devuelve {nombre_interno: {"transmission", "dlg_mm", "tg_width_mm"}} con
    los MLC marcados; set() la rellena a partir de ese mismo diccionario.
    """

    COLS = (("transmission", "Transmisión", "fracción", 0.0, 0.2),
            ("dlg_mm", "DLG", "mm", 0.0, 5.0),
            ("tg_width_mm", "Lengüeta-ranura", "mm", 0.0, 2.0))

    def __init__(self, master):
        super().__init__(master)
        from ..mlc import MLC_TYPES
        self.rows = {}
        bold = ("TkDefaultFont", font_size(), "bold")
        ttk.Label(self, text="MLC", font=bold).grid(row=0, column=0, sticky="sw", padx=(0, 8))
        for j, (_, lab, unit, _, _) in enumerate(self.COLS, start=1):
            ttk.Label(self, text=f"{lab}\n({unit})", font=bold, justify="left").grid(
                row=0, column=j, sticky="sw", padx=4)
        for i, (key, (disp, _)) in enumerate(MLC_TYPES.items(), start=1):
            use = tk.BooleanVar(value=False)
            vars_ = {c[0]: tk.StringVar() for c in self.COLS}
            ents = []
            ttk.Checkbutton(self, text=disp, variable=use, command=lambda k=key: self._toggle(k)).grid(
                row=i, column=0, sticky="w", padx=(0, 8), pady=2)
            for j, c in enumerate(self.COLS, start=1):
                e = ttk.Entry(self, textvariable=vars_[c[0]], width=9)
                e.grid(row=i, column=j, sticky="w", padx=4, pady=2)
                ents.append(e)
            self.rows[key] = {"use": use, "vars": vars_, "entries": ents, "name": disp}
            self._toggle(key)
        WrapLabel(self, foreground="#5b6475",
                  text="Valores de la configuración del MLC en Eclipse. Cada haz usa los del MLC que se "
                       "identifica en el RTPLAN por los límites de las láminas; si el MLC del plan no está "
                       "marcado, el cálculo se detiene. Lengüeta-ranura: ancho total de la zona en cada límite "
                       "entre láminas (0: no se modela).").grid(
            row=len(self.rows) + 1, column=0, columnspan=4, sticky="ew", pady=(6, 0))

    def _toggle(self, key):
        r = self.rows[key]
        st = "normal" if r["use"].get() else "disabled"
        for e in r["entries"]:
            e.configure(state=st)

    def set(self, mlc):
        mlc = mlc or {}
        for key, r in self.rows.items():
            d = mlc.get(key)
            r["use"].set(d is not None)
            for c in self.COLS:
                r["vars"][c[0]].set("" if d is None else f"{float(d.get(c[0], 0.0)):g}")
            self._toggle(key)

    def get(self):
        out = {}
        for key, r in self.rows.items():
            if not r["use"].get():
                continue
            d = {}
            for c, lab, unit, lo, hi in self.COLS:
                d[c] = parse_float(r["vars"][c].get(), f"{lab} del {r['name']}", lo, hi)
            out[key] = d
        return out


# ----------------------------------------------------------------------------
class WrapLabel(ttk.Label):
    """Etiqueta cuyo texto se ajusta al ancho disponible.

    Debe colocarse estirada en horizontal (pack fill="x" o grid sticky="ew").
    """

    def __init__(self, master, initial=300, **kw):
        kw.setdefault("justify", "left")
        kw.pop("wraplength", None)
        super().__init__(master, wraplength=px(initial), **kw)
        self._wrapw = None
        self.bind("<Configure>", self._rewrap, add="+")

    def _rewrap(self, e):
        w = max(e.width - 4, px(80))
        if self._wrapw is None or abs(w - self._wrapw) > 2:
            self._wrapw = w
            self.configure(wraplength=w)


# ----------------------------------------------------------------------------
def _tree_fonts(tree):
    import tkinter.font as tkfont
    st = ttk.Style(tree)

    def get(style, default):
        f = st.lookup(style, "font") or default
        try:
            return tkfont.nametofont(f)
        except (tk.TclError, TypeError):
            return tkfont.Font(root=tree, font=f)
    return get("Treeview.Heading", "TkHeadingFont"), get("Treeview", "TkDefaultFont")


def autosize_columns(tree, minwidth=36, maxwidth=None, pad=20, fill=True, max_rows=400):
    """Ajusta el ancho de cada columna al texto de su cabecera y de sus celdas.

    Con fill=True, si sobra espacio se reparte entre las columnas en proporción a su
    ancho; si falta, se mantiene el ancho natural y aparece la barra horizontal.
    """
    hf, bf = _tree_fonts(tree)
    cols = list(tree["columns"])
    rows = tree.get_children()[:max_rows]
    nat = {}
    for c in cols:
        w = hf.measure(str(tree.heading(c, "text"))) + px(pad)
        for r in rows:
            w = max(w, bf.measure(str(tree.set(r, c))) + px(pad))
        if maxwidth:
            w = min(w, px(maxwidth))
        nat[c] = max(w, px(minwidth))
    if "tree" in str(tree.cget("show")):
        nat["#0"] = max(int(tree.column("#0", "width")), hf.measure(str(tree.heading("#0", "text"))) + px(pad))
    tree._natural_widths = nat
    tree._fill_columns = fill
    if not getattr(tree, "_autosize_bound", False):
        tree.bind("<Configure>", lambda e, t=tree: _fit_columns(t), add="+")
        tree._autosize_bound = True
    _fit_columns(tree)


def _fit_columns(tree):
    nat = getattr(tree, "_natural_widths", None)
    if not nat:
        return
    total = sum(nat.values())
    avail = tree.winfo_width() - 4
    extra = max(0, avail - total) if getattr(tree, "_fill_columns", True) and avail > 50 else 0
    for c, w in nat.items():
        tree.column(c, width=w + int(extra * w / total), minwidth=min(w, px(30)), stretch=False)


# ----------------------------------------------------------------------------
def checkbox_images(master, size=None):
    """Dos imágenes (sin marcar, marcada) para dibujar casillas dentro de un Treeview."""
    s = size or px(15)
    s = max(11, int(s))
    off = tk.PhotoImage(master=master, width=s, height=s)
    on = tk.PhotoImage(master=master, width=s, height=s)
    border, blue = "#6b7280", "#1f5fa8"
    off.put("#ffffff", to=(0, 0, s, s))
    on.put(blue, to=(0, 0, s, s))
    for img, col in ((off, border), (on, blue)):
        img.put(col, to=(0, 0, s, 1))
        img.put(col, to=(0, s - 1, s, s))
        img.put(col, to=(0, 0, 1, s))
        img.put(col, to=(s - 1, 0, s, s))
    # Marca de verificación en blanco
    t = max(1, s // 8)
    pts = []
    x0, y0 = int(s * 0.22), int(s * 0.52)
    x1, y1 = int(s * 0.42), int(s * 0.72)
    x2, y2 = int(s * 0.80), int(s * 0.28)
    for a, b, c, d in ((x0, y0, x1, y1), (x1, y1, x2, y2)):
        n = max(abs(c - a), abs(d - b)) + 1
        for k in range(n):
            pts.append((a + (c - a) * k // max(n - 1, 1), b + (d - b) * k // max(n - 1, 1)))
    for x, y in pts:
        on.put("#ffffff", to=(max(0, x - t // 2), max(0, y - t // 2), min(s, x + t - t // 2 + 1),
                              min(s, y + t - t // 2 + 1)))
    return off, on
