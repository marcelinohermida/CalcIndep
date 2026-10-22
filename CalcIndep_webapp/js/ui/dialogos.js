/* CalcIndep web · diálogos: densidades por estructura, curvas CSV, biblioteca, resultados, exportar/importar, registro. */
var CIDialogos = (function () {
  "use strict";
  const { el } = CIUI;

  // Densidades por estructura (OverridesDialog)
  async function overrides(structures, current) {
    const G = v => CIApp.M.fmtG(v);
    const t = new CIUI.Table([{ key: "est", title: "Estructura" }, { key: "tipo", title: "Tipo" },
                              { key: "rs", title: "RTSTRUCT (RED)", align: "right" },
                              { key: "hu", title: "HU", align: "right", editable: true }, { key: "red", title: "RED", align: "right", editable: true }],
                             { height: "50vh", onEdit: (row, col, nv) => {
                               nv = nv.trim();
                               if (nv === "") return true;
                               try { CIUI.parseNum(nv, col.toUpperCase()); } catch (e) { CIUI.error(e.message, "Valor no válido"); return false; }
                               row[col === "hu" ? "red" : "hu"] = "";
                               return true;
                             } });
    t.setRows(structures.map(s => {
      const c = current[s.name] || {};
      return { est: s.name, tipo: s.type, rs: s.rel_elec_density === null || s.rel_elec_density === undefined ? "" : CIApp.M.fmtF(s.rel_elec_density, 3),
               hu: "hu" in c ? G(c.hu) : "", red: "red" in c ? G(c.red) : "" };
    }));
    const body = el("div", null, el("div", { class: "muted small", style: { marginBottom: "8px" } },
      "Escriba un valor en HU o en densidad electrónica relativa (RED) para forzar la densidad de una estructura (por ejemplo, la " +
      "mesa o el bolus). Deje ambas columnas vacías para usar el CT. Doble clic en una celda para editarla. La columna «RTSTRUCT» " +
      "muestra la densidad asignada en Eclipse, que se aplica si no se indica otra aquí."), t.el);
    let out = null;
    const r = await CIUI.modal("Densidades por estructura", body, [
      { label: "Borrar todo", left: true, value: "clear" }, { label: "Cancelar", value: false },
      { label: "Aceptar", primary: true, value: true, validate: () => {
        out = {};
        for (const row of t.rows) {
          const hu = String(row.hu).trim(), red = String(row.red).trim();
          if (hu) out[row.est] = { hu: CIUI.parseNum(hu, "HU") };
          else if (red) out[row.est] = { red: CIUI.parseNum(red, "RED", 0, 10) };
        }
        return true;
      } }], { wide: true, cancelValue: false });
    if (r === "clear") { return overrides(structures, {}); }
    return r ? out : null;
  }

  // Metadatos de curvas en CSV (CsvCurveDialog)
  async function csvCurves(names) {
    const f = new CIUI.Form();
    const kind = f.row("Tipo", CIUI.select(["PDD", "Perfil"], "PDD", 8));
    const fx = f.row("Campo X", CIUI.input("100", 7), "mm");
    const fy = f.row("Campo Y", CIUI.input("100", 7), "mm");
    const ssd = f.row("DFS", CIUI.input("1000", 7), "mm");
    const depth = f.row("Profundidad (perfiles)", CIUI.input("100", 7), "mm");
    const axis = f.row("Eje (perfiles)", CIUI.select(["X", "Y", "D"], "X", 5), null, "X: crossline, Y: inline, D: diagonal.");
    const units = f.row("Unidades de posición", CIUI.select(["mm", "cm"], "mm", 5));
    const body = el("div", null, el("div", null, `${names.length} fichero(s): ` + names.slice(0, 4).join(", ") + (names.length > 4 ? "…" : "")),
      el("div", { class: "muted small", style: { margin: "4px 0 8px" } }, "Dos columnas: profundidad (PDD) o posición (perfil) y valor. Los datos " +
        "indicados aquí se aplican a todos los ficheros seleccionados."), f.p);
    let items = null;
    const ok = await CIUI.modal("Curvas en CSV", body, [{ label: "Cancelar", value: false }, { label: "Añadir", primary: true, value: true, validate: () => {
      const P = CIUI.parseNum;
      const vx = P(fx.value, "Campo X", 1), vy = P(fy.value, "Campo Y", 1), vs = P(ssd.value, "DFS", 100), vd = P(depth.value, "Profundidad", 0);
      const k = kind.value === "PDD" ? "pdd" : "profile";
      items = names.map(() => {
        const d = { kind: k, field_x_mm: vx, field_y_mm: vy, ssd_mm: vs, units: units.value };
        if (k === "profile") { d.depth_mm = vd; d.axis = axis.value; }
        return d;
      });
      return true;
    } }], { cancelValue: false });
    return ok ? items : null;
  }

  // Ficheros de la biblioteca
  async function biblioteca() {
    const lib = CIApp.lib;
    const files = await lib.allFiles();
    const t = new CIUI.Table([{ key: "p", title: "Fichero" }, { key: "acc", title: "" }], { height: "55vh" });
    t.setRows(files.map(p => ({ p, acc: el("span", null,
      el("button", { class: "small", onclick: async () => CIUI.download(p.split("/").pop(), await lib.store.read(p)) }, "Descargar"),
      /\.html?$/i.test(p) ? el("button", { class: "small", onclick: async () => CIUI.openBlob(await lib.store.read(p), "text/html") }, "Abrir") : null) })));
    await CIUI.modal("Ficheros de la biblioteca", el("div", null, el("div", { class: "muted small" }, `Biblioteca: ${lib.describe()}`), t.el),
                     [{ label: "Cerrar", primary: true, value: true }], { wide: true, cancelValue: true });
  }

  // Resultados guardados
  async function resultados(select) {
    const lib = CIApp.lib;
    const list = await lib.listResults();
    const box = el("div", { class: "results" });
    const head = el("div", { class: "muted small" }, `Resultados en: ${lib.describeResults()}`);
    if (!list.length) box.appendChild(el("div", { class: "muted" }, "No hay resultados guardados."));
    for (const r of list) {
      const d = el("details", { class: "resdir" });
      if (r.name === select) d.open = true;
      d.appendChild(el("summary", null, r.name));
      for (const f of r.files) {
        d.appendChild(el("div", { class: "resfile" }, el("span", null, f),
          el("button", { class: "small", onclick: async () => CIUI.download(f, await lib.readResult(r.name, f)) }, "Descargar"),
          /\.html?$/i.test(f) ? el("button", { class: "small", onclick: async () => CIUI.openBlob(await lib.readResult(r.name, f), "text/html") }, "Abrir") : null));
      }
      d.appendChild(el("div", { class: "row" },
        el("button", { class: "small", onclick: async () => {
          const ents = [];
          for (const f of r.files) ents.push({ path: `${r.name}/${f}`, data: await lib.readResult(r.name, f) });
          CIUI.download(`${r.name}.zip`, await CIUI.zip(ents));
        } }, "Descargar todo (ZIP)"),
        el("button", { class: "small danger", onclick: async () => {
          if (!(await CIUI.confirm(`¿Eliminar los resultados «${r.name}»?`, "Eliminar"))) return;
          await lib.removeResult(r.name);
          d.remove();
        } }, "Eliminar")));
      box.appendChild(d);
    }
    await CIUI.modal("Resultados guardados", el("div", null, head, box), [{ label: "Cerrar", primary: true, value: true }],
                     { wide: true, cancelValue: true });
  }

  async function exportarBiblioteca() {
    const lib = CIApp.lib;
    const ents = [];
    for (const p of await lib.allFiles()) ents.push({ path: `calcindep/${p}`, data: await lib.store.read(p) });
    const d = new Date();
    CIUI.download(`biblioteca_calcindep_${CIInforme.stamp(d, "_").slice(0, 8)}.zip`, await CIUI.zip(ents));
  }
  async function importarBiblioteca() {
    const fs = await CIUI.pickFiles(".zip", false);
    if (!fs.length) return;
    let ents;
    try { ents = await CIUI.unzip(fs[0]); } catch (e) { CIUI.error(e.message, "Importar"); return; }
    const ok = ["modelos/", "curvas_hu/", "comisionado/"];
    let n = 0, skipped = 0;
    const exists = [];
    for (const e of ents) {
      let p = e.path.replace(/\\/g, "/");
      const i = ok.map(o => p.indexOf(o)).filter(v => v >= 0).sort((a, b) => a - b)[0];
      if (i === undefined) { skipped++; continue; }
      p = p.slice(i);
      if (await CIApp.lib.store.exists(p)) exists.push(p);
      e.dest = p;
    }
    if (exists.length && !(await CIUI.confirm(`${exists.length} ficheros ya existen en la biblioteca (por ejemplo ${exists[0]}). ¿Sustituirlos?`, "Importar"))) return;
    for (const e of ents) if (e.dest) { await CIApp.lib.store.write(e.dest, e.data); n++; }
    await CIApp.onLibraryChanged();
    CIUI.info(`${n} ficheros importados${skipped ? `; ${skipped} fuera de modelos/, curvas_hu/ o comisionado/ no se han importado` : ""}.`, "Importar");
  }

  async function ajustesRegistro() {
    const log = await CIAlmacen.readLog();
    const txt = CIApp.settings.toJSON();
    const body = el("div", null, el("h4", null, "Ajustes (ajustes.json)"), el("pre", { class: "code" }, txt),
                    el("h4", null, "Registro de errores"), el("pre", { class: "code" }, log.length ? log.join("\n") : "Sin errores registrados."));
    const r = await CIUI.modal("Ajustes y registro", body, [
      { label: "Descargar ajustes", left: true, value: "a" }, { label: "Descargar registro", left: true, value: "r" },
      { label: "Cerrar", primary: true, value: true }], { wide: true, cancelValue: true });
    if (r === "a") CIUI.download("ajustes.json", txt, "application/json");
    if (r === "r") CIUI.download("calcindep_registro.txt", log.join("\n"), "text/plain");
  }
  return { overrides, csvCurves, biblioteca, resultados, exportarBiblioteca, importarBiblioteca, ajustesRegistro };
})();
