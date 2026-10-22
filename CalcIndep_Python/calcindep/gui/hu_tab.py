"""Pestaña de curvas número CT – densidad electrónica."""
import shutil
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, simpledialog, ttk

import numpy as np
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure

from ..hu_ed import HUEDCurve
from .settings import safe_name
from .widgets import EditableTree, WrapLabel, autosize_columns, font_size, open_path, parse_float, px, tree_with_scroll


class HUTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master)
        self.app = app
        self.current = None
        self.dirty = False
        pw = ttk.Panedwindow(self, orient="horizontal")
        pw.pack(fill="both", expand=True)
        left = ttk.Frame(pw, padding=8)
        pw.add(left, weight=0)
        ttk.Label(left, text="Curvas de la biblioteca", font=("TkDefaultFont", font_size(1), "bold")).pack(anchor="w")
        self.lb = tk.Listbox(left, exportselection=False, width=34, height=14)
        self.lb.pack(fill="both", expand=True, pady=(4, 6))
        self.lb.bind("<<ListboxSelect>>", lambda e: self._select())
        bb = ttk.Frame(left)
        bb.pack(fill="x")
        for txt, cmd in (("Nueva", self.new), ("Importar CSV…", self.import_), ("Duplicar", self.duplicate),
                         ("Eliminar", self.delete)):
            ttk.Button(bb, text=txt, command=cmd).pack(side="left", padx=(0, 4))
        ttk.Button(left, text="Abrir carpeta de curvas",
                   command=lambda: open_path(self.app.settings.curves_dir)).pack(anchor="w", pady=(6, 10))
        ttk.Label(left, text="Escáneres asociados", font=("TkDefaultFont", font_size(1), "bold")).pack(anchor="w")
        WrapLabel(left, foreground="#5b6475",
                  text="Al verificar un plan, la curva elegida se asocia al escáner del CT y se propone "
                       "automáticamente la próxima vez.").pack(fill="x")
        tf, self.assoc = tree_with_scroll(left, columns=("esc", "curva"), show="headings", height=5)
        self.assoc.heading("esc", text="Escáner")
        self.assoc.heading("curva", text="Curva")
        self.assoc.column("esc", width=px(170))
        self.assoc.column("curva", width=px(120))
        tf.pack(fill="x", pady=(4, 4))
        ttk.Button(left, text="Quitar asociación", command=self.remove_assoc).pack(anchor="w")
        right = ttk.Frame(pw, padding=8)
        pw.add(right, weight=1)
        top = ttk.Frame(right)
        top.pack(fill="both", expand=True)
        tcol = ttk.Frame(top)
        tcol.pack(side="left", fill="y")
        ttk.Label(tcol, text="Puntos de la curva (doble clic para editar)").pack(anchor="w")
        tf, self.tree = tree_with_scroll(tcol, tree_cls=EditableTree, columns=("hu", "red"),
                                         on_edit=self._edited, height=18)
        self.tree.heading("hu", text="Número CT (HU)")
        self.tree.heading("red", text="Densidad electrónica relativa")
        self.tree.column("hu", width=px(120), anchor="e")
        self.tree.column("red", width=px(180), anchor="e")
        autosize_columns(self.tree, pad=28, fill=False)
        tf.pack(fill="y", expand=True, pady=(4, 6))
        bb = ttk.Frame(tcol)
        bb.pack(fill="x")
        ttk.Button(bb, text="Añadir punto", command=self.add_point).pack(side="left")
        ttk.Button(bb, text="Quitar punto", command=self.remove_point).pack(side="left", padx=4)
        self.msg = WrapLabel(tcol, text="")
        self.msg.pack(fill="x", pady=(6, 0))
        bb = ttk.Frame(tcol)
        bb.pack(fill="x", pady=(8, 0))
        self.save_btn = ttk.Button(bb, text="Guardar", style="Accent.TButton", command=self.save)
        self.save_btn.pack(side="left")
        ttk.Button(bb, text="Descartar cambios", command=self._select).pack(side="left", padx=6)
        figf = ttk.Frame(top)
        figf.pack(side="left", fill="both", expand=True, padx=(10, 0))
        self.fig = Figure(figsize=(5, 4), dpi=96, layout="tight")
        self.canvas = FigureCanvasTkAgg(self.fig, master=figf)
        self.canvas.get_tk_widget().pack(fill="both", expand=True)
        self.refresh_library()

    # ------------------------------------------------------------------
    def refresh_library(self):
        names = self.app.settings.list_curves()
        self.lb.delete(0, "end")
        for n in names:
            self.lb.insert("end", n)
        if self.current in names:
            i = names.index(self.current)
        else:
            i = 0 if names else None
        if i is not None:
            self.lb.selection_clear(0, "end")
            self.lb.selection_set(i)
            self._select()
        self.assoc.delete(*self.assoc.get_children())
        for k, v in self.app.settings.scanner_curves.items():
            self.assoc.insert("", "end", iid=k, values=(k, v))
        autosize_columns(self.assoc)

    def _select(self):
        sel = self.lb.curselection()
        if not sel:
            return
        self.current = self.lb.get(sel[0])
        try:
            c = self.app.settings.load_curve(self.current)
            pts = c.table()
        except Exception as e:  # noqa: BLE001
            pts = []
            self.msg.configure(text=f"No se puede leer la curva: {e}", foreground="#b42318")
        self.tree.delete(*self.tree.get_children())
        for h, r in pts:
            self.tree.insert("", "end", values=(f"{h:g}", f"{r:.4g}"))
        autosize_columns(self.tree, pad=28, fill=False)
        self.dirty = False
        self._validate()

    def _points(self):
        pts = []
        for r in self.tree.get_children():
            h = parse_float(self.tree.set(r, "hu"), "HU")
            d = parse_float(self.tree.set(r, "red"), "Densidad electrónica", 0)
            pts.append((h, d))
        pts.sort()
        return pts

    def _validate(self):
        try:
            pts = self._points()
            c = HUEDCurve([p[0] for p in pts], [p[1] for p in pts])
            msg, col = f"Curva válida con {len(pts)} puntos.", "#1b7f3b"
            if not (c.hu[0] <= -900 and c.hu[-1] >= 1000):
                msg += " Recomendación: incluya puntos por debajo de −900 HU y por encima de 1000 HU."
                col = "#9a6700"
            ok = True
        except ValueError as e:
            msg, col, ok, c = str(e), "#b42318", False, None
        self.msg.configure(text=msg + (" (cambios sin guardar)" if self.dirty else ""), foreground=col)
        self.save_btn.configure(state="normal" if ok else "disabled")
        self._plot(c)
        return ok

    def _plot(self, c):
        self.fig.clf()
        ax = self.fig.add_subplot(111)
        if c is not None:
            h = np.linspace(min(-1050, c.hu[0]), max(3000, c.hu[-1]), 400)
            ax.plot(h, c(h), color="#1f5fa8", lw=1.8)
            ax.plot(c.hu, c.red, "o", ms=6, color="#1f5fa8")
        ax.set_xlabel("Número CT (HU)", fontsize=14)
        ax.set_ylabel("Densidad electrónica relativa", fontsize=14)
        ax.tick_params(labelsize=12)
        ax.grid(alpha=0.3)
        ax.set_title(self.current or "", fontsize=14)
        self.fig.tight_layout()
        self.canvas.draw_idle()

    def _edited(self, row, col, new, old):
        try:
            parse_float(new, "valor")
        except ValueError as e:
            messagebox.showerror("Valor no válido", str(e), parent=self)
            return False
        self.dirty = True
        self.after(10, self._validate)
        return True

    def add_point(self):
        r = self.tree.insert("", "end", values=("0", "1"))
        self.tree.see(r)
        self.dirty = True
        self.tree.after(50, lambda: self.tree.edit_cell(r, "hu"))

    def remove_point(self):
        for r in self.tree.selection():
            self.tree.delete(r)
        self.dirty = True
        self._validate()

    def save(self):
        if not self.current or not self._validate():
            return
        pts = self._points()
        lines = ["HU,RED"] + [f"{h:g},{r:.4f}" for h, r in pts]
        (self.app.settings.curves_dir / self.current).write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.dirty = False
        self._validate()
        self.app.on_library_changed()

    # ------------------------------------------------------------------
    def _unique(self, stem):
        d = self.app.settings.curves_dir
        name = f"{safe_name(stem)}.csv"
        i = 2
        while (d / name).exists():
            name = f"{safe_name(stem)}_{i}.csv"
            i += 1
        return d / name

    def new(self):
        name = simpledialog.askstring("Nueva curva", "Nombre de la curva (por ejemplo, el escáner y el kV):",
                                      parent=self)
        if not name:
            return
        p = self._unique(name)
        p.write_text("HU,RED\n-1000,0.001\n0,1.000\n1000,1.500\n3000,2.800\n", encoding="utf-8")
        self.current = p.name
        self.app.on_library_changed()

    def import_(self):
        f = filedialog.askopenfilename(title="Importar curva HU–densidad",
                                       filetypes=[("CSV", "*.csv *.txt"), ("Todos", "*.*")], parent=self)
        if not f:
            return
        try:
            HUEDCurve.from_csv(f)
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("Importar", f"El fichero no es una curva válida: {e}\n\n"
                                 "Formato: dos columnas (HU, densidad electrónica relativa), punto decimal.",
                                 parent=self)
            return
        p = self._unique(Path(f).stem)
        shutil.copy(f, p)
        self.current = p.name
        self.app.on_library_changed()

    def duplicate(self):
        if not self.current:
            return
        name = simpledialog.askstring("Duplicar curva", "Nombre de la copia:",
                                      initialvalue=Path(self.current).stem + "_copia", parent=self)
        if not name:
            return
        p = self._unique(name)
        shutil.copy(self.app.settings.curves_dir / self.current, p)
        self.current = p.name
        self.app.on_library_changed()

    def delete(self):
        if not self.current:
            return
        if not messagebox.askyesno("Eliminar", f"¿Eliminar la curva «{self.current}»?", parent=self):
            return
        (self.app.settings.curves_dir / self.current).unlink(missing_ok=True)
        sc = self.app.settings.scanner_curves
        for k in [k for k, v in sc.items() if v == self.current]:
            sc.pop(k)
        self.app.settings.save()
        self.current = None
        self.app.on_library_changed()

    def remove_assoc(self):
        for k in self.assoc.selection():
            self.app.settings.scanner_curves.pop(k, None)
        self.app.settings.save()
        self.refresh_library()
