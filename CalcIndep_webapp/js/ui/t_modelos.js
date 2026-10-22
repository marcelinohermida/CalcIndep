/* CalcIndep web · pestaña «Modelos de haz» (gui/models_tab.py) y tabla de parámetros por MLC (widgets.MLCTable). */
var CITabs = CITabs || {};
(function () {
  "use strict";
  const { el } = CIUI;

  // Tabla de parámetros por tipo de MLC
  class MLCTable {
    constructor() {
      const M = CIApp.M;
      this.COLS = [["transmission", "Transmisión", "fracción", 0.0, 0.2], ["dlg_mm", "DLG", "mm", 0.0, 5.0],
                   ["tg_width_mm", "Lengüeta-ranura", "mm", 0.0, 2.0]];
      this.el = el("div", { class: "mlctable" });
      const t = el("table", { class: "plain" });
      const hr = el("tr", null, el("th", null, "MLC"), ...this.COLS.map(c => el("th", null, c[1], el("br"), el("span", { class: "muted" }, `(${c[2]})`))));
      t.appendChild(hr);
      this.rows = {};
      for (const [k, [disp]] of Object.entries(M.MLC_TYPES)) {
        const use = el("input", { type: "checkbox" });
        const ins = this.COLS.map(() => CIUI.input("", 6));
        use.addEventListener("change", () => ins.forEach(i => { i.disabled = !use.checked; }));
        t.appendChild(el("tr", null, el("td", null, el("label", { class: "check" }, use, " ", disp)), ...ins.map(i => el("td", null, i))));
        this.rows[k] = { use, ins, name: disp };
      }
      this.el.append(t, el("div", { class: "muted small" },
        "Valores de la configuración del MLC en Eclipse. Cada haz usa los del MLC que se identifica en el RTPLAN por los límites " +
        "de las láminas; si el MLC del plan no está marcado, el cálculo se detiene. Lengüeta-ranura: ancho total de la zona en " +
        "cada límite entre láminas (0: no se modela)."));
    }
    set(mlc) {
      mlc = mlc || {};
      for (const [k, r] of Object.entries(this.rows)) {
        const d = mlc[k];
        r.use.checked = !!d;
        this.COLS.forEach((c, i) => { r.ins[i].value = d ? CIApp.M.fmtG(+(d[c[0]] || 0)) : ""; r.ins[i].disabled = !d; });
      }
    }
    get() {
      const out = {};
      for (const [k, r] of Object.entries(this.rows)) {
        if (!r.use.checked) continue;
        const d = {};
        this.COLS.forEach(([c, lab, , lo, hi], i) => { d[c] = CIUI.parseNum(r.ins[i].value, `${lab} del ${r.name}`, lo, hi); });
        out[k] = d;
      }
      return out;
    }
  }
  CITabs.MLCTable = MLCTable;

  const FIELDS = {
    "Identificación": [["name", "Nombre", "str", null, false], ["machine", "Máquina (TreatmentMachineName)", "str", null, false],
                       ["energy", "Energía", "energy", null, false], ["fluence_mode", "Modo de fluencia", "mode", null, false],
                       ["commissioned", "Comisionado y validado", "bool", null, false]],
    "Colimación": [["jaw_transmission", "Transmisión de mandíbulas", "float", "fracción", true]],
    "Fuentes": [["primary_sigma_mm", "σ de la fuente primaria", "float", "mm", true],
                ["primary_collimator_radius_mm", "Radio del colimador primario (0: no)", "float", "mm", true],
                ["primary_collimator_sigma_mm", "σ del colimador primario", "float", "mm", true],
                ["extrafocal_weight", "Peso de la fuente extrafocal", "float", null, true],
                ["extrafocal_sigma_mm", "σ de la fuente extrafocal en X", "float", "mm", true],
                ["extrafocal_sigma_y_mm", "σ de la fuente extrafocal en Y (0: igual)", "float", "mm", true],
                ["monitor_backscatter_k", "Retrodispersión a la cámara monitora", "float", null, true]],
    "Espectro y contaminación electrónica": [
      ["softening_per_cm", "Ablandamiento fuera de eje: coeficiente s", "float", "cm⁻ⁿ", true],
      ["softening_power", "Forma del ablandamiento n (1: lineal, 2: cuadrática)", "float", null, true],
      ["econt_weight", "Peso de la contaminación electrónica", "float", null, true],
      ["econt_k_per_cm", "Atenuación de la contaminación", "float", "cm⁻¹", true],
      ["econt_sigma_mm", "σ de la contaminación", "float", "mm", true]],
    "Cálculo": [["kernel_tilt", "Inclinar el kernel con la divergencia (campos grandes)", "bool", null, true]],
  };
  const CAL_FIELDS = [["dose_per_mu_cgy", "Dosis por UM", "cGy/UM"], ["ssd_mm", "DFS", "mm"], ["depth_mm", "Profundidad", "mm"],
                      ["field_mm", "Campo cuadrado", "mm"]];
  const g4 = v => CIApp.M.fmtG(v, 4);

  class ModelsTab {
    constructor(panel) {
      this.current = null; this.model = null; this.models = new Map(); this.busy = false;
      panel.classList.add("split");
      const left = el("div", { class: "leftpane narrow pad" });
      left.appendChild(el("h3", null, "Modelos de la biblioteca"));
      this.table = new CIUI.Table([{ key: "def", title: "Default", align: "center" }, { key: "nombre", title: "Nombre" },
                                   { key: "maq", title: "Máquina" }, { key: "en", title: "Energía" }, { key: "com", title: "Comisionado" }],
                                  { select: "single", rowClass: r => r.tag, onSelect: () => this.select() });
      left.appendChild(this.table.el);
      left.appendChild(el("div", { class: "row" },
        el("button", { onclick: () => this.newModel() }, "Nuevo"), el("button", { onclick: () => this.duplicate() }, "Duplicar"),
        el("button", { onclick: () => this.importModel() }, "Importar…"), el("button", { onclick: () => this.exportModel() }, "Exportar…"),
        el("button", { onclick: () => this.remove() }, "Eliminar")));
      left.appendChild(el("div", { class: "muted small note" },
        "Marque la casilla «Default» del modelo que se usará por defecto en la verificación de planes (solo puede haber uno). " +
        "Se aplica a los haces de la misma energía y modo de fluencia; para los demás se elige el modelo de forma automática.\n\n" +
        "Para crear un modelo a partir de datos medidos use la pestaña «Comisionado». Aquí puede revisar y retocar los " +
        "parámetros. Si cambia un parámetro físico, el modelo se recalibra al guardar."));
      const mid = el("div", { class: "leftpane" });
      const formScroll = el("div", { class: "leftscroll" });
      this.actions = el("div", { class: "actions" });
      mid.append(formScroll, this.actions);
      const plots = el("div", { class: "rightpane pad" });
      this.plotCanvas = el("canvas");
      const pw = el("div", { class: "vcanvas" }, this.plotCanvas);
      plots.appendChild(pw);
      this.plotWrap = pw;
      this.fig = new CIG.Figure(this.plotCanvas, 400, 500);
      new ResizeObserver(() => this.plot()).observe(pw);
      panel.append(left, mid, plots);
      this.buildForm(formScroll);
    }
    buildForm(p) {
      this.vars = {};
      for (const [sec, fields] of Object.entries(FIELDS)) {
        const s = CIUI.section(sec);
        const f = new CIUI.Form(s);
        for (const [attr, label, typ, unit] of fields) {
          let w;
          if (typ === "bool") { w = CIUI.checkbox(label, false); f.full(w); this.vars[attr] = { typ, w: w.input }; continue; }
          if (typ === "energy") { w = CIUI.input("", 8, { list: "dl-energias" }); }
          else if (typ === "mode") { w = CIUI.input("", 8, { list: "dl-modos" }); }
          else w = CIUI.input("", typ === "str" ? 16 : 8);
          f.row(label, w, unit);
          this.vars[attr] = { typ, w };
        }
        if (sec === "Colimación") { this.mlcTable = new MLCTable(); f.full(this.mlcTable.el); }
        p.appendChild(s);
      }
      p.appendChild(el("datalist", { id: "dl-energias" }, ...["6X", "6FFF", "10X", "10FFF", "15X", "18X"].map(v => el("option", { value: v }))));
      p.appendChild(el("datalist", { id: "dl-modos" }, ...["STANDARD", "FFF", "SRS"].map(v => el("option", { value: v }))));
      const s = CIUI.section("Calibración de UM");
      const f = new CIUI.Form(s);
      this.cal = {};
      for (const [attr, label, unit] of CAL_FIELDS) this.cal[attr] = f.row(label, CIUI.input("", 8), unit);
      this.calLbl = f.full(el("div", { class: "muted small" }));
      this.calGrid = CIUI.input("2.5", 4, { type: "number", step: "0.5", min: "1", max: "5" });
      f.full(el("div", { class: "row between" }, el("span", null, "Rejilla de calibración ", this.calGrid, " mm"),
                el("button", { onclick: () => this.recalibrate() }, "Recalibrar")));
      p.appendChild(s);
      const sn = CIUI.section("Notas");
      this.notes = el("textarea", { rows: 4, style: { width: "100%" } });
      sn.appendChild(this.notes);
      p.appendChild(sn);
      this.saveBtn = el("button", { class: "primary", onclick: () => this.save() }, "Guardar cambios");
      this.repBtn = el("button", { class: "right", onclick: () => this.openReport() }, "Informe de comisionado");
      this.progress = new CIUI.ProgressPanel();
      this.actions.append(el("div", { class: "row" }, this.saveBtn, el("button", { onclick: () => this.select() }, "Descartar cambios"), this.repBtn),
                          this.progress.el);
    }
    async refreshLibrary() {
      this.models = await CIApp.lib.listModels();
      const s = CIApp.settings;
      if (s.default_model && !this.models.has(s.default_model)) s.default_model = "";
      const rows = [];
      for (const [f, m] of this.models) {
        const chk = el("input", { type: "checkbox" });
        chk.checked = f === s.default_model;
        chk.addEventListener("mousedown", e => e.stopPropagation());
        chk.addEventListener("change", () => this.toggleDefault(f));
        rows.push({ f, def: chk, nombre: m.name, maq: m.machine || "cualquiera",
                    en: m.energy + (m.fluence_mode === "STANDARD" ? "" : ` ${m.fluence_mode}`), com: m.commissioned ? "Sí" : "No",
                    tag: m.commissioned ? "" : "warn" });
      }
      this.table.setRows(rows);
      const files = rows.map(r => r.f);
      let i = files.indexOf(this.current);
      if (i < 0 && files.length) i = 0;
      if (i >= 0) this.table.select([i]);
    }
    async toggleDefault(fname) {
      const s = CIApp.settings;
      s.default_model = s.default_model === fname ? "" : fname;
      await s.save();
      for (const r of this.table.rows) r.def.checked = r.f === s.default_model;
      const m = this.models.get(s.default_model);
      CIApp.status(m ? `Modelo por defecto: ${m.name}` : "Sin modelo por defecto");
      await CIApp.tabs.verify.onDefaultModelChanged();
    }
    async select() {
      const sel = this.table.selected();
      if (!sel.length) return;
      this.current = sel[0].f;
      this.model = CIApp.M.BeamModel.fromJSON(await CIApp.lib.modelText(this.current));
      const m = this.model;
      for (const [attr, v] of Object.entries(this.vars)) {
        const val = m[attr];
        if (v.typ === "bool") v.w.checked = !!val;
        else v.w.value = typeof val === "number" ? g4(val) : String(val === undefined || val === null ? "" : val);
      }
      for (const [attr] of CAL_FIELDS) this.cal[attr].value = CIApp.M.fmtG(+m.calibration[attr]);
      this.mlcTable.set(m.mlc);
      const c = m.calibration;
      this.calLbl.textContent = c.cgy_per_unit > 0 ? `Factor actual: ${CIApp.M.fmtG(c.cgy_per_unit, 5)} cGy por unidad interna, obtenido con ` +
        `rejilla de ${CIApp.M.fmtG(c.grid_mm)} mm.` : "Modelo sin calibrar.";
      this.calGrid.value = CIApp.M.fmtG(c.grid_mm);
      this.notes.value = m.notes || "";
      this.repBtn.disabled = !(m.commissioning_report && await CIApp.lib.store.exists(m.commissioning_report));
      this.plot();
    }
    plot() {
      const W = Math.max(200, this.plotWrap.clientWidth), H = Math.max(200, this.plotWrap.clientHeight);
      this.fig.resize(W, H);
      this.fig.clear();
      const m = this.model;
      if (m) {
        const h = (H - 120) / 2;
        const a1 = this.fig.axes([65, 30, W - 90, h], { grid: true, xlabel: "Energía (MeV)", ylabel: "Fracción de fotones", title: "Espectro", fontSize: 10 });
        a1.bar(Array.from(m.energies), Array.from(m.weights), { width: 0.35, color: "#4c78a8" });
        const em = CIApp.M.npsum(Float64Array.from(m.energies, (v, i) => v * m.weights[i]));
        a1.text(0.97, 0.95, `E media\n${CIApp.M.fmtF(em, 2)} MeV`, { axesCoords: true, align: "right", baseline: "top", size: 10 });
        const a2 = this.fig.axes([65, 30 + h + 70, W - 90, h], { grid: true, xlabel: "Radio en el isocentro (mm)", ylabel: "Factor de fluencia",
                                                                title: "Perfil radial", fontSize: 10 });
        a2.line(m.oa_radius_mm, m.oa_factor, { color: "#1f5fa8", marker: true, ms: 2.5 });
      }
      this.fig.draw();
    }
    async readForm() {
      const M = CIApp.M;
      const m = M.BeamModel.fromJSON(await CIApp.lib.modelText(this.current));
      let changed = false;
      for (const fields of Object.values(FIELDS)) for (const [attr, label, typ, , phys] of fields) {
        const v = this.vars[attr];
        let nv;
        if (typ === "bool") nv = !!v.w.checked;
        else if (typ === "float") {
          const txt = v.w.value.trim();
          const old = +m[attr];
          nv = txt === g4(old) ? old : CIUI.parseNum(txt, label, 0);
        } else { nv = v.w.value.trim(); if (typ === "energy" || typ === "mode") nv = nv.toUpperCase(); }
        if (phys && Math.abs(Number(nv) - Number(m[attr])) > 1e-12) changed = true;
        m[attr] = nv;
      }
      for (const [attr, label] of CAL_FIELDS) {
        const txt = this.cal[attr].value.trim();
        const old = +m.calibration[attr];
        const nv = txt === M.fmtG(old) ? old : CIUI.parseNum(txt, label, 0);
        if (Math.abs(nv - m.calibration[attr]) > 1e-12) changed = true;
        m.calibration[attr] = nv;
      }
      m.mlc = this.mlcTable.get();
      m.notes = this.notes.value.trim();
      if (!m.name) throw new Error("El modelo necesita un nombre.");
      return [m, changed];
    }
    async save() {
      if (!this.current) return;
      let m, changed;
      try { [m, changed] = await this.readForm(); } catch (e) { CIUI.error(e.message, "Valor no válido"); return; }
      if (changed || m.calibration.cgy_per_unit <= 0) {
        let grid;
        try { grid = CIUI.parseNum(this.calGrid.value, "Rejilla", 0.5, 10); } catch (e) { CIUI.error(e.message); return; }
        await this.calibrateAndSave(m, this.current, grid, "Recalibrando el modelo con los nuevos parámetros");
      } else {
        await CIApp.lib.saveModel(this.current, m);
        await CIApp.onLibraryChanged();
      }
    }
    async recalibrate() {
      if (!this.current) return;
      let m, grid;
      try { [m] = await this.readForm(); grid = CIUI.parseNum(this.calGrid.value, "Rejilla", 0.5, 10); }
      catch (e) { CIUI.error(e.message, "Valor no válido"); return; }
      await this.calibrateAndSave(m, this.current, grid, "Calibrando");
    }
    async calibrateAndSave(m, fname, grid, text) {
      if (this.busy) return;
      this.busy = true;
      this.saveBtn.disabled = true;
      this.progress.start(text);
      this.progress.indeterminate(true);
      CIApp.setBusy(true);
      try {
        const r = await CIApp.hilos.call("calibrar", { model: m.toJSON(), grid, gpuMode: CIApp.settings.gpu_mode });
        const mm = CIApp.M.BeamModel.fromJSON(r.model);
        await CIApp.lib.saveModel(fname, mm);
        this.progress.finish(`Guardado. Factor de calibración ${CIApp.M.fmtG(mm.calibration.cgy_per_unit, 5)} (rejilla ${CIApp.M.fmtG(grid)} mm).`);
        await CIApp.onLibraryChanged();
      } catch (e) {
        this.progress.finish("Error en la calibración");
        CIUI.error(e.message);
      } finally { this.busy = false; this.saveBtn.disabled = false; CIApp.setBusy(false); }
    }
    async newModel() {
      const name = await CIUI.prompt("Nuevo modelo", "Nombre del modelo (parte del modelo genérico 6X):");
      if (!name) return;
      const m = CIApp.M.BeamModel.fromJSON(CI_DATOS.modelo_generico);
      m.name = name; m.commissioned = false; m.commissioning_report = "";
      const f = await CIApp.lib.uniqueName(CIApp.lib.models_dir, name, ".json");
      await CIApp.lib.saveModel(f, m);
      this.current = f;
      await CIApp.onLibraryChanged();
    }
    async duplicate() {
      if (!this.current) return;
      const m = CIApp.M.BeamModel.fromJSON(await CIApp.lib.modelText(this.current));
      const name = await CIUI.prompt("Duplicar modelo", "Nombre de la copia:", m.name + " (copia)");
      if (!name) return;
      m.name = name;
      const f = await CIApp.lib.uniqueName(CIApp.lib.models_dir, name, ".json");
      await CIApp.lib.saveModel(f, m);
      this.current = f;
      await CIApp.onLibraryChanged();
    }
    async importModel() {
      const fs = await CIUI.pickFiles(".json", false);
      if (!fs.length) return;
      const file = fs[0];
      let m, text;
      try { text = await file.text(); m = CIApp.M.BeamModel.fromJSON(text); }
      catch (e) { CIUI.error(`No es un modelo válido: ${e.message}`, "Importar"); return; }
      const f = await CIApp.lib.uniqueName(CIApp.lib.models_dir, file.name.replace(/\.json$/i, ""), ".json");
      await CIApp.lib.store.write(`${CIApp.lib.models_dir}/${f}`, text);
      this.current = f;
      await CIApp.onLibraryChanged();
      CIUI.info(`Modelo «${m.name}» importado.`, "Importar");
    }
    async exportModel() {
      if (!this.current) return;
      CIUI.download(this.current, await CIApp.lib.modelText(this.current), "application/json");
    }
    async remove() {
      if (!this.current) return;
      const m = this.models.get(this.current);
      if (!(await CIUI.confirm(`¿Eliminar el modelo «${m ? m.name : this.current}»?`, "Eliminar"))) return;
      await CIApp.lib.store.remove(`${CIApp.lib.models_dir}/${this.current}`);
      if (CIApp.settings.default_model === this.current) { CIApp.settings.default_model = ""; await CIApp.settings.save(); }
      this.current = null;
      await CIApp.onLibraryChanged();
    }
    async openReport() {
      if (this.model && this.model.commissioning_report) {
        try { CIUI.openBlob(await CIApp.lib.store.read(this.model.commissioning_report), "text/html"); }
        catch (e) { CIUI.error(`No se encuentra el informe: ${this.model.commissioning_report}`); }
      }
    }
  }
  CITabs.ModelsTab = ModelsTab;
})();
