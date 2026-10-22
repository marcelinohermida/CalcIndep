/* CalcIndep web · pestaña «Curvas HU–densidad» (gui/hu_tab.py). */
var CITabs = CITabs || {};
(function () {
  "use strict";
  const { el } = CIUI;
  class HUTab {
    constructor(panel) {
      this.current = null; this.dirty = false;
      panel.classList.add("split");
      const left = el("div", { class: "leftpane narrow pad" });
      left.appendChild(el("h3", null, "Curvas de la biblioteca"));
      this.list = new CIUI.Table([{ key: "n", title: "Curva" }], { select: "single", height: "16em", onSelect: () => this.select() });
      left.append(this.list.el, el("div", { class: "row" },
        el("button", { onclick: () => this.newCurve() }, "Nueva"), el("button", { onclick: () => this.importCurve() }, "Importar CSV…"),
        el("button", { onclick: () => this.duplicate() }, "Duplicar"), el("button", { onclick: () => this.exportCurve() }, "Exportar…"),
        el("button", { onclick: () => this.remove() }, "Eliminar")));
      left.appendChild(el("h3", null, "Escáneres asociados"));
      left.appendChild(el("div", { class: "muted small" }, "Al verificar un plan, la curva elegida se asocia al escáner del CT y se propone " +
                                                          "automáticamente la próxima vez."));
      this.assoc = new CIUI.Table([{ key: "esc", title: "Escáner" }, { key: "curva", title: "Curva" }], { select: "multi", height: "9em" });
      left.append(this.assoc.el, el("button", { onclick: () => this.removeAssoc() }, "Quitar asociación"));
      const right = el("div", { class: "rightpane pad hsplit" });
      const tcol = el("div", { class: "col" });
      tcol.appendChild(el("div", null, "Puntos de la curva (doble clic para editar)"));
      this.points = new CIUI.Table([{ key: "hu", title: "Número CT (HU)", align: "right", editable: true },
                                    { key: "red", title: "Densidad electrónica relativa", align: "right", editable: true }],
                                   { select: "multi", height: "55vh", onEdit: (r, k, nv) => this.edited(nv) });
      this.msg = el("div", { class: "small" });
      this.saveBtn = el("button", { class: "primary", onclick: () => this.save() }, "Guardar");
      tcol.append(this.points.el,
                  el("div", { class: "row" }, el("button", { onclick: () => this.addPoint() }, "Añadir punto"),
                     el("button", { onclick: () => this.removePoint() }, "Quitar punto")),
                  this.msg, el("div", { class: "row" }, this.saveBtn, el("button", { onclick: () => this.select() }, "Descartar cambios")));
      this.canvas = el("canvas");
      this.wrap = el("div", { class: "vcanvas" }, this.canvas);
      this.fig = new CIG.Figure(this.canvas, 500, 400);
      new ResizeObserver(() => this.validate(true)).observe(this.wrap);
      right.append(tcol, this.wrap);
      panel.append(left, right);
    }
    async refreshLibrary() {
      const names = await CIApp.lib.listCurves();
      this.list.setRows(names.map(n => ({ n })));
      let i = names.indexOf(this.current);
      if (i < 0) i = names.length ? 0 : -1;
      if (i >= 0) this.list.select([i]);
      this.assoc.setRows(Object.entries(CIApp.settings.scanner_curves).map(([k, v]) => ({ esc: k, curva: v })));
    }
    async select() {
      const sel = this.list.selected();
      if (!sel.length) return;
      this.current = sel[0].n;
      let pts = [];
      try { pts = (await CIApp.lib.loadCurve(this.current)).table(); }
      catch (e) { this.msg.textContent = `No se puede leer la curva: ${e.message}`; this.msg.className = "small err"; }
      this.points.setRows(pts.map(([h, r]) => ({ hu: CIApp.M.fmtG(h), red: CIApp.M.fmtG(r, 4) })));
      this.dirty = false;
      this.validate();
    }
    pointsArr() {
      const pts = this.points.rows.map(r => [CIUI.parseNum(r.hu, "HU"), CIUI.parseNum(r.red, "Densidad electrónica", 0)]);
      pts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
      return pts;
    }
    validate(onlyPlot) {
      let c = null, ok = false, msg, cls;
      try {
        const pts = this.pointsArr();
        c = new CIApp.M.HUEDCurve(pts.map(p => p[0]), pts.map(p => p[1]));
        msg = `Curva válida con ${pts.length} puntos.`; cls = "ok";
        if (!(c.hu[0] <= -900 && c.hu[c.hu.length - 1] >= 1000)) {
          msg += " Recomendación: incluya puntos por debajo de −900 HU y por encima de 1000 HU."; cls = "warn";
        }
        ok = true;
      } catch (e) { msg = e.message; cls = "err"; }
      if (!onlyPlot) {
        this.msg.textContent = msg + (this.dirty ? " (cambios sin guardar)" : "");
        this.msg.className = "small " + cls;
        this.saveBtn.disabled = !ok;
      }
      this.plot(c);
      return ok;
    }
    plot(c) {
      const W = Math.max(200, this.wrap.clientWidth), H = Math.max(200, this.wrap.clientHeight);
      this.fig.resize(W, H);
      this.fig.clear();
      const ax = this.fig.axes([75, 40, W - 100, H - 100], { grid: true, xlabel: "Número CT (HU)", ylabel: "Densidad electrónica relativa",
                                                            fontSize: 13, title: this.current || "", titleSize: 14 });
      if (c) {
        const h = CIApp.M.linspace(Math.min(-1050, c.hu[0]), Math.max(3000, c.hu[c.hu.length - 1]), 400);
        ax.line(h, h.map(v => c.value(v)), { color: "#1f5fa8", width: 1.8 });
        ax.line(Array.from(c.hu), Array.from(c.red), { color: "#1f5fa8", marker: true, ms: 4, markersOnly: true });
      }
      this.fig.draw();
    }
    edited(nv) {
      try { CIUI.parseNum(nv, "valor"); } catch (e) { CIUI.error(e.message, "Valor no válido"); return false; }
      this.dirty = true;
      setTimeout(() => this.validate(), 10);
      return true;
    }
    addPoint() {
      this.points.rows.push({ hu: "0", red: "1" });
      this.points.render();
      this.dirty = true;
      const i = this.points.rows.length - 1;
      const tr = this.points.tbody.children[i];
      if (tr) { tr.scrollIntoView({ block: "nearest" }); this.points.edit(i, "hu", tr.children[0]); }
      this.validate();
    }
    removePoint() {
      const sel = new Set(this.points.selectedIdx());
      this.points.setRows(this.points.rows.filter((r, i) => !sel.has(i)));
      this.dirty = true;
      this.validate();
    }
    async save() {
      if (!this.current || !this.validate()) return;
      const pts = this.pointsArr();
      const M = CIApp.M;
      const text = ["HU,RED"].concat(pts.map(([h, r]) => `${M.fmtG(h)},${M.fmtF(r, 4)}`)).join("\n") + "\n";
      await CIApp.lib.store.write(`${CIApp.lib.curves_dir}/${this.current}`, text);
      this.dirty = false;
      this.validate();
      await CIApp.onLibraryChanged();
    }
    async newCurve() {
      const name = await CIUI.prompt("Nueva curva", "Nombre de la curva (por ejemplo, el escáner y el kV):");
      if (!name) return;
      const f = await CIApp.lib.uniqueName(CIApp.lib.curves_dir, name, ".csv");
      await CIApp.lib.store.write(`${CIApp.lib.curves_dir}/${f}`, "HU,RED\n-1000,0.001\n0,1.000\n1000,1.500\n3000,2.800\n");
      this.current = f;
      await CIApp.onLibraryChanged();
    }
    async importCurve() {
      const fs = await CIUI.pickFiles(".csv,.txt", false);
      if (!fs.length) return;
      const text = await fs[0].text();
      try { CIApp.M.HUEDCurve.fromCSV(text); }
      catch (e) {
        CIUI.error(`El fichero no es una curva válida: ${e.message}\n\nFormato: dos columnas (HU, densidad electrónica relativa), punto decimal.`, "Importar");
        return;
      }
      const f = await CIApp.lib.uniqueName(CIApp.lib.curves_dir, fs[0].name.replace(/\.[^.]*$/, ""), ".csv");
      await CIApp.lib.store.write(`${CIApp.lib.curves_dir}/${f}`, text);
      this.current = f;
      await CIApp.onLibraryChanged();
    }
    async duplicate() {
      if (!this.current) return;
      const name = await CIUI.prompt("Duplicar curva", "Nombre de la copia:", this.current.replace(/\.[^.]*$/, "") + "_copia");
      if (!name) return;
      const f = await CIApp.lib.uniqueName(CIApp.lib.curves_dir, name, ".csv");
      await CIApp.lib.store.write(`${CIApp.lib.curves_dir}/${f}`, await CIApp.lib.curveText(this.current));
      this.current = f;
      await CIApp.onLibraryChanged();
    }
    async exportCurve() { if (this.current) CIUI.download(this.current, await CIApp.lib.curveText(this.current), "text/csv"); }
    async remove() {
      if (!this.current) return;
      if (!(await CIUI.confirm(`¿Eliminar la curva «${this.current}»?`, "Eliminar"))) return;
      await CIApp.lib.store.remove(`${CIApp.lib.curves_dir}/${this.current}`);
      const sc = CIApp.settings.scanner_curves;
      for (const k of Object.keys(sc)) if (sc[k] === this.current) delete sc[k];
      await CIApp.settings.save();
      this.current = null;
      await CIApp.onLibraryChanged();
    }
    async removeAssoc() {
      for (const r of this.assoc.selected()) delete CIApp.settings.scanner_curves[r.esc];
      await CIApp.settings.save();
      await this.refreshLibrary();
    }
  }
  CITabs.HUTab = HUTab;
})();
