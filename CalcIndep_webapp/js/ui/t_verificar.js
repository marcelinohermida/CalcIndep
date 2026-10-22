/* CalcIndep web · pestaña «Verificar plan» (gui/verify_tab.py). */
var CITabs = CITabs || {};
CITabs.VerifyTab = (function () {
  "use strict";
  const { el } = CIUI;
  const NORMS = [["max", "Máximo de la dosis de referencia"], ["prescription", "Prescripción del plan"]];
  const REFS = [["tps", "Dosis del TPS"], ["calc", "Cálculo independiente"]];
  const short = (name, n) => { n = n || 40; name = String(name); if (name.length <= n) return name; const k = Math.floor((n - 1) / 2); return name.slice(0, k) + "…" + name.slice(-(n - 1 - k)); };
  const key = (machine, energy, mode) => `${(machine || "").toUpperCase()}|${(energy || "").toUpperCase()}|${(mode || "STANDARD").toUpperCase()}`;
  const base = p => String(p).split(/[\\/]/).pop();

  class VerifyTab {
    constructor(panel) {
      this.app = CIApp; this.M = CIApp.M;
      this.index = null; this.planEntries = []; this.plan = null; this.resolved = null; this.structures = [];
      this.ctInfo = {}; this.beamModel = new Map(); this.overrides = {}; this.result = null; this.resultDir = null;
      this.models = new Map(); this.folder = null; this.running = false;
      this.panel = panel;
      panel.classList.add("split");
      this.left = el("div", { class: "leftpane" });
      this.scroll = el("div", { class: "leftscroll" });
      this.actions = el("div", { class: "actions" });
      this.left.append(this.scroll, this.actions);
      this.right = el("div", { class: "rightpane" });
      panel.append(this.left, this.right);
      this.buildInputs(this.scroll);
      this.buildResults(this.right);
    }

    // ================================================================ entradas
    buildInputs(p) {
      const s = CIApp.settings;
      const f1 = CIUI.section("1. Plan exportado del TPS");
      this.folderLbl = el("div", { class: "folder" }, "Ninguna carpeta seleccionada");
      const row = el("div", { class: "row" }, this.folderLbl,
                     el("button", { onclick: () => this.chooseFolder() }, "Examinar…"),
                     this.readBtn = el("button", { onclick: () => this.reloadFolder(), disabled: true }, "Leer"));
      const drop = el("div", { class: "drop" }, "Carpeta con el CT, el RTSTRUCT, el RTPLAN y el RTDOSE (puede contener varios planes). " +
                      "También puede arrastrar la carpeta aquí.");
      ["dragover", "dragenter"].forEach(ev => f1.addEventListener(ev, e => { e.preventDefault(); f1.classList.add("dragging"); }));
      f1.addEventListener("dragleave", () => f1.classList.remove("dragging"));
      f1.addEventListener("drop", async e => {
        e.preventDefault(); f1.classList.remove("dragging");
        try { const r = await CIUI.filesFromDrop(e.dataTransfer); if (r && r.files.length) await this.loadFolder(r); }
        catch (err) { CIUI.error(err.message); }
      });
      this.planSel = el("select", { class: "grow", onchange: () => this.selectPlan() });
      this.planInfo = el("div", { class: "planinfo" });
      this.beamsTable = new CIUI.Table([
        { key: "haz", title: "Haz" }, { key: "maq", title: "Máquina" }, { key: "tec", title: "Técnica" },
        { key: "en", title: "Energía", align: "right" }, { key: "um", title: "UM", align: "right" },
        { key: "mlc", title: "MLC" }, { key: "modelo", title: "Modelo de haz" }],
        { select: "single", rowClass: r => r.tag, onDblClick: (r, i, e) => this.beamMenu(r, e), onContext: (r, i, e) => this.beamMenu(r, e) });
      this.beamsNote = el("div", { class: "note warn" });
      f1.append(row, drop, el("div", { class: "row" }, el("label", null, "Plan "), this.planSel), this.planInfo,
                el("div", { class: "muted small" }, "Haces (doble clic para cambiar el modelo de haz)"), this.beamsTable.el, this.beamsNote);
      // 2. Densidades
      const f2 = CIUI.section("2. Densidades");
      const g2 = new CIUI.Form(f2);
      this.curveSel = CIUI.select([], "", 16);
      g2.row("Curva HU–densidad", this.curveSel);
      this.scannerLbl = g2.full(el("div", { class: "muted small" }));
      this.airChk = g2.full(CIUI.checkbox("Fuera del External: aire", s.outside_air));
      this.supChk = g2.full(CIUI.checkbox("Conservar estructuras de soporte (mesa)", s.keep_support));
      this.ovrLbl = el("span", { class: "muted" }, "Sin densidades asignadas");
      g2.full(el("div", { class: "row between" }, this.ovrLbl, el("button", { onclick: () => this.editOverrides() }, "Densidades por estructura…")));
      // 3. Rejilla
      const f3 = CIUI.section("3. Rejilla de cálculo");
      const nm = "grid" + Math.random();
      this.gridTps = el("input", { type: "radio", name: nm });
      this.gridCustom = el("input", { type: "radio", name: nm });
      (s.calc_spacing_mm ? this.gridCustom : this.gridTps).checked = true;
      this.gridMm = CIUI.input(CIApp.M.fmtG(s.calc_spacing_mm || 2.5), 4, { type: "number", step: "0.5", min: "1", max: "5" });
      f3.append(el("label", { class: "radio block" }, this.gridTps, " La misma que la dosis del TPS"),
                el("label", { class: "radio block" }, this.gridCustom, " Vóxel isótropo de ", this.gridMm, " mm"));
      // 4. Gamma
      const f4 = CIUI.section("4. Índice gamma");
      const g4 = new CIUI.Form(f4);
      const G = CIApp.M.fmtG;
      this.gDose = g4.row("Diferencia de dosis", CIUI.input(G(s.gamma_dose_pct), 5, { type: "number", step: "0.5", min: "0.5", max: "10" }), "%");
      this.gDta = g4.row("Distancia (DTA)", CIUI.input(G(s.gamma_dta_mm), 5, { type: "number", step: "0.5", min: "0.5", max: "10" }), "mm");
      this.gType = g4.row("Tipo", CIUI.select(["Global", "Local"], s.gamma_local ? "Local" : "Global", 8));
      this.gThr = g4.row("Umbral de dosis", CIUI.input(G(s.gamma_threshold_pct), 5, { type: "number", step: "5", min: "0", max: "50" }), "%");
      this.gNorm = g4.row("Normalización", CIUI.select(NORMS, s.gamma_normalization, 17));
      this.gRef = g4.row("Distribución de referencia", CIUI.select(REFS, s.gamma_reference, 13));
      this.gPass = g4.row("Aprobado si γ ≤ 1 en al menos", CIUI.input(G(s.pass_threshold_pct), 5, { type: "number", step: "1", min: "50", max: "100" }), "%");
      // 5. Resultados
      const f5 = CIUI.section("5. Resultados");
      this.outLbl = el("div", { class: "muted small" });
      this.saveRd = CIUI.checkbox("Guardar la dosis calculada como RTDOSE (para importar en Eclipse)", s.save_rtdose);
      f5.append(this.outLbl, this.saveRd);
      p.append(f1, f2, f3, f4, f5);
      // botones
      this.runBtn = el("button", { class: "primary big", onclick: () => this.run() }, "Calcular y comparar");
      this.cancelBtn = el("button", { class: "big", disabled: true, onclick: () => this.cancel() }, "Cancelar");
      this.progress = new CIUI.ProgressPanel();
      this.actions.append(el("div", { class: "row" }, this.runBtn, this.cancelBtn), this.progress.el);
      this.updateOutLabel();
    }
    updateOutLabel() { this.outLbl.textContent = `Se guardan en: ${CIApp.lib.describeResults()}`; }

    // ================================================================ resultados
    buildResults(p) {
      const sum = el("div", { class: "summary" });
      this.verdictEl = el("div", { class: "verdict" }, "Sin resultados");
      this.summaryLbl = el("div", { class: "sumtext" }, "Seleccione un plan y pulse «Calcular y comparar».");
      const top = el("div", { class: "row top" }, this.verdictEl, this.summaryLbl);
      this.openRepBtn = el("button", { disabled: true, onclick: () => this.openReport() }, "Abrir informe HTML");
      this.openDirBtn = el("button", { disabled: true, onclick: () => CIDialogos.resultados(this.resultDir) }, "Ver ficheros de resultados");
      this.warnBox = el("div", { class: "warnbox" });
      this.structTable = new CIUI.Table([
        { key: "est", title: "Estructura" }, { key: "tipo", title: "Tipo" }, { key: "vol", title: "Vol. (cc)", align: "right" },
        { key: "n", title: "Puntos", align: "right" }, { key: "pass", title: "γ≤1 (%)", align: "right" },
        { key: "gmean", title: "γ medio", align: "right" }, { key: "gp95", title: "γ p95", align: "right" },
        { key: "gmax", title: "γ máx.", align: "right" }, { key: "estado", title: "Estado" },
        { key: "dmt", title: "Dmedia TPS (Gy)", align: "right" }, { key: "dmc", title: "Dmedia cálc. (Gy)", align: "right" },
        { key: "ddm", title: "ΔDmedia (%)", align: "right" }, { key: "dd95", title: "ΔD95 (%)", align: "right" },
        { key: "dd2", title: "ΔD2 (%)", align: "right" }, { key: "ddmax", title: "ΔDmáx (%)", align: "right" }],
        { rowClass: r => r.tag, cls: "fill" });
      sum.append(top, el("div", { class: "row" }, this.openRepBtn, this.openDirBtn), this.warnBox, this.structTable.el);
      this.viewer = new CIVisor.SliceViewer(() => this.toggleMaximize());
      this.dvh = new CIVisor.DVHPanel(() => this.toggleMaximize());
      const logp = el("div", { class: "logpanel" });
      this.log = new CIUI.LogBox();
      logp.appendChild(this.log.el);
      this.subtabs = CIUI.tabs(p, [{ title: "Resumen", el: sum }, { title: "Visor de dosis", el: this.viewer.el },
                                   { title: "DVH", el: this.dvh.el }, { title: "Registro", el: logp }],
                               i => { if (i === 1) this.viewer.schedule(); if (i === 2) this.dvh.draw(); });
    }
    toggleMaximize() {
      const hidden = this.left.style.display === "none";
      this.left.style.display = hidden ? "" : "none";
      this.viewer.setMaximized(!hidden); this.dvh.setMaximized(!hidden);
      this.viewer.schedule(); this.dvh.draw();
    }

    // ================================================================ biblioteca
    async onDefaultModelChanged() { this.models = await CIApp.lib.listModels(); this.autoModels(); this.fillBeams(); }
    async refreshLibrary() {
      const s = CIApp.settings;
      this.models = await CIApp.lib.listModels();
      const curves = await CIApp.lib.listCurves();
      const cur = this.curveSel.value || s.last_curve;
      this.curveSel.textContent = "";
      for (const c of curves) this.curveSel.appendChild(el("option", { value: c }, c));
      this.curveSel.value = curves.indexOf(cur) >= 0 ? cur : (curves[0] || "");
      for (const [n, f] of Array.from(this.beamModel)) if (!this.models.has(f)) this.beamModel.delete(n);
      this.fillBeams();
      this.updateOutLabel();
    }

    // ================================================================ lectura
    async chooseFolder() {
      try {
        const r = await CIUI.pickFolder("dicom");
        if (r) await this.loadFolder(r);
      } catch (e) { CIUI.error(e.message); }
    }
    async reloadFolder() {
      if (!this.folder) return;
      try {
        if (this.folder.handle) {
          await CIAlmacen.verifyPermission(this.folder.handle, true).catch(() => true);
          this.folder.files = await CIUI.filesFromHandle(this.folder.handle);
        }
        await this.loadFolder(this.folder);
      } catch (e) { CIUI.error(e.message); }
    }
    async loadFolder(r) {
      this.folder = r;
      this.folderLbl.textContent = `${r.name} · ${r.files.length} ficheros`;
      this.readBtn.disabled = false;
      this.log.append(`Leyendo cabeceras DICOM de ${r.name}`);
      this.progress.start("Leyendo carpeta");
      this.runBtn.disabled = true;
      try {
        const files = r.files.map(x => ({ path: x.path, size: x.file.size, file: x.file,
                                          read: async (a, b) => new Uint8Array(await (a !== undefined ? x.file.slice(a, b) : x.file).arrayBuffer()) }));
        let n = 0;
        const idx = await this.M.indexFolder(files, f => { this.progress.update(f, null); n++; });
        this.progress.finish(`${idx.n_files} ficheros DICOM, ${idx.plans.length} planes`);
        this.index = idx;
        CIApp.settings.last_folder = r.name;
        this.planEntries = idx.plans.map((e, i) => [e, i]).sort((a, b) => (a[0].date < b[0].date ? 1 : a[0].date > b[0].date ? -1 : a[1] - b[1])).map(x => x[0]);
        this.planSel.textContent = "";
        this.planEntries.forEach((e, i) => this.planSel.appendChild(el("option", { value: i }, this.M.describePlanEntry(e))));
        if (!this.planEntries.length) { this.setInfo([["No se ha encontrado ningún RTPLAN en la carpeta.", "err"]]); return; }
        this.planSel.value = "0";
        await this.selectPlan();
      } catch (e) {
        this.progress.finish("Error al leer la carpeta");
        this.log.append(e.stack || e.message, "error");
        CIUI.error(e.message);
      } finally { this.runBtn.disabled = false; }
    }
    async readDs(f) { return this.M.dcmread(new Uint8Array(await f.file.arrayBuffer()), { force: true }); }
    async selectPlan() {
      const i = +this.planSel.value;
      if (!(i >= 0) || !this.index) return;
      const entry = this.planEntries[i];
      if (this.result) this.clearResults();
      const [ct, rs, rd, problems] = this.M.resolvePlan(this.index, entry);
      this.resolved = { ct, rs, rp: entry.path, rd };
      try { this.plan = this.M.readRTPlan(await this.readDs(entry.path)); }
      catch (e) { this.plan = null; problems.push(`No se puede leer el RTPLAN: ${e.message}`); }
      this.structures = [];
      if (rs) {
        try { this.structures = this.M.readRTStruct(await this.readDs(rs))[0]; }
        catch (e) { problems.push(`No se puede leer el RTSTRUCT: ${e.message}`); }
      }
      this.ctInfo = {};
      const stUid = entry.struct_uid ? (this.index.structs.get(entry.struct_uid) || {}).series_uid : null;
      const cts = this.index.cts;
      const ctrec = cts.get(stUid) || (cts.size === 1 ? cts.values().next().value : null);
      if (ctrec) this.ctInfo = ctrec;
      for (const k of Object.keys(this.overrides)) if (!this.structures.some(s => s.name === k)) delete this.overrides[k];
      this.updateOvrLabel();
      const sc = this.scannerKey();
      const cmap = CIApp.settings.scanner_curves;
      const opts = Array.from(this.curveSel.options).map(o => o.value);
      if (sc && sc in cmap && opts.indexOf(cmap[sc]) >= 0) this.curveSel.value = cmap[sc];
      this.scannerLbl.textContent = sc ? `Escáner del CT: ${sc}` + (sc in cmap ? " (curva asociada)" : " · la curva elegida se asociará a este escáner")
        : "Escáner del CT: sin identificar";
      const lines = [];
      if (this.plan) {
        const p = this.plan;
        const rx = p.prescription_gy ? ` · prescripción ${this.M.fmtF(p.prescription_gy, 2)} Gy` : "";
        lines.push([`${entry.patient_id}  ${entry.patient_name}`, "b"]);
        lines.push([`Plan ${p.label} · ${p.n_fractions} fracciones${rx}`, null]);
      }
      if (ct.length) lines.push([`CT: ${ct.length} cortes`, null]);
      if (rs) {
        const st = Array.from(this.index.structs.values()).find(v => v.path === rs) || {};
        lines.push([`Estructuras: ${st.label || ""} (${this.structures.length})`, null]);
      }
      if (rd.length) {
        const summ = new Map(this.index.doses.map(d => [d.path, d.summation]));
        lines.push([`Dosis TPS: ${rd.map(x => short(base(x.path))).join(", ")} (${summ.get(rd[0]) || ""})`, null]);
      }
      if (this.structures.length && !this.structures.some(s => s.type === "EXTERNAL"))
        problems.push("No hay estructura de tipo EXTERNAL: el cálculo y la gamma usarán toda la rejilla");
      if (this.plan) for (const b of this.plan.beams) for (const w of b.warnings) lines.push([`${b.name}: ${w}`, "warn"]);
      for (const pr of problems) lines.push([pr, "err"]);
      this.setInfo(lines);
      this.autoModels();
      this.fillBeams();
    }
    scannerKey() {
      const c = this.ctInfo;
      if (!c || !Object.keys(c).length) return "";
      return [c.station, c.manufacturer, c.model].filter(Boolean).join(" · ");
    }
    setInfo(lines) {
      this.planInfo.textContent = "";
      for (const [t, tag] of lines) this.planInfo.appendChild(el("div", { class: tag || "" }, t));
    }
    treatBeams() {
      if (!this.plan) return [];
      return this.plan.beams.filter(b => b.beam_type === "TREATMENT" && b.mu > 0 && b.radiation_type === "PHOTON");
    }
    autoModels() {
      const choice = CIApp.settings.model_choice, dflt = CIApp.settings.default_model;
      const dm = this.models.get(dflt);
      for (const b of this.treatBeams()) {
        if (dm && dm.energy.toUpperCase() === b.energy.toUpperCase() && dm.fluence_mode.toUpperCase() === b.fluence_mode.toUpperCase()) {
          this.beamModel.set(b.number, dflt); continue;
        }
        const k = key(b.machine, b.energy, b.fluence_mode);
        const f = choice[k];
        if (f && this.models.has(f)) { this.beamModel.set(b.number, f); continue; }
        const cands = Array.from(this.models).filter(([fn, m]) => m.energy.toUpperCase() === b.energy.toUpperCase() &&
                                                                    m.fluence_mode.toUpperCase() === b.fluence_mode.toUpperCase());
        const exact = cands.filter(([fn, m]) => m.machine && m.machine.toUpperCase() === b.machine.toUpperCase()).map(x => x[0]);
        const generic = cands.filter(([fn, m]) => !m.machine).map(x => x[0]);
        const pick = (exact.length ? exact : generic.length ? generic : cands.map(x => x[0]))[0];
        if (pick) this.beamModel.set(b.number, pick); else this.beamModel.delete(b.number);
      }
    }
    fillBeams() {
      const notes = new Set();
      const rows = [];
      for (const b of this.treatBeams()) {
        const f = this.beamModel.get(b.number);
        const m = this.models.get(f);
        let tag = "", name;
        if (!m) { name = "— sin modelo —"; tag = "missing"; }
        else {
          name = m.name;
          if (m.energy.toUpperCase() !== b.energy.toUpperCase() || m.fluence_mode.toUpperCase() !== b.fluence_mode.toUpperCase()) {
            notes.add(`El modelo «${m.name}» es de otra energía o modo de fluencia.`); tag = "warn";
          } else if (m.machine && m.machine.toUpperCase() !== b.machine.toUpperCase()) {
            notes.add(`El modelo «${m.name}» es de la máquina ${m.machine} y el plan usa ${b.machine}.`); tag = "warn";
          }
          if (!m.commissioned) { notes.add(`El modelo «${m.name}» no está comisionado.`); tag = "warn"; }
        }
        let mlcTxt = "sin MLC";
        if (b.leaf_boundaries) {
          try {
            const mk = this.M.identifyMLC(b.leaf_boundaries);
            mlcTxt = this.M.mlcDisplayName(mk);
            if (m && !(mk in m.mlc)) { notes.add(`El modelo «${m.name}» no tiene parámetros del MLC ${mlcTxt}: añádalos en «Modelos de haz».`); tag = "missing"; }
          } catch (e) { mlcTxt = "no reconocido"; notes.add(e.message); tag = "missing"; }
        }
        const en = b.energy + (b.fluence_mode === "STANDARD" ? "" : ` ${b.fluence_mode}`);
        if (m && f === CIApp.settings.default_model) name += "  (por defecto)";
        rows.push({ beam: b, haz: b.name, maq: b.machine, tec: b.technique, en, um: this.M.fmtF(b.mu, 1), mlc: mlcTxt, modelo: name, tag });
        if (!m) notes.add("Hay haces sin modelo de haz: haga doble clic en el haz para asignarlo.");
      }
      this.beamsTable.setRows(rows);
      this.beamsNote.textContent = Array.from(notes).sort().join("\n");
    }
    beamMenu(row, ev) {
      const beam = row.beam;
      const same = [], other = [];
      for (const [f, m] of this.models) {
        if (m.energy.toUpperCase() === beam.energy.toUpperCase() && m.fluence_mode.toUpperCase() === beam.fluence_mode.toUpperCase()) same.push([f, m]);
        else other.push([f, m]);
      }
      const k = key(beam.machine, beam.energy, beam.fluence_mode);
      const items = same.concat(other).map(([f, m]) => {
        let lab = `${m.name}  [${m.machine || "cualquier máquina"} · ${m.energy}]`;
        if (f === CIApp.settings.default_model) lab += "  (por defecto)";
        if (other.some(o => o[0] === f)) lab += "  — otra energía";
        return { label: lab, action: () => this.assignModel(k, f) };
      });
      if (!items.length) items.push({ label: "No hay modelos en la biblioteca", disabled: true, action: () => {} });
      CIUI.popupMenu(ev.clientX, ev.clientY, items);
    }
    assignModel(k, fname) {
      for (const b of this.treatBeams()) if (key(b.machine, b.energy, b.fluence_mode) === k) this.beamModel.set(b.number, fname);
      CIApp.settings.model_choice[k] = fname;
      CIApp.settings.save();
      this.fillBeams();
    }
    async editOverrides() {
      if (!this.structures.length) { CIUI.info("Primero seleccione un plan.", "Densidades"); return; }
      const r = await CIDialogos.overrides(this.structures, this.overrides);
      if (r) { this.overrides = r; this.updateOvrLabel(); }
    }
    updateOvrLabel() {
      const n = Object.keys(this.overrides).length;
      const rs = this.structures.filter(s => s.rel_elec_density !== null && s.rel_elec_density !== undefined && !(s.name in this.overrides)).length;
      let t = n ? `${n} asignadas aquí` : "Ninguna asignada aquí";
      if (rs) t += ` · ${rs} del RTSTRUCT`;
      this.ovrLbl.textContent = t;
    }

    // ================================================================ cálculo
    collect() {
      const s = CIApp.settings, P = CIUI.parseNum;
      if (!this.plan || !this.resolved) throw new Error("Seleccione un plan.");
      const { ct, rs, rd } = this.resolved;
      if (!ct.length || !rs || !rd.length) throw new Error("Faltan objetos DICOM del plan (CT, RTSTRUCT o RTDOSE). Revise los avisos.");
      const missing = this.treatBeams().filter(b => !this.beamModel.has(b.number)).map(b => b.name);
      if (missing.length) throw new Error("Haces sin modelo de haz: " + missing.join(", "));
      if (!this.curveSel.value) throw new Error("Seleccione una curva HU–densidad.");
      const gs = { dose_pct: P(this.gDose.value, "Diferencia de dosis", 0.1, 20), dta_mm: P(this.gDta.value, "DTA", 0.1, 20),
                   local: this.gType.value === "Local", threshold_pct: P(this.gThr.value, "Umbral", 0, 99),
                   normalization: this.gNorm.value, reference: this.gRef.value };
      if (gs.normalization === "prescription" && !this.plan.prescription_gy)
        throw new Error("El plan no tiene dosis de prescripción: use la normalización al máximo.");
      const passThr = P(this.gPass.value, "Umbral de aprobación", 0, 100);
      let spacing = null;
      if (this.gridCustom.checked) spacing = P(this.gridMm.value, "Tamaño de vóxel", 0.5, 10);
      const opts = { fluence_res_mm: s.fluence_res_mm, max_gantry_step_deg: s.max_gantry_step_deg, sector_deg: s.sector_deg,
                     trace_full_ct: s.trace_full_ct, margin_mm: s.margin_mm, outside_external: this.airChk.input.checked ? "air" : "ct",
                     keep_support_structures: this.supChk.input.checked, structure_overrides: JSON.parse(JSON.stringify(this.overrides)),
                     gpu: s.gpu_mode };
      const cfg = { gamma: gs, options: opts, pass_threshold_pct: passThr, calc_spacing_mm: spacing, save_rtdose: this.saveRd.input.checked };
      Object.assign(s, { gamma_dose_pct: gs.dose_pct, gamma_dta_mm: gs.dta_mm, gamma_local: gs.local, gamma_threshold_pct: gs.threshold_pct,
                         gamma_normalization: gs.normalization, gamma_reference: gs.reference, pass_threshold_pct: passThr,
                         outside_air: this.airChk.input.checked, keep_support: this.supChk.input.checked, calc_spacing_mm: spacing || 0.0,
                         save_rtdose: this.saveRd.input.checked, last_curve: this.curveSel.value });
      const sc = this.scannerKey();
      if (sc) s.scanner_curves[sc] = this.curveSel.value;
      s.save();
      const d = new Date();
      const entry = this.planEntries[+this.planSel.value];
      const out = `${CIAlmacen.safeName(entry.patient_id)}_${CIAlmacen.safeName(this.plan.label)}_${CIInforme.stamp(d, "_")}`;
      return { cfg, out };
    }
    async run() {
      if (this.running) return;
      let cfg, out;
      try { ({ cfg, out } = this.collect()); }
      catch (e) { CIUI.error(e.message, "Datos incompletos"); return; }
      const { ct, rs, rp, rd } = this.resolved;
      const models = {};
      for (const [n, f] of this.beamModel) models[n] = { file: f, json: await CIApp.lib.modelText(f) };
      const curve = { name: this.curveSel.value, text: await CIApp.lib.curveText(this.curveSel.value) };
      this.log.append(`Inicio del cálculo: plan ${this.plan.label}, resultados en ${out}`);
      this.clearResults();
      this.verdictEl.textContent = "Calculando…"; this.verdictEl.className = "verdict";
      this.summaryLbl.textContent = `Plan ${this.plan.label}. El avance se muestra debajo del botón «Calcular y comparar» y en la pestaña «Registro».`;
      this.runBtn.disabled = true; this.cancelBtn.disabled = false;
      this.progress.start("Preparando");
      this.running = true;
      CIApp.setBusy(true);
      const t0 = Date.now();
      try {
        const files = { ct: ct.map(f => f.file), rtstruct: { file: rs.file, path: rs.path }, rtplan: { file: rp.file, path: rp.path },
                        rtdose: rd.map(f => ({ file: f.file, path: f.path })) };
        const r = await CIApp.hilos.call("verificar", { files, config: cfg, curve, models }, {
          onProgress: m => { this.log.append(m); this.progress.update(null, m); },
          onFraction: f => this.progress.update(f, null) });
        this.log.append("Generando informe");
        this.progress.update(null, "Generando informe");
        const res = this.toUiResult(r);
        // ficheros de resultados (como run_check + write_report)
        if (r.rtdose) await CIApp.lib.writeResult(out, "RD_calculo_independiente.dcm", new Blob([r.rtdose]));
        await CIApp.lib.writeResult(out, "resumen.json", r.summary);
        const when = new Date();
        const html = CIInforme.verificationReport(res, when);
        const repName = CIInforme.reportFilename(res, when);
        await CIApp.lib.writeResult(out, repName, new Blob([html], { type: "text/html" }));
        res.reportName = repName; res.reportHtml = html;
        this.result = res; this.resultDir = out;
        const el_ = (Date.now() - t0) / 1000;
        this.progress.finish(`Terminado en ${CIUI.duration(el_)}`);
        this.log.append(`Terminado en ${CIUI.duration(el_)}`, "ok");
        this.log.append(`  Superposición: ${res.info.superposition}`, null, false);
        for (const b of res.beams) this.log.append(`  ${b.name}: ${this.M.fmtF(b.seconds, 0)} s, ${b.n_subbeams} incidencias, ` +
                                                   `${b.n_superpositions} superposiciones, modelo ${b.model}`, null, false);
        this.showResult(res);
      } catch (e) {
        if (e.cancelled) {
          this.verdictEl.textContent = "Cancelado"; this.progress.finish("Cálculo cancelado");
          this.log.append("Cálculo cancelado por el usuario", "error");
        } else {
          this.verdictEl.textContent = "Error"; this.verdictEl.className = "verdict err";
          this.progress.finish("Error");
          this.log.append(e.stack2 || e.stack || e.message, "error");
          CIAlmacen.logError(`Verificación: ${e.stack2 || e.message}`);
          let msg = e.message;
          if (e.keyError) msg = `No se ha encontrado un modelo de haz: ${e.message}`;
          CIUI.error(msg, "Error en el cálculo");
        }
      } finally {
        this.running = false;
        this.runBtn.disabled = false; this.cancelBtn.disabled = true;
        CIApp.setBusy(false);
      }
    }
    toUiResult(r) {
      const M = this.M;
      const res = Object.assign({}, r);
      res.plan = M.Plan.from(r.plan);
      res.tps_grid = M.Grid.from(r.tps_grid);
      res.masks = new Map(r.masks);
      res.curve = new M.HUEDCurve(r.curve.table.map(x => x[0]), r.curve.table.map(x => x[1]), r.curve.name);
      res.info = Object.assign({}, r.info, { tps_grid: M.Grid.from(r.info.tps_grid), calc_grid: M.Grid.from(r.info.calc_grid) });
      return res;
    }
    cancel() {
      if (this.running) { CIApp.hilos.cancel(); this.progress.update(null, "Cancelando (se detiene al terminar el paso en curso)…"); }
    }
    async openReport() {
      if (!this.result) return;
      try {
        const blob = await CIApp.lib.readResult(this.resultDir, this.result.reportName);
        CIUI.openBlob(blob, "text/html");
      } catch (e) { CIUI.openBlob(this.result.reportHtml, "text/html"); }
    }

    // ================================================================ mostrar resultados
    clearResults(text) {
      this.result = null; this.resultDir = null;
      this.verdictEl.textContent = "Sin resultados"; this.verdictEl.className = "verdict";
      this.summaryLbl.textContent = text || "Seleccione un plan y pulse «Calcular y comparar».";
      this.warnBox.textContent = ""; this.warnBox.style.display = "none";
      this.structTable.setRows([]);
      this.openRepBtn.disabled = true; this.openDirBtn.disabled = true;
      this.viewer.placeholder();
      this.dvh.setResult(null);
    }
    showResult(res) {
      const M = this.M;
      const cfg = res.config, st = res.gamma.stats, thr = cfg.pass_threshold_pct;
      const [ok, fails0] = M.verdict(res);
      this.verdictEl.textContent = ok ? "CUMPLE" : "NO CUMPLE";
      this.verdictEl.className = "verdict " + (ok ? "ok" : "ko");
      const gset = res.gamma.settings;
      const isoTxt = [];
      const seen = new Set();
      for (const b of res.plan.beams) {
        if (!b.cps.length || !b.cps[0].iso) continue;
        const k = Array.from(b.cps[0].iso, v => M.npRound(v, 1)).join("|");
        if (seen.has(k)) continue;
        seen.add(k);
        const fr = res.tps_grid.worldToIndex(b.cps[0].iso);
        const dt = M.mapCoord3(res.tps_dose, res.tps_grid.shape, fr[0], fr[1], fr[2], "constant", 0.0);
        const dc = M.mapCoord3(res.calc_dose, res.tps_grid.shape, fr[0], fr[1], fr[2], "constant", 0.0);
        if (dt > 0) { const d = (dc - dt) / dt * 100; isoTxt.push(`Isocentro: TPS ${M.fmtF(dt, 3)} Gy, cálculo ${M.fmtF(dc, 3)} Gy (${d >= 0 ? "+" : ""}${M.fmtF(d, 2)}%)`); }
      }
      const fails = [];
      const rows = [];
      const f = CIUI.fmt;
      for (const s of CIInforme.orderStructures(res.structures)) {
        const g = res.gamma_struct[s.name] || {}, mt = res.dvh_tps[s.name] || {}, mc = res.dvh_calc[s.name] || {};
        const n = g.n || 0;
        let estado, tag;
        if (n >= cfg.min_points_structure) {
          const passed = g.pass_pct >= thr;
          [estado, tag] = passed ? ["Cumple", "pass"] : ["No cumple", "fail"];
          if (!passed && fails0.indexOf(s.name) >= 0) fails.push(s.name);
          else if (!passed) estado = "No cumple (no cuenta)";
        } else [estado, tag] = ["Sin puntos", "na"];
        const dd = k => {
          const a = mt[k], b = mc[k];
          if (a === undefined || b === undefined || a === null || b === null || !isFinite(a) || a <= 0) return "–";
          const v = (b - a) / a * 100;
          return (v >= 0 ? "+" : "") + M.fmtF(v, 1);
        };
        rows.push({ est: s.name, tipo: s.type, vol: f(mt.volume_cc === undefined ? 0 : mt.volume_cc, 1), n, pass: f(g.pass_pct, 1),
                    gmean: f(g.mean), gp95: f(g.p95), gmax: f(g.max), estado, dmt: f(mt.Dmean, 3), dmc: f(mc.Dmean, 3),
                    ddm: dd("Dmean"), dd95: dd("D95"), dd2: dd("D2"), ddmax: dd("Dmax_0.03cc"), tag });
      }
      this.structTable.setRows(rows);
      let txt = `Gamma ${M.fmtG(gset.dose_pct)}%/${M.fmtG(gset.dta_mm)} mm ${gset.local ? "local" : "global"}, umbral ${M.fmtG(gset.threshold_pct)}%: ` +
        `${f(st.pass_pct, 1)}% de ${st.n} puntos con γ ≤ 1 (aprobado si ≥ ${M.fmtG(thr)}% en el External y en cada estructura)\n` +
        `γ medio ${f(st.mean)} · γ p95 ${f(st.p95)} · γ máx. ${f(st.max)} · normalización ${M.fmtF(res.gamma.norm_gy, 3)} Gy\n`;
      txt += isoTxt.join("\n");
      if (fails.length) txt += "\nNo cumple porque estas estructuras quedan por debajo del umbral: " + fails.join(", ");
      this.summaryLbl.textContent = txt;
      this.warnBox.style.display = "";
      this.warnBox.textContent = res.warnings.length ? "Avisos:\n" + res.warnings.map(w => `• ${w}`).join("\n") : "Sin avisos.";
      this.openRepBtn.disabled = false; this.openDirBtn.disabled = false;
      this.viewer.setResult(res);
      this.dvh.setResult(res);
      this.subtabs.show(0);
    }
  }
  return VerifyTab;
})();
