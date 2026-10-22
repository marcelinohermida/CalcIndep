/* CalcIndep web · ventana principal (gui/app.py). */
var CIApp = (function () {
  "use strict";
  const { el } = CIUI;
  const M = {};
  for (const f of CI_MOTOR_MODULOS) f(M);
  M.initDatos(CI_DATOS);
  const TITLE = `CalcIndep ${M.VERSION} · Cálculo independiente de dosis`;

  const app = {
    M, settings: null, lib: null, hilos: null, busy: 0, gpuRegistry: {}, tabs: {},
    status(msg) { app.statusEl.textContent = msg; },
    setBusy(b) { app.busy = Math.max(0, app.busy + (b ? 1 : -1)); },
    nThreads() {
      const n = navigator.hardwareConcurrency || 2;
      return app.settings.threads ? Math.max(1, Math.min(app.settings.threads, 64)) : n;
    },
    // (Re)crea los hilos de cálculo
    async startThreads() {
      if (app.hilos) app.hilos.terminate();
      app.hilos = new CIHilos.Cliente(app.nThreads(), {
        gpuMode: app.settings.gpu_mode, registry: app.gpuRegistry,
        onRegistry: reg => { app.gpuRegistry = reg; CIAlmacen.kvSet("gpu", reg).catch(() => {}); },
      });
      await app.hilos.ready;
    },
    async onLibraryChanged() {
      for (const t of [app.tabs.verify, app.tabs.models, app.tabs.hu]) if (t) await t.refreshLibrary();
    },
    showModel(fname) {
      app.tabs.models.current = fname;
      app.tabs.models.refreshLibrary();
      app.selectTab("models");
    },
  };

  function buildShell() {
    document.title = TITLE;
    const root = document.getElementById("app");
    root.textContent = "";
    // menú
    const menubar = el("div", { class: "menubar" });
    const brand = el("div", { class: "brand" }, el("b", null, "CalcIndep"), el("span", null, " · cálculo independiente de dosis"));
    const mArch = el("button", { class: "menu" }, "Archivo");
    const mAyuda = el("button", { class: "menu" }, "Ayuda");
    mArch.addEventListener("click", e => {
      const r = mArch.getBoundingClientRect();
      CIUI.popupMenu(r.left, r.bottom, [
        { label: "Ficheros de la biblioteca…", action: () => CIDialogos.biblioteca() },
        { label: "Resultados guardados…", action: () => CIDialogos.resultados() },
        "-",
        { label: "Exportar la biblioteca (ZIP)…", action: () => CIDialogos.exportarBiblioteca() },
        { label: "Importar una biblioteca (ZIP)…", action: () => CIDialogos.importarBiblioteca() },
      ]);
    });
    mAyuda.addEventListener("click", e => {
      const r = mAyuda.getBoundingClientRect();
      CIUI.popupMenu(r.left, r.bottom, [
        { label: "Manual de usuario", accel: "F1", action: () => openManual() },
        { label: "Ajustes y registro de errores…", action: () => CIDialogos.ajustesRegistro() },
        "-",
        { label: "Acerca de CalcIndep", action: () => about() },
      ]);
    });
    menubar.append(brand, mArch, mAyuda);
    // pestañas
    const tabbar = el("div", { class: "tabbar" });
    const main = el("div", { class: "tabmain" });
    const specs = [["verify", "Verificar plan"], ["models", "Modelos de haz"], ["commission", "Comisionado"],
                   ["hu", "Curvas HU–densidad"], ["settings", "Ajustes"]];
    app.tabBtns = {};
    app.tabPanels = {};
    for (const [k, t] of specs) {
      const b = el("button", { class: "tab", onclick: () => app.selectTab(k) }, t);
      tabbar.appendChild(b);
      app.tabBtns[k] = b;
      const p = el("div", { class: "tabpanel", style: { display: "none" } });
      main.appendChild(p);
      app.tabPanels[k] = p;
    }
    const sb = el("div", { class: "statusbar" });
    app.statusEl = el("span", { class: "st" }, "");
    sb.append(app.statusEl, el("span", { class: "disc" }, "Herramienta de verificación de desarrollo propio, sin certificación como producto sanitario."));
    app.banner = el("div", { class: "banner", style: { display: "none" } });
    root.append(menubar, app.banner, tabbar, main, sb);
  }
  app.selectTab = function (k) {
    for (const [key, b] of Object.entries(app.tabBtns)) {
      b.classList.toggle("on", key === k);
      app.tabPanels[key].style.display = key === k ? "" : "none";
    }
    if (app.tabs[k] && app.tabs[k].onShow) app.tabs[k].onShow();
  };

  function openManual() {
    const w = window.open("manual/manual.html", "_blank");
    if (!w) CIUI.info("El navegador ha bloqueado la ventana. Abra el fichero manual/manual.html de la carpeta del programa.");
  }
  function about() {
    CIUI.info(`CalcIndep ${M.VERSION} (versión web ${M.VERSION_WEB})\n\n` +
      "Cálculo independiente de dosis para radioterapia externa con fotones: convolución-superposición collapsed cone " +
      "con kernels EGSnrc y comparación gamma (Low et al. 1998) por estructura.\n\n" +
      "Versión para navegador: los mismos algoritmos que la versión de escritorio, ejecutados en JavaScript " +
      "(y WebGPU si la tarjeta gráfica lo permite). No hay que instalar nada y los datos no salen del ordenador.\n\n" +
      "Herramienta de desarrollo propio. No es un producto sanitario certificado: valide el sistema antes de usarlo en clínica.\n\n" +
      "Manual: menú Ayuda o tecla F1.", "Acerca de CalcIndep");
  }

  async function start() {
    buildShell();
    app.status("Cargando…");
    try { app.settings = await CIAlmacen.Settings.load(); }
    catch (e) { app.settings = new CIAlmacen.Settings(); }
    try { app.gpuRegistry = (await CIAlmacen.kvGet("gpu")) || {}; } catch (e) { app.gpuRegistry = {}; }
    app.lib = new CIAlmacen.Library(app.settings);
    let pending = null;
    try { pending = await app.lib.open(false); }
    catch (e) {
      await CIUI.warn(`No se puede usar la biblioteca: ${e.message}\nSe usará el almacenamiento del navegador.`, "Biblioteca");
      app.settings.library_mode = "navegador";
      pending = await app.lib.open(false);
    }
    if (pending) showPermissionBanner(pending);
    else if (!(await CIAlmacen.storageOk()) && app.lib.store.kind === "navegador") {
      app.banner.textContent = "";
      app.banner.style.display = "";
      app.banner.append(el("span", null, "Este navegador no permite guardar datos de forma permanente para esta página (por ejemplo, en una " +
        "ventana privada). Los modelos, curvas y resultados se perderán al cerrar: descargue los resultados y exporte la biblioteca " +
        "(menú Archivo) antes de salir."));
    }
    app.tabs.verify = new CITabs.VerifyTab(app.tabPanels.verify);
    app.tabs.models = new CITabs.ModelsTab(app.tabPanels.models);
    app.tabs.commission = new CITabs.CommissionTab(app.tabPanels.commission);
    app.tabs.hu = new CITabs.HUTab(app.tabPanels.hu);
    app.tabs.settings = new CITabs.SettingsTab(app.tabPanels.settings);
    app.selectTab("verify");
    await app.onLibraryChanged();
    document.addEventListener("keydown", e => { if (e.key === "F1") { e.preventDefault(); openManual(); } });
    window.addEventListener("beforeunload", e => { if (app.busy) { e.preventDefault(); e.returnValue = ""; } });
    // motor de cálculo
    app.status("Preparando el motor de cálculo…");
    try {
      await app.startThreads();
      await app.hilos.call("warmup", {});
      const r = await app.hilos.call("backendInfo", { mode: app.settings.gpu_mode }, { onProgress: m => app.status(m) });
      app.status(`Motor de cálculo listo · superposición en ${r.inUse}`);
      app.tabs.settings.refreshGpu(r.inUse);
    } catch (e) {
      console.error(e);
      app.status(`Aviso: no se ha podido preparar el motor de cálculo (${e.message})`);
      CIAlmacen.logError(`Arranque del motor: ${e.message}`);
    }
  }
  function showPermissionBanner(which) {
    const b = app.banner;
    b.textContent = "";
    b.style.display = "";
    b.append(el("span", null, which === "biblioteca" ?
      "El navegador necesita su permiso para usar la carpeta de la biblioteca." :
      "El navegador necesita su permiso para usar la carpeta de resultados."),
      el("button", { class: "primary", onclick: async () => {
        try {
          const p = await app.lib.open(true);
          if (!p) { b.style.display = "none"; await app.onLibraryChanged(); app.tabs.settings.refresh(); app.status(`Biblioteca: ${app.lib.describe()}`); }
        } catch (e) { CIUI.error(e.message); }
      } }, "Dar permiso"));
  }
  app.showPermissionBanner = showPermissionBanner;
  window.addEventListener("error", e => { CIAlmacen.logError(`${e.message} (${e.filename}:${e.lineno})`); });
  window.addEventListener("unhandledrejection", e => { CIAlmacen.logError(`Promesa: ${e.reason && (e.reason.stack || e.reason.message) || e.reason}`); });
  app.start = start;
  return app;
})();
