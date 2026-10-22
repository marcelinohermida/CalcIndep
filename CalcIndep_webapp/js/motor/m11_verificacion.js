/* CalcIndep web · flujo completo de verificación de un plan (pipeline.py). */
CI_MOTOR_MODULOS.push(function CIMod_verificacion(M) {
  "use strict";
  M.VERSION = "1.0";
  M.VERSION_WEB = "1.0-web";

  M.CheckConfig = function (o) {
    o = o || {};
    return {
      gamma: M.GammaSettings(o.gamma), options: M.CalcOptions(o.options),
      pass_threshold_pct: o.pass_threshold_pct === undefined ? 95.0 : o.pass_threshold_pct,
      calc_spacing_mm: o.calc_spacing_mm === undefined ? null : o.calc_spacing_mm,
      fraction_factor: o.fraction_factor === undefined ? null : o.fraction_factor,
      min_points_structure: o.min_points_structure === undefined ? 10 : o.min_points_structure,
      save_rtdose: o.save_rtdose === undefined ? true : o.save_rtdose,
    };
  };

  // Remuestreo trilineal a otra rejilla (map_coordinates, modo constante)
  M.resampleTo = function (src, srcGrid, dstGrid, cval, asFloat32) {
    cval = cval === undefined ? 0.0 : cval;
    const [x, y, z] = dstGrid.axes();
    const [nz, ny, nx] = dstGrid.shape;
    const out = asFloat32 ? new Float32Array(dstGrid.size) : new Float64Array(dstGrid.size);
    const fk = Float64Array.from(z, v => (v - srcGrid.origin[2]) / srcGrid.spacing[2]);
    const fj = Float64Array.from(y, v => (v - srcGrid.origin[1]) / srcGrid.spacing[1]);
    const fi = Float64Array.from(x, v => (v - srcGrid.origin[0]) / srcGrid.spacing[0]);
    let p = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, p++)
      out[p] = M.mapCoord3(src, srcGrid.shape, fk[k], fj[j], fi[i], "constant", cval);
    return out;
  };

  const NON_ANATOMIC = ["SUPPORT", "MARKER", "REGISTRATION", "FIXATION", "CONTROL", "BOLUS", "AVOIDANCE"];
  M.NON_ANATOMIC = NON_ANATOMIC;
  M.verdict = function (res) {
    const cfg = res.config;
    const thr = cfg.pass_threshold_pct;
    const fails = [];
    for (const s of res.structures) {
      const st = res.gamma_struct[s.name] || {};
      if (NON_ANATOMIC.indexOf(s.type) >= 0 || (st.n || 0) < cfg.min_points_structure) continue;
      if (st.pass_pct < thr) fails.push(s.name);
    }
    const g = res.gamma.stats.pass_pct;
    const ok = isFinite(g) && g >= thr && !fails.length;
    return [ok, fails];
  };

  // Selección de RTDOSE: si hay dosis de plan y por haz, la de plan
  function selectRTDose(entries, plan) {
    let infos = entries.map(e => [e, M.readRTDose(e.ds)[1]]);
    const f = infos.filter(x => !x[1].referenced_plan_uid || x[1].referenced_plan_uid === plan.sop_uid);
    if (f.length) infos = f;
    const planD = infos.filter(x => x[1].summation === "PLAN" || x[1].summation === "FRACTION");
    if (planD.length) return [planD[0][0]];
    return infos.filter(x => x[1].summation === "BEAM").map(x => x[0]);
  }

  // Verificación completa.
  // inp: {ct: [Dataset], rtstruct: {ds, path}, rtplan: {ds, path}, rtdose: [{ds, path}], n_ct}
  // cfg: CheckConfig; curve: HUEDCurve o null; modelsByBeam: Map(número -> BeamModel); library: [BeamModel]
  // hooks: {progress, fraction, cancel (función que lanza Cancelled), backend, rast, edk, prepareBackend}
  M.runCheck = async function (inp, cfg, curve, modelsByBeam, library, hooks) {
    hooks = hooks || {};
    const progress = hooks.progress || (() => {});
    const t0 = Date.now();
    const warnings = [];
    const frac = f => { if (hooks.cancel) hooks.cancel(); if (hooks.fraction) hooks.fraction(Math.min(Math.max(f, 0.0), 1.0)); };
    const rast = hooks.rast || (async (s, g) => M.rasterize(s, g));
    progress("Leyendo DICOM");
    frac(0.0);
    const plan = M.readRTPlan(inp.rtplan.ds);
    const [structures, sinfo] = M.readRTStruct(inp.rtstruct.ds);
    const [ct, ctinfo] = M.readCT(inp.ct, sinfo.referenced_series_uid);
    const rtdose = selectRTDose(inp.rtdose, plan);
    const [tps, dinfo] = M.sumRTDoses(rtdose.map(e => e.ds));
    const fors = new Set([ctinfo.frame_of_reference_uid, sinfo.frame_of_reference_uid || ctinfo.frame_of_reference_uid,
                          plan.frame_of_reference_uid || ctinfo.frame_of_reference_uid]);
    if (fors.size > 1) warnings.push("Los FrameOfReferenceUID de CT, estructuras y plan no coinciden");
    if (dinfo.referenced_plan_uid && dinfo.referenced_plan_uid !== plan.sop_uid)
      warnings.push("El RTDOSE no referencia al RTPLAN cargado");
    if (!curve) {
      curve = M.HUEDCurve.fromCSV(M.DATOS_CURVA_EJEMPLO || "", "curva_ejemplo.csv");
      warnings.push("Se ha usado la curva HU-ED de ejemplo: cargue la curva de su CT");
    }
    let lib = (library || []).slice();
    const assigned = modelsByBeam || new Map();
    if (!lib.length && !assigned.size) {
      lib = [M.BeamModel.fromJSON(M.DATOS_MODELO_GENERICO)];
      warnings.push("Se ha usado el modelo de haz genérico de ejemplo");
    }
    const engine = new M.DoseEngine(new M.BeamModelLibrary(lib), cfg.options, hooks.edk, hooks.backend);
    engine.assignments = assigned;
    engine.cancel = hooks.cancel || null;
    const treat = M.DoseEngine.treatmentBeams(plan);
    const used = [];
    for (const b of treat) {
      const m = engine.modelFor(b);
      if (used.every(u => u !== m)) used.push(m);
    }
    const models = used;
    engine.checkPlan(plan);
    frac(0.04);
    const backend = engine.backend;
    if (hooks.prepareBackend) await hooks.prepareBackend(progress);
    const nWarnBackend = (backend.warnings || []).length;
    progress(`Superposición: ${backend.describe()}`);
    progress("Preparando rejillas y densidades");
    const masks = new Map();
    const rasts = await Promise.all(structures.map(s => rast(s, tps.grid)));
    structures.forEach((s, q) => masks.set(s.name, rasts[q]));
    const ext = structures.find(s => s.type === "EXTERNAL") || null;
    if (!ext) warnings.push("No hay estructura de tipo EXTERNAL: se calcula en toda la rejilla del CT");
    let base;
    if (cfg.calc_spacing_mm) {
      const sp = +cfg.calc_spacing_mm;
      const [x0, x1, y0, y1, z0, z1] = tps.grid.extent();
      const n = [Math.floor((x1 - x0) / sp) + 1, Math.floor((y1 - y0) / sp) + 1, Math.floor((z1 - z0) / sp) + 1];
      base = new M.Grid([x0, y0, z0], [sp, sp, sp], [n[2], n[1], n[0]]);
    } else base = tps.grid;
    const extMaskBase = ext ? await rast(ext, base) : null;
    const [grid, crop] = M.calcGridFrom(base, extMaskBase, cfg.options.margin_mm);
    const dens = await M.buildDensity(ct, curve, grid, structures, cfg.options, rast);
    const rho = dens.rho, cmask = dens.mask, densInfo = dens.info;
    for (const name of densInfo.missing_overrides || [])
      warnings.push(`No existe la estructura '${name}' indicada para asignar densidad`);
    let trace = null;
    if (cfg.options.trace_full_ct)
      trace = await M.buildTraceDensity(ct, curve, structures, grid.minSpacing(), cfg.options, rast);
    frac(0.10);
    for (const m of models) {
      if (m.calibration.cgy_per_unit <= 0 || Math.abs(m.calibration.grid_mm - grid.minSpacing()) > 0.6) {
        progress(`Calibrando UM del modelo '${m.name}' con rejilla de ${M.fmtF(grid.minSpacing(), 2)} mm`);
        await M.calibrate(m, grid.minSpacing(), engine);
        frac(0.10);
      }
    }
    progress("Calculando dosis");
    const totalGroups = Math.max(1, treat.reduce((s, b) => s + engine.countGroups(b), 0));
    let done = 0;
    engine.step_callback = (beam, k, n) => { if (k > 0) done += 1; frac(0.12 + 0.78 * done / totalGroups); };
    const [doseFx, beams] = await engine.computePlan(plan, rho, grid, cmask, progress, trace);
    engine.step_callback = null;
    for (const w of (backend.warnings || []).slice(nWarnBackend)) warnings.push(w);
    for (const b of beams) for (const w of b.warnings) {
      const msg = `${b.name}: ${w}`;
      if (warnings.indexOf(msg) < 0) warnings.push(msg);
    }
    let ff;
    if (cfg.fraction_factor !== null && cfg.fraction_factor !== undefined) ff = +cfg.fraction_factor;
    else ff = (dinfo.summation === "PLAN" || dinfo.summation === "BEAM") ? +plan.n_fractions : 1.0;
    const full = new Float64Array(base.size);
    const [k0, k1, j0, j1, i0, i1] = crop;
    const [, bny, bnx] = base.shape;
    const [gnz, gny, gnx] = grid.shape;
    for (let k = 0; k < gnz; k++) for (let j = 0; j < gny; j++) for (let i = 0; i < gnx; i++)
      full[((k + k0) * bny + (j + j0)) * bnx + (i + i0)] = doseFx[(k * gny + j) * gnx + i] * ff;
    const calcOnTps = base === tps.grid ? full : M.resampleTo(full, base, tps.grid);
    progress("Calculando gamma");
    frac(0.90);
    const extMaskTps = ext ? masks.get(ext.name) : null;
    let ref, ev;
    if (cfg.gamma.reference === "tps") { ref = tps.data; ev = calcOnTps; } else { ref = calcOnTps; ev = tps.data; }
    const g = hooks.gamma ? await hooks.gamma(ref, tps.grid, ev, tps.grid, cfg.gamma, extMaskTps, plan.prescription_gy)
      : M.gamma3D(ref, tps.grid, ev, tps.grid, cfg.gamma, extMaskTps, plan.prescription_gy);
    const gs = M.gammaByStructure(g, masks);
    frac(0.96);
    const vcc = tps.grid.voxelVolumeCC();
    const dvhT = {}, dvhC = {};
    for (const [n, m] of masks) { dvhT[n] = M.dvhMetrics(tps.data, m, vcc); dvhC[n] = M.dvhMetrics(calcOnTps, m, vcc); }
    const ctDisp = M.resampleTo(ct.data, ct.grid, tps.grid, -1000.0, true);
    const info = {
      tps_grid: tps.grid, calc_grid: grid, fraction_factor: ff, dose_summation: dinfo.summation,
      rtdose_files: rtdose.map(e => e.path), rtplan: inp.rtplan.path, rtstruct: inp.rtstruct.path, n_ct: inp.ct.length,
      density: densInfo, elapsed_s: (Date.now() - t0) / 1000, superposition: backend.describe(),
      models: models.map(m => ({ name: m.name, energy: m.energy, fluence_mode: m.fluence_mode, commissioned: m.commissioned,
                                 cgy_per_unit: m.calibration.cgy_per_unit })),
      patient_id: ctinfo.patient_id, patient_name: ctinfo.patient_name,
    };
    const res = { plan, tps_grid: tps.grid, tps_dose: tps.data, calc_dose: calcOnTps, ct_on_grid: ctDisp, masks,
                  structures, gamma: g, gamma_struct: gs, dvh_tps: dvhT, dvh_calc: dvhC, beams, warnings, info, curve,
                  config: cfg };
    res.summation_out = (ff !== 1.0 || dinfo.summation === "PLAN") ? "PLAN" : "FRACTION";
    res.rtdose_template = rtdose[0].ds;
    frac(1.0);
    return res;
  };

  // Ficheros de salida (RTDOSE y resumen.json)
  M.resultRTDose = function (res) {
    return M.writeRTDose(res.calc_dose, res.tps_grid, res.rtdose_template, res.plan.sop_uid, res.summation_out);
  };
  function clean(d) {
    const o = {};
    for (const k of Object.keys(d)) { const v = d[k]; o[k] = (typeof v === "number" && !isFinite(v)) ? null : v; }
    return o;
  }
  M.fechaPy = function (d) {
    d = d || new Date();
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  M.summaryJSON = function (res, when) {
    const cfg = res.config;
    const [ok, fails] = M.verdict(res);
    const porEst = {};
    for (const k of Object.keys(res.gamma_struct)) porEst[k] = clean(res.gamma_struct[k]);
    const dt = {}, dc = {};
    for (const k of Object.keys(res.dvh_tps)) dt[k] = clean(res.dvh_tps[k]);
    for (const k of Object.keys(res.dvh_calc)) dc[k] = clean(res.dvh_calc[k]);
    const opts = {};
    for (const k of M.CALC_OPTION_KEYS) opts[k] = cfg.options[k];
    const gcrit = {};
    for (const k of ["dose_pct", "dta_mm", "local", "threshold_pct", "normalization", "normalization_gy", "max_gamma",
                     "interp_fraction", "reference"]) gcrit[k] = cfg.gamma[k];
    const out = {
      fecha: M.fechaPy(when), version_calcindep: M.VERSION_WEB, resultado: ok ? "CUMPLE" : "NO CUMPLE",
      estructuras_que_no_cumplen: fails,
      paciente: { id: res.info.patient_id, nombre: res.info.patient_name },
      plan: { label: res.plan.label, uid: res.plan.sop_uid, fracciones: res.plan.n_fractions,
              prescripcion_gy: res.plan.prescription_gy },
      gamma: { criterio: gcrit, normalizacion_gy: res.gamma.norm_gy, global: clean(res.gamma.stats), por_estructura: porEst },
      umbral_aprobacion_pct: cfg.pass_threshold_pct,
      dosimetria: { tps: dt, calculo: dc },
      modelos: res.info.models,
      curva_hu_ed: { nombre: res.curve.name, tabla: res.curve.table() },
      opciones: opts,
      haces: res.beams.map(b => ({ nombre: b.name, um: b.mu, tecnica: b.technique, modelo: b.model,
                                   segundos: M.pyRound(b.seconds, 1), avisos: b.warnings })),
      avisos: res.warnings,
      ficheros: { rtplan: res.info.rtplan, rtstruct: res.info.rtstruct, rtdose: res.info.rtdose_files },
      tiempo_s: M.pyRound(res.info.elapsed_s, 1),
      superposicion: res.info.superposition || "CPU",
    };
    return M.pyJSON(out, new Set(["n", "n_voxels", "fracciones", "interp_fraction", "density_supersampling"]));
  };
});
CI_MOTOR_MODULOS.push(function CIMod_init(M) {
  "use strict";
  // Datos incluidos (CI_DATOS): kernels, modelo genérico y curva de ejemplo
  M.initDatos = function (d) {
    M.DATOS = d;
    M.DATOS_CURVA_EJEMPLO = d.curva_ejemplo;
    M.DATOS_MODELO_GENERICO = d.modelo_generico;
    M.EDK = M.loadEDK(d);
    return M;
  };
});
