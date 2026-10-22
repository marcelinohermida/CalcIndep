/* CalcIndep web · pestaña «Comisionado» (gui/commission_tab.py). */
var CITabs = CITabs || {};
(function () {
  "use strict";
  const { el } = CIUI;
  const STEPS = [["primary_collimator", "Colimador primario (perfiles diagonales)"], ["spectrum", "Espectro"],
                 ["econt", "Contaminación electrónica"], ["output_factors", "Factores de campo"],
                 ["horns", "Perfil radial (cuernos)"], ["softening", "Ablandamiento fuera de eje"], ["source", "Tamaño de fuente"]];

  class CommissionTab {
    constructor(panel) {
      this.sources = [];       // {kind: "w2cad"|"pdd"|"profile", file: nombre, ...}
      this.files = new Map();  // nombre -> File
      this.curves = [];
      this.running = false; this.last = null;
      panel.classList.add("split");
      const left = el("div", { class: "leftpane" });
      const scroll = el("div", { class: "leftscroll" });
      this.actions = el("div", { class: "actions" });
      left.append(scroll, this.actions);
      const right = el("div", { class: "rightpane" });
      panel.append(left, right);
      this.buildForm(scroll);
      this.buildRight(right);
    }
    buildForm(p) {
      const G = v => CIApp.M.fmtG(v);
      let s = CIUI.section("1. Máquina y energía");
      let f = new CIUI.Form(s);
      this.vName = f.row("Nombre del modelo", CIUI.input("", 16));
      this.vMachine = f.row("Máquina", CIUI.input("", 16), null,
        "Igual que TreatmentMachineName en el plan (por ejemplo, el nombre de la unidad en Eclipse).");
      this.vEnergy = f.row("Energía", CIUI.input("6X", 7, { list: "dl-en-com" }));
      this.vEnergy.addEventListener("change", () => { this.vMode.value = this.vEnergy.value.toUpperCase().indexOf("FFF") >= 0 ? "FFF" : "STANDARD"; });
      this.vMode = f.row("Modo de fluencia", CIUI.select(["STANDARD", "FFF"], "STANDARD", 9));
      s.appendChild(el("datalist", { id: "dl-en-com" }, el("option", { value: "6X" }), el("option", { value: "6FFF" })));
      p.appendChild(s);
      s = CIUI.section("2. Curvas medidas (PDD y perfiles)");
      this.srcTable = new CIUI.Table([{ key: "fich", title: "Fichero" }, { key: "fmt", title: "Formato" }, { key: "det", title: "Descripción" }],
                                     { select: "multi", height: "9em" });
      s.append(this.srcTable.el, el("div", { class: "row" },
        el("button", { onclick: () => this.addW2cad() }, "Añadir w2CAD…"), el("button", { onclick: () => this.addCsv() }, "Añadir CSV…"),
        el("button", { onclick: () => this.removeSource() }, "Quitar")),
        el("div", { class: "muted small" }, "w2CAD (.asc) es el formato de los golden beam data de Varian. Se recomiendan PDD de " +
                                            "3×3, 10×10, 20×20 y 40×40 cm y perfiles X, Y y diagonales a varias profundidades."));
      p.appendChild(s);
      s = CIUI.section("3. Factores de campo");
      f = new CIUI.Form(s);
      this.ofLbl = el("span", { class: "folder" }, "—");
      f.row("Fichero", el("div", { class: "row" }, this.ofLbl, el("button", { onclick: () => this.chooseOf() }, "Examinar…"),
                          el("button", { onclick: () => { this.ofFile = null; this.ofLbl.textContent = "—"; this.ofMsg.textContent = ""; } }, "Quitar")),
            null, "Tabla 2D de Varian (p. ej. 06X_00.txt) o CSV con columnas campo_x_mm, campo_y_mm, factor (decimal con punto).");
      this.vOfSsd = f.row("DFS de medida", CIUI.input("950", 7), "mm");
      this.vOfDepth = f.row("Profundidad de medida", CIUI.input("50", 7), "mm");
      this.vOfRef = f.row("Campo de referencia", CIUI.input("100", 7), "mm");
      this.ofMsg = f.full(el("div", { class: "small" }));
      p.appendChild(s);
      s = CIUI.section("4. Colimación (valores de la configuración de Eclipse)");
      f = new CIUI.Form(s);
      this.mlcTable = new CITabs.MLCTable();
      this.mlcTable.set({ Millennium120: new CIApp.M.MLCParams().toDict() });
      f.full(this.mlcTable.el);
      this.vJaw = f.row("Transmisión de mandíbulas", CIUI.input("0.001", 7), "fracción");
      p.appendChild(s);
      s = CIUI.section("5. Calibración de UM");
      f = new CIUI.Form(s);
      this.vCalD = f.row("Dosis por UM", CIUI.input("1.0", 7), "cGy/UM");
      this.vCalSsd = f.row("DFS", CIUI.input("1000", 7), "mm");
      this.vCalDepth = f.row("Profundidad", CIUI.input("15", 7), "mm");
      this.vCalField = f.row("Campo cuadrado", CIUI.input("100", 7), "mm");
      p.appendChild(s);
      s = CIUI.section("6. Ajuste");
      f = new CIUI.Form(s);
      this.vGrid = f.row("Rejilla de cálculo", CIUI.input("2.5", 5, { type: "number", step: "0.5", min: "1", max: "5" }), "mm",
                         "Use el mismo tamaño de vóxel que en la verificación de planes.");
      this.vSteps = {};
      for (const [k, lab] of STEPS) { this.vSteps[k] = f.full(CIUI.checkbox(lab, true)); }
      p.appendChild(s);
      p.appendChild(el("div", { class: "row" }, el("button", { onclick: () => this.loadConfig() }, "Cargar configuración…"),
                       el("button", { onclick: () => this.saveConfig() }, "Guardar configuración…")));
      p.appendChild(el("div", { class: "muted small note" }, "El ajuste tarda entre 15 y 60 minutos según el número de curvas y el " +
                                                           "ordenador. El modelo se guarda en la biblioteca al terminar."));
      this.runBtn = el("button", { class: "primary big", onclick: () => this.run() }, "Comisionar");
      this.cancelBtn = el("button", { class: "big", disabled: true, onclick: () => this.cancel() }, "Cancelar");
      this.progress = new CIUI.ProgressPanel();
      this.actions.append(el("div", { class: "row" }, this.runBtn, this.cancelBtn), this.progress.el);
    }
    buildRight(p) {
      const cf = el("div", { class: "pad col" });
      this.curveTable = new CIUI.Table([{ key: "tipo", title: "Tipo" }, { key: "campo", title: "Campo (cm)", align: "right" },
                                        { key: "dfs", title: "DFS (cm)", align: "right" }, { key: "prof", title: "Prof. (cm)", align: "right" },
                                        { key: "eje", title: "Eje" }, { key: "n", title: "Puntos", align: "right" }, { key: "orig", title: "Fichero" }],
                                       { select: "multi", height: "14em", onSelect: () => this.plotCurves() });
      this.curveMsg = el("div", { class: "muted small" }, "Añada ficheros de curvas para verlas aquí.");
      this.cCanvas = el("canvas");
      this.cWrap = el("div", { class: "vcanvas" }, this.cCanvas);
      this.cfig = new CIG.Figure(this.cCanvas, 500, 300);
      new ResizeObserver(() => this.plotCurves()).observe(this.cWrap);
      cf.append(this.curveTable.el, this.curveMsg, this.cWrap);
      const rf = el("div", { class: "pad col" });
      this.resLbl = el("div", { class: "sumtext" }, "Sin resultados.");
      this.repBtn = el("button", { disabled: true, onclick: () => this.openReport() }, "Abrir informe de comisionado");
      this.gotoBtn = el("button", { disabled: true, onclick: () => CIApp.showModel(this.last.modelFile) }, "Ver el modelo");
      this.valTable = new CIUI.Table([{ key: "curva", title: "Curva" }, { key: "g", title: "γ 2%/2 mm (%)", align: "right" },
                                      { key: "d", title: "|Dif.| máx. central (%)", align: "right" }, { key: "pdd", title: "PDD10 med. / calc.", align: "right" }],
                                     { rowClass: r => r.tag, height: "40vh" });
      this.ofTable = new CIUI.Table([{ key: "campo", title: "Campo (cm)", align: "right" }, { key: "med", title: "Medido", align: "right" },
                                     { key: "calc", title: "Calculado", align: "right" }, { key: "dif", title: "Dif. (%)", align: "right" }],
                                    { rowClass: r => r.tag, height: "25vh" });
      rf.append(this.resLbl, el("div", { class: "row" }, this.repBtn, this.gotoBtn), this.valTable.el, this.ofTable.el);
      const lf = el("div", { class: "logpanel" });
      this.log = new CIUI.LogBox();
      lf.appendChild(this.log.el);
      this.tabs = CIUI.tabs(p, [{ title: "Curvas medidas", el: cf }, { title: "Resultado", el: rf }, { title: "Registro", el: lf }],
                            i => { if (i === 0) this.plotCurves(); });
    }
    // ------------------------------------------------------------------ fuentes
    addFile(file) {
      let name = file.name;
      // nombres repetidos de carpetas distintas
      if (this.files.has(name) && this.files.get(name) !== file) {
        let i = 2;
        while (this.files.has(`${name} (${i})`)) i++;
        name = `${name} (${i})`;
      }
      this.files.set(name, file);
      return name;
    }
    async addW2cad() {
      const fs = await CIUI.pickFiles(".asc,.ASC,.txt", true);
      for (const f of fs) this.sources.push({ kind: "w2cad", file: this.addFile(f) });
      await this.refreshSources();
    }
    async addCsv() {
      const fs = await CIUI.pickFiles(".csv,.txt", true);
      if (!fs.length) return;
      const items = await CIDialogos.csvCurves(fs.map(f => f.name));
      if (!items) return;
      items.forEach((it, i) => { it.file = this.addFile(fs[i]); this.sources.push(it); });
      await this.refreshSources();
    }
    async removeSource() {
      const sel = new Set(this.srcTable.selectedIdx());
      this.sources = this.sources.filter((s, i) => !sel.has(i));
      await this.refreshSources();
    }
    async chooseOf() {
      const fs = await CIUI.pickFiles(".csv,.txt", false);
      if (!fs.length) return;
      this.ofFile = fs[0];
      this.ofLbl.textContent = fs[0].name;
      await this.readOfMeta();
    }
    async readOfMeta() {
      const M = CIApp.M;
      try {
        const [rows, meta] = M.readOutputFactors(await this.ofFile.text());
        if (meta.format === "tabla_2d") {
          if ("ssd_mm" in meta) { this.vOfSsd.value = M.fmtG(meta.ssd_mm); this.vOfDepth.value = M.fmtG(meta.depth_mm); }
          if ("ref_field_mm" in meta) this.vOfRef.value = M.fmtG(meta.ref_field_mm[0]);
          this.ofMsg.textContent = `Tabla 2D de Varian: ${rows.length} combinaciones X×Y (campos en cm). DFS, profundidad y campo de referencia leídos de la cabecera.`;
          this.ofMsg.className = "small ok";
        } else { this.ofMsg.textContent = `${rows.length} factores leídos.`; this.ofMsg.className = "small " + (rows.length ? "ok" : "err"); }
      } catch (e) { this.ofMsg.textContent = `No se puede leer: ${e.message}`; this.ofMsg.className = "small err"; }
    }
    describe(s) {
      const G = CIApp.M.fmtG;
      if (s.kind === "w2cad") return "PDD y perfiles";
      const f = `${G(s.field_x_mm / 10)}x${G(s.field_y_mm / 10)} cm, DFS ${G(s.ssd_mm / 10)}`;
      if (s.kind === "pdd") return `PDD ${f}`;
      return `Perfil ${s.axis} ${f}, prof. ${G(s.depth_mm / 10)} cm`;
    }
    async refreshSources() {
      this.srcTable.setRows(this.sources.map(s => ({ fich: s.file, fmt: s.kind === "w2cad" ? "w2CAD" : "CSV", det: this.describe(s) })));
      await this.loadCurves();
    }
    measured(withOf) {
      const m = { w2cad: this.sources.filter(s => s.kind === "w2cad").map(s => s.file), pdd: [], profiles: [] };
      for (const s of this.sources) {
        if (s.kind === "w2cad") continue;
        const d = Object.assign({}, s);
        delete d.kind;
        (s.kind === "pdd" ? m.pdd : m.profiles).push(d);
      }
      if (withOf && this.ofFile) {
        const P = CIUI.parseNum;
        m.output_factors = { file: this.ofFile.name, ssd_mm: P(this.vOfSsd.value, "DFS de los factores de campo", 500),
                             depth_mm: P(this.vOfDepth.value, "Profundidad de los factores", 0),
                             ref_field_mm: P(this.vOfRef.value, "Campo de referencia", 10) };
      }
      return m;
    }
    async fileTexts(includeOf) {
      const out = {};
      const dec = new TextDecoder("latin1");
      for (const [n, f] of this.files) out[n] = dec.decode(new Uint8Array(await f.arrayBuffer()));
      if (includeOf && this.ofFile) out[this.ofFile.name] = await this.ofFile.text();
      return out;
    }
    async loadCurves() {
      this.curves = [];
      if (!this.sources.length) { this.curveTable.setRows([]); this.curveMsg.textContent = "Añada ficheros de curvas para verlas aquí."; this.plotCurves(); return; }
      const M = CIApp.M;
      let info = {};
      try {
        const texts = await this.fileTexts(false);
        // w2CAD en latin-1; CSV en UTF-8
        for (const s of this.sources) if (s.kind !== "w2cad") texts[s.file] = await this.files.get(s.file).text();
        [this.curves] = M.loadMeasured(this.measured(false), texts, info);
      } catch (e) { this.curveMsg.textContent = `Error al leer las curvas: ${e.message}`; return; }
      const G = M.fmtG;
      this.curveTable.setRows(this.curves.map(c => ({ tipo: c.kind === "pdd" ? "PDD" : "Perfil", campo: `${G(c.field_x_mm / 10)}x${G(c.field_y_mm / 10)}`,
        dfs: G(c.ssd_mm / 10), prof: c.depth_mm === null ? "" : G(c.depth_mm / 10), eje: c.kind === "pdd" ? "" : c.axis,
        n: c.pos_mm.length, orig: c.source })));
      const npdd = this.curves.filter(c => c.kind === "pdd").length;
      let txt = `${this.curves.length} curvas de campo abierto: ${npdd} PDD y ${this.curves.length - npdd} perfiles ` +
        `(${this.curves.filter(c => c.is_half).length} medidos a un solo lado).`;
      if (info.skipped && info.skipped.length) {
        const cnt = new Map();
        for (const [, t] of info.skipped) cnt.set(t, (cnt.get(t) || 0) + 1);
        txt += " Descartadas por ser de cuña u otro tipo: " + Array.from(cnt.entries()).map(([k, v]) => `${v} ${k}`).join(", ") + ".";
      }
      if (info.repeated_files || info.duplicates) txt += ` Repetidas: ${info.repeated_files || 0} ficheros, ${info.duplicates || 0} curvas.`;
      this.curveMsg.textContent = txt + " Seleccione curvas para verlas.";
      if (this.curves.length) this.curveTable.select([0]);
    }
    plotCurves() {
      const W = Math.max(200, this.cWrap.clientWidth), H = Math.max(160, this.cWrap.clientHeight);
      this.cfig.resize(W, H);
      this.cfig.clear();
      const sel = this.curveTable.selectedIdx().map(i => this.curves[i]).filter(Boolean);
      const ax = this.cfig.axes([62, 16, W - 84, H - 64], { grid: true, xlabel: "Profundidad o posición (mm)", ylabel: "Dosis relativa (%)",
                                                            fontSize: 11, legend: sel.length ? "upper right" : false, legendSize: 10 });
      const cols = CIG.TAB10();
      sel.forEach((c, i) => { const [x, v] = c.normalized(); ax.line(x, v, { color: cols[i % 10], width: 1.2, label: c.label }); });
      this.cfig.draw();
    }
    // ------------------------------------------------------------------ configuración
    config() {
      const P = CIUI.parseNum, M = CIApp.M;
      const name = this.vName.value.trim();
      if (!name) throw new Error("Escriba un nombre para el modelo.");
      if (!this.sources.length) throw new Error("Añada curvas medidas.");
      if (!this.curves.some(c => c.kind === "pdd")) throw new Error("Hace falta al menos una PDD.");
      const energy = this.vEnergy.value.trim().toUpperCase();
      return M.CommissioningConfig({
        machine: this.vMachine.value.trim(), energy, fluence_mode: this.vMode.value, name, measured: this.measured(true),
        mlc: this.mlcTable.get(), jaw_transmission: P(this.vJaw.value, "Transmisión de mandíbulas", 0, 0.1),
        calibration: { dose_per_mu_cgy: P(this.vCalD.value, "Dosis por UM", 0.01), ssd_mm: P(this.vCalSsd.value, "DFS de calibración", 500),
                       depth_mm: P(this.vCalDepth.value, "Profundidad de calibración", 0), field_mm: P(this.vCalField.value, "Campo de calibración", 10) },
        grid_mm: P(this.vGrid.value, "Rejilla", 0.5, 10),
        steps: Object.fromEntries(Object.entries(this.vSteps).map(([k, v]) => [k, v.input.checked])) });
    }
    configJSON(cfg) {
      const o = {};
      for (const k of CIApp.M.COMM_CONFIG_KEYS) o[k] = cfg[k];
      return CIApp.M.pyJSON(o, new Set(["spectrum_refinements", "softening_horn_iterations"]));
    }
    async saveConfig() {
      let cfg;
      try { cfg = this.config(); } catch (e) { CIUI.error(e.message, "Configuración"); return; }
      CIUI.download(`comisionado_${CIAlmacen.safeName(cfg.name)}.json`, this.configJSON(cfg), "application/json");
    }
    async loadConfig() {
      const fs = await CIUI.pickFiles(".json,.asc,.ASC,.txt,.csv", true);
      if (!fs.length) return;
      const js = fs.find(f => /\.json$/i.test(f.name));
      if (!js) { CIUI.error("Seleccione el fichero JSON de configuración (y, a la vez, los ficheros de datos a los que se refiere).", "Configuración"); return; }
      let d;
      try { d = JSON.parse(CIApp.M.stripBOM(await js.text())); } catch (e) { CIUI.error(`No se puede leer: ${e.message}`, "Configuración"); return; }
      const byName = new Map(fs.map(f => [f.name.toLowerCase(), f]));
      const missing = [];
      const getF = p => { const b = String(p).split(/[\\/]/).pop().toLowerCase(); const f = byName.get(b); if (!f) missing.push(String(p)); return f; };
      const G = CIApp.M.fmtG;
      this.vName.value = d.name || ""; this.vMachine.value = d.machine || ""; this.vEnergy.value = d.energy || "6X";
      this.vMode.value = d.fluence_mode || "STANDARD";
      const meas = d.measured || {};
      this.sources = []; this.files = new Map();
      for (const x of meas.w2cad || []) { const f = getF(x); if (f) this.sources.push({ kind: "w2cad", file: this.addFile(f) }); }
      for (const [kind, k] of [["pdd", "pdd"], ["profile", "profiles"]]) for (const c0 of meas[k] || []) {
        const c = Object.assign({}, c0);
        const f = getF(c.file);
        if (!f) continue;
        c.file = this.addFile(f);
        if (c.field_x_mm === undefined) c.field_x_mm = c.field_mm;
        if (c.field_y_mm === undefined) c.field_y_mm = c.field_mm;
        if (c.ssd_mm === undefined) c.ssd_mm = 1000.0;
        this.sources.push(Object.assign({ kind }, c));
      }
      const of = meas.output_factors;
      if (of) {
        const f = getF(of.file);
        if (f) { this.ofFile = f; this.ofLbl.textContent = f.name; await this.readOfMeta(); }
        this.vOfSsd.value = G(of.ssd_mm === undefined ? 1000 : of.ssd_mm);
        this.vOfDepth.value = G(of.depth_mm === undefined ? 100 : of.depth_mm);
        this.vOfRef.value = G(of.ref_field_mm === undefined ? 100 : of.ref_field_mm);
      }
      if (d.mlc) this.mlcTable.set(d.mlc);
      else this.mlcTable.set({ Millennium120: { transmission: d.mlc_transmission === undefined ? 0.013 : d.mlc_transmission,
                                                dlg_mm: d.mlc_dlg_mm === undefined ? 1.3 : d.mlc_dlg_mm, tg_width_mm: 0.0 } });
      this.vJaw.value = G(d.jaw_transmission === undefined ? 0.001 : d.jaw_transmission);
      const cal = d.calibration || {};
      this.vCalD.value = G(cal.dose_per_mu_cgy === undefined ? 1.0 : cal.dose_per_mu_cgy);
      this.vCalSsd.value = G(cal.ssd_mm === undefined ? 1000 : cal.ssd_mm);
      this.vCalDepth.value = G(cal.depth_mm === undefined ? 15 : cal.depth_mm);
      this.vCalField.value = G(cal.field_mm === undefined ? 100 : cal.field_mm);
      this.vGrid.value = G(d.grid_mm === undefined ? 2.5 : d.grid_mm);
      for (const [k, v] of Object.entries(d.steps || {})) if (this.vSteps[k]) this.vSteps[k].input.checked = !!v;
      await this.refreshSources();
      if (missing.length) CIUI.warn("No se han seleccionado estos ficheros de la configuración:\n" + missing.join("\n") +
                                    "\n\nVuelva a cargar la configuración seleccionando el JSON junto con todos sus ficheros de datos.", "Configuración");
    }
    // ------------------------------------------------------------------ comisionado
    async run() {
      if (this.running) return;
      let cfg;
      try {
        cfg = this.config();
        if (cfg.energy !== "6X" && cfg.energy !== "6FFF") {
          if (!(await CIUI.confirm("Los kernels incluidos llegan a 6 MeV y solo son adecuados para 6X y 6FFF. ¿Continuar de todos modos?", "Energía"))) return;
        }
      } catch (e) { CIUI.error(e.message, "Datos incompletos"); return; }
      const lib = CIApp.lib;
      const modelFile = `${CIAlmacen.safeName(cfg.name)}.json`;
      if (await lib.store.exists(`${lib.models_dir}/${modelFile}`) &&
          !(await CIUI.confirm(`Ya existe un modelo con el fichero ${modelFile}. ¿Sustituirlo?`, "Sobrescribir"))) return;
      const d = new Date();
      const stamp = CIInforme.stamp(d, "_").slice(0, 13);
      const repDir = `${lib.commissioning_dir}/${CIAlmacen.safeName(cfg.name)}_${stamp}`;
      this.log.clear();
      this.log.append(`Comisionado de «${cfg.name}» (${this.curves.length} curvas)`);
      this.runBtn.disabled = true; this.cancelBtn.disabled = false;
      this.progress.start("Comisionando");
      this.running = true;
      CIApp.setBusy(true);
      this.tabs.show(2);
      const t0 = Date.now();
      try {
        const files = await this.fileTexts(true);
        for (const s of this.sources) if (s.kind !== "w2cad") files[s.file] = await this.files.get(s.file).text();
        const r = await CIApp.hilos.call("comisionar", { cfg, files, gpuMode: CIApp.settings.gpu_mode }, {
          onProgress: m => {
            this.log.append(m, null, !m.startsWith("  "));
            if (!m.startsWith("  ")) this.progress.update(null, m);
          },
          onFraction: f => this.progress.update(f, null) });
        const rep = CIInforme.commissioningReport(r, new Date());
        const model = CIApp.M.BeamModel.fromJSON(r.model);
        model.commissioning_report = `${repDir}/informe_comisionado.html`;
        await lib.store.write(`${repDir}/informe_comisionado.html`, new Blob([rep], { type: "text/html" }));
        await lib.store.write(`${repDir}/configuracion.json`, this.configJSON(r.cfg));
        await lib.store.write(`${lib.models_dir}/${modelFile}`, model.toJSON());
        await lib.store.write(`${repDir}/${modelFile}`, model.toJSON());
        this.last = { r, model, report: `${repDir}/informe_comisionado.html`, modelFile };
        this.progress.finish(`Terminado en ${CIUI.duration((Date.now() - t0) / 1000)}. Modelo guardado en la biblioteca.`);
        this.log.append("Comisionado terminado", "ok");
        this.show(this.last);
        await CIApp.onLibraryChanged();
      } catch (e) {
        if (e.cancelled) { this.progress.finish("Comisionado cancelado"); this.log.append("Cancelado por el usuario", "error"); }
        else {
          this.progress.finish("Error en el comisionado");
          this.log.append(e.stack2 || e.stack || e.message, "error");
          CIAlmacen.logError(`Comisionado: ${e.stack2 || e.message}`);
          CIUI.error(e.message, "Error en el comisionado");
        }
      } finally {
        this.running = false;
        this.runBtn.disabled = false; this.cancelBtn.disabled = true;
        CIApp.setBusy(false);
      }
    }
    cancel() { if (this.running) { CIApp.hilos.cancel(); this.progress.update(null, "Cancelando (se detiene al terminar el paso en curso)…"); } }
    show(last) {
      const M = CIApp.M, m = last.model, val = last.r.val;
      const ok = val.filter(v => v.gamma_pass >= 95).length;
      const em = M.npsum(Float64Array.from(m.energies, (v, i) => v * m.weights[i]));
      this.resLbl.textContent = `Modelo «${m.name}» guardado (${last.modelFile}).\n` +
        `${ok} de ${val.length} curvas con γ 2%/2 mm ≥ 95%. Energía media del espectro ${M.fmtF(em, 2)} MeV · σ fuente ` +
        `${M.fmtG(m.primary_sigma_mm)} mm · fuente extrafocal w = ${M.fmtF(m.extrafocal_weight, 3)}, σ = ${M.fmtG(m.extrafocal_sigma_mm)} mm.\n` +
        "Revise el informe antes de marcar el modelo como validado para uso clínico.";
      this.valTable.setRows(val.map(v => ({ curva: v.curve.label, g: CIUI.fmt(v.gamma_pass, 1), d: CIUI.fmt(v.max_abs_diff_core),
        pdd: v.curve.kind !== "pdd" ? "" : `${M.fmtF(v.pdd10_meas, 1)} / ${M.fmtF(v.pdd10_calc, 1)}`, tag: v.gamma_pass >= 95 ? "" : "fail" })));
      this.ofTable.setRows(last.r.of.map(o => ({ campo: `${M.fmtG(o.fx / 10)}x${M.fmtG(o.fy / 10)}`, med: M.fmtF(o.meas, 4),
        calc: M.fmtF(o.calc, 4), dif: (o.diff_pct >= 0 ? "+" : "") + M.fmtF(o.diff_pct, 2), tag: Math.abs(o.diff_pct) <= 1.0 ? "" : "fail" })));
      this.repBtn.disabled = false; this.gotoBtn.disabled = false;
      this.tabs.show(1);
    }
    async openReport() {
      if (!this.last) return;
      try { CIUI.openBlob(await CIApp.lib.store.read(this.last.report), "text/html"); } catch (e) { CIUI.error(e.message); }
    }
  }
  CITabs.CommissionTab = CommissionTab;
})();
