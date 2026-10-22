/* CalcIndep web · pestaña «Ajustes» (gui/settings_tab.py). */
var CITabs = CITabs || {};
(function () {
  "use strict";
  const { el } = CIUI;
  const GPU_AUTO = "Automático (GPU comprobada y más rápida)", GPU_CPU = "Solo CPU";
  class SettingsTab {
    constructor(panel) {
      panel.classList.add("pad", "scrolly");
      const s = CIApp.settings, G = v => CIApp.M.fmtG(v);
      const cols = el("div", { class: "cols" });
      const body = el("div", { class: "col" }), right = el("div", { class: "col" });
      cols.append(body, right);
      panel.appendChild(cols);
      // carpetas
      let sec = CIUI.section("Biblioteca y resultados");
      let f = new CIUI.Form(sec);
      const nm = "lib" + Math.random();
      this.libBrowser = el("input", { type: "radio", name: nm });
      this.libFolder = el("input", { type: "radio", name: nm });
      this.libLbl = el("span", { class: "folder" });
      this.libBtn = el("button", { onclick: () => this.chooseLib() }, "Elegir carpeta…");
      f.full(el("div", null,
        el("label", { class: "radio block" }, this.libBrowser, " En el navegador (este ordenador y este navegador)"),
        el("label", { class: "radio block" }, this.libFolder, " En una carpeta del disco o de la red: ", this.libLbl, " ", this.libBtn),
        el("div", { class: "muted small" }, "La biblioteca contiene los modelos de haz, las curvas HU–densidad y los informes de comisionado. " +
          "En una carpeta compartida la puede usar todo el servicio, y es compatible con la carpeta «calcindep» de la versión de " +
          "escritorio (Documentos\\calcindep). Elegir carpetas requiere Chrome o Edge; en Firefox se usa el almacenamiento del navegador " +
          "y la biblioteca se puede exportar e importar en ZIP (menú Archivo).")));
      const nm2 = "res" + Math.random();
      this.resLib = el("input", { type: "radio", name: nm2 });
      this.resFolder = el("input", { type: "radio", name: nm2 });
      this.resLbl = el("span", { class: "folder" });
      this.resBtn = el("button", { onclick: () => this.chooseRes() }, "Elegir carpeta…");
      f.full(el("div", { style: { marginTop: "8px" } }, el("b", null, "Resultados"),
        el("label", { class: "radio block" }, this.resLib, " Subcarpeta «resultados» de la biblioteca"),
        el("label", { class: "radio block" }, this.resFolder, " Otra carpeta: ", this.resLbl, " ", this.resBtn)));
      if (!CIAlmacen.fsaOk()) { [this.libFolder, this.libBtn, this.resFolder, this.resBtn].forEach(x => { x.disabled = true; }); }
      body.appendChild(sec);
      // cálculo
      sec = CIUI.section("Cálculo");
      f = new CIUI.Form(sec);
      const ncpu = navigator.hardwareConcurrency || 2;
      this.vThreads = f.row("Hilos de cálculo", CIUI.input(String(s.threads || ncpu), 5, { type: "number", min: "1", max: String(Math.max(ncpu, 1)) }),
                            `de ${ncpu}`, "Use menos hilos si quiere seguir trabajando con el ordenador durante el cálculo.");
      this.vFlu = f.row("Resolución del mapa de fluencia", CIUI.input(G(s.fluence_res_mm), 6), "mm");
      this.vGstep = f.row("Paso máximo de gantry en arcos", CIUI.input(G(s.max_gantry_step_deg), 6), "grados");
      this.vSector = f.row("Sector de superposición en arcos", CIUI.input(G(s.sector_deg), 6), "grados",
        "Las incidencias de un arco se agrupan en sectores para la superposición. Con 10° la dosis difiere menos del 0.2% de la " +
        "obtenida con 3°, y el cálculo es unas tres veces más rápido.");
      this.vMargin = f.row("Margen alrededor del External", CIUI.input(G(s.margin_mm), 6), "mm");
      this.vTrace = f.full(CIUI.checkbox("Calcular la atenuación del TERMA a través de todo el CT", s.trace_full_ct));
      body.appendChild(sec);
      body.appendChild(el("div", { class: "row" }, el("button", { class: "primary", onclick: () => this.save() }, "Guardar ajustes")));
      // GPU
      sec = CIUI.section("Superposición en GPU");
      f = new CIUI.Form(sec);
      this.gpuSel = f.row("Dispositivo", CIUI.select([["auto", GPU_AUTO], ["cpu", GPU_CPU]], "auto", 22), null,
        "Cada ordenador decide según su GPU. La primera vez que se usa una GPU, y si cambia el driver o el navegador, se calcula un " +
        "maniquí con la GPU y con la CPU: la GPU se acepta si la diferencia es menor del 0.01% de la dosis máxima. En automático, " +
        "solo si además es más rápida. Si no hay GPU (o el navegador no tiene WebGPU) o falla, se calcula en la CPU. Se aplica al " +
        "pulsar «Guardar ajustes».");
      this.gpuLbl = f.full(el("div", { class: "small pre" }, "Buscando GPU…"));
      this.gpuBtn = f.full(el("button", { onclick: () => this.checkGpu() }, "Comprobar GPU de nuevo"));
      right.appendChild(sec);
      sec = CIUI.section("Información");
      this.infoLbl = el("div", { class: "small muted pre" });
      sec.append(this.infoLbl, el("div", { class: "row" }, el("button", { onclick: () => CIDialogos.ajustesRegistro() }, "Ver ajustes y registro")));
      right.appendChild(sec);
      this.refresh();
    }
    refresh() {
      const s = CIApp.settings;
      (s.library_mode === "carpeta" ? this.libFolder : this.libBrowser).checked = true;
      (s.results_mode === "carpeta" ? this.resFolder : this.resLib).checked = true;
      this.libLbl.textContent = s.library_name ? `«${s.library_name}»` : "(ninguna)";
      this.resLbl.textContent = s.results_name ? `«${s.results_name}»` : "(ninguna)";
      this.gpuSel.value = s.gpu_mode === "auto" || s.gpu_mode === "cpu" ? s.gpu_mode : (Array.from(this.gpuSel.options).some(o => o.value === s.gpu_mode) ? s.gpu_mode : "auto");
      this.infoLbl.textContent = `Versión: CalcIndep ${CIApp.M.VERSION_WEB}\nBiblioteca: ${CIApp.lib.describe()}\n` +
        `Resultados: ${CIApp.lib.describeResults()}\nAjustes: almacenamiento del navegador\n` +
        `Kernels: EDKnrc (conehead, S. Peet), incluidos en js/datos.js\nNavegador: ${navigator.userAgent}\n` +
        `WebGPU: ${navigator.gpu ? "disponible" : "no disponible"} · núcleos: ${navigator.hardwareConcurrency || "?"}`;
    }
    async chooseLib() {
      try {
        const h = await CIAlmacen.chooseFolder("biblioteca");
        CIApp.settings.library_name = h.name;
        this.libFolder.checked = true;
        this.libLbl.textContent = `«${h.name}»`;
      } catch (e) { if (e.name !== "AbortError") CIUI.error(e.message); }
    }
    async chooseRes() {
      try {
        const h = await CIAlmacen.chooseFolder("resultados");
        CIApp.settings.results_name = h.name;
        this.resFolder.checked = true;
        this.resLbl.textContent = `«${h.name}»`;
      } catch (e) { if (e.name !== "AbortError") CIUI.error(e.message); }
    }
    async refreshGpu(inUse) {
      try {
        const r = await CIApp.hilos.call("gpuStatus", {});
        const cur = this.gpuSel.value;
        this.gpuSel.textContent = "";
        for (const [v, t] of [["auto", GPU_AUTO], ["cpu", GPU_CPU]].concat(r.devices.map(d => [d.name, `GPU: ${d.name}`])))
          this.gpuSel.appendChild(el("option", { value: v }, t));
        this.gpuSel.value = Array.from(this.gpuSel.options).some(o => o.value === CIApp.settings.gpu_mode) ? CIApp.settings.gpu_mode : cur || "auto";
        let txt = r.devices.length ? r.devices.map(d => `${d.name} (WebGPU): ${d.describe}`).join("\n") : r.reason;
        if (inUse) txt += `\n\nEn uso: ${inUse}`;
        this.gpuLbl.textContent = txt;
      } catch (e) { this.gpuLbl.textContent = `No se puede consultar la GPU: ${e.message}`; }
    }
    async checkGpu() {
      this.gpuBtn.disabled = true;
      this.gpuLbl.textContent = "Comprobando la GPU frente a la CPU (unos segundos)…";
      try {
        const r = await CIApp.hilos.call("gpuCheck", { mode: this.gpuSel.value }, { onProgress: m => CIApp.status(m) });
        await this.refreshGpu(r.inUse);
        CIApp.status(`Superposición en ${r.inUse}`);
      } catch (e) { this.gpuLbl.textContent = `Error en la comprobación: ${e.message}`; }
      finally { this.gpuBtn.disabled = false; }
    }
    async save() {
      const s = CIApp.settings, P = CIUI.parseNum;
      let threads, flu, gstep, sector, margin;
      try {
        threads = Math.trunc(P(this.vThreads.value, "Hilos", 1));
        flu = P(this.vFlu.value, "Resolución de fluencia", 0.1, 2.5);
        gstep = P(this.vGstep.value, "Paso de gantry", 0.5, 10);
        sector = P(this.vSector.value, "Sector", 1, 45);
        margin = P(this.vMargin.value, "Margen", 0, 100);
      } catch (e) { CIUI.error(e.message, "Valor no válido"); return; }
      if (this.libFolder.checked && !s.library_name) { CIUI.error("Elija la carpeta de la biblioteca.", "Biblioteca"); return; }
      if (this.resFolder.checked && !s.results_name) { CIUI.error("Elija la carpeta de resultados.", "Resultados"); return; }
      const oldThreads = CIApp.nThreads(), oldGpu = s.gpu_mode;
      s.library_mode = this.libFolder.checked ? "carpeta" : "navegador";
      s.results_mode = this.resFolder.checked ? "carpeta" : "biblioteca";
      s.threads = threads >= (navigator.hardwareConcurrency || 1) ? 0 : threads;
      Object.assign(s, { fluence_res_mm: flu, max_gantry_step_deg: gstep, sector_deg: sector, margin_mm: margin,
                         trace_full_ct: this.vTrace.input.checked, gpu_mode: this.gpuSel.value });
      try {
        const pending = await CIApp.lib.open(true);
        if (pending) CIApp.showPermissionBanner(pending);
      } catch (e) { CIUI.error(`No se puede usar la carpeta: ${e.message}`, "Biblioteca"); return; }
      await s.save();
      if (CIApp.nThreads() !== oldThreads && !CIApp.busy) { await CIApp.startThreads(); }
      else if (oldGpu !== s.gpu_mode) await CIApp.hilos.call("setGpuMode", { mode: s.gpu_mode });
      await CIApp.onLibraryChanged();
      this.refresh();
      CIApp.status("Ajustes guardados");
      try {
        const r = await CIApp.hilos.call("backendInfo", { mode: s.gpu_mode }, { onProgress: m => CIApp.status(m) });
        await this.refreshGpu(r.inUse);
        CIApp.status(`Ajustes guardados · superposición en ${r.inUse}`);
      } catch (e) { /* el estado de la GPU se verá al calcular */ }
    }
  }
  CITabs.SettingsTab = SettingsTab;
})();
