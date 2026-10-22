# CalcIndep webapp · independent dose calculation in the browser

[Español](README.md) · **English**

Web version 1.0 of CalcIndep. Independent dose calculation for external-beam
photon radiotherapy: it imports the plan from the treatment planning system
(TPS) in DICOM format (CT, RTSTRUCT, RTPLAN and RTDOSE), recalculates the dose
with a collapsed cone algorithm with heterogeneity correction, and compares
both distributions structure by structure with the gamma index.

It is the same tool as the Python desktop version (same algorithms and same
results), running in the browser. Nothing needs to be installed and the data
never leave the computer: all calculations run locally, with no server. The
user interface and the manual are in Spanish.

> In-house tool, not certified as a medical device. Before use, the
> beam model of each machine and energy must be commissioned, the HU to
> electron density curve of the CT scanner must be loaded.

## How to open it

1. Download the repository (**Code → Download ZIP**, or `git clone`) and
   extract it on the computer or on a network folder. The `js`, `css` and
   `manual` folders must be next to `CalcIndep.html`.
2. Double-click `CalcIndep.html` (or drag it into a browser window).
3. The manual opens with the F1 key or from `manual/manual.html`.

## Browsers

- Windows 10/11: up-to-date Chrome or Edge (recommended). They use the GPU if
  the graphics card passes the accuracy check (WebGPU). Firefox also supports
  WebGPU, but in the tests it was slower than the CPU, so in Firefox the
  program calculates on the CPU.
- Windows 7: Chrome 109 or Firefox 115 ESR. Calculations run on the CPU.
- Firefox: the library is stored in the browser (a folder cannot be chosen).
  Use Archivo → Exportar la biblioteca (File → Export library, ZIP) for
  backups.

## Where data are stored

By default, in the browser storage of each computer. In Chrome or Edge a
folder on the local disk or on the network can be chosen (Ajustes / Settings
tab), compatible with the `Documents\calcindep` folder of the desktop version.

Beam models (JSON), HU curves (CSV) and commissioning configurations from the
desktop version can be used without changes.

## Checking the program on a new computer

The `test_synthetic_plans` folder contains two synthetic plans (3D and VMAT;
they are not patients) with the expected results, calculated with the
desktop version. The instructions are in `test_synthetic_plans/README.txt`
(English) and `test_synthetic_plans/LEEME.txt` (Spanish). Both cases use the
generic 6X model included with the program and the curve `curva_ejemplo.csv`:

1. **caso_3D_Millennium120** (4 static fields): isotropic 3 mm voxels, gamma
   3%/2 mm local, 10% threshold, normalization to maximum, reference
   "Cálculo independiente" (independent calculation), pass rate 95%.
   Expected result: CUMPLE (pass), 99.9% of 157940 points with γ ≤ 1,
   mean γ 0.15, γ p95 0.32, max γ 1.60.
2. **caso_VMAT_Millennium120** (2 arcs): generic 6X model for both arcs,
   grid of the TPS dose, gamma 3%/3 mm global, 10% threshold, normalization
   to maximum, reference "Dosis del TPS" (TPS dose), pass rate 95%.
   Expected result: CUMPLE (pass), 100.0% of 182970 points with γ ≤ 1,
   mean γ 0.01, γ p95 0.02, max γ 0.03. The "TPS" dose of this case was
   calculated with the same model, so any calculation difference would show.

With the GPU, values may differ in the last decimal digit (the GPU calculates
in single precision); the percentage of passing points must be the same.

## Structure

| File or folder | Contents |
|---|---|
| `CalcIndep.html` | Main page: checks browser compatibility and loads the scripts |
| `js/datos.js` | EDKnrc kernels, generic 6X model and example HU curves |
| `js/motor/m00…m13` | Calculation engine translated step by step from Python: numerics, physics, geometry, kernels, plan, fluence, TERMA, collapsed cone, engine, DICOM, gamma, verification, GPU (WebGPU) and commissioning |
| `js/hilos.js` | Web Workers: one coordinator and one sub-worker per core, connected through MessageChannel |
| `js/ui/` | User interface: tabs, viewer, DVH, HTML reports, library and dialogs |
| `css/` | Interface styles |
| `manual/` | User manual (F1) |
| `test_synthetic_plans/` | Synthetic test plans |
| `LICENSE`, `THIRD_PARTY_NOTICES.txt` | License of the program and of third-party components |

Context data are sent once to each sub-worker and released at the end of each
calculation (and, during commissioning, after each phantom); there is also a
512 MB limit. The application uses no external libraries and makes no network
connections.

## Compatibility

- Chrome/Edge 109+ and Firefox 115+ (Windows 7: Chrome 109 and Firefox 115
  ESR). All code passes an ES2021 syntax check.
- Library in IndexedDB (all browsers) or in a folder through the File System
  Access API (Chrome/Edge), with the same structure as `Documents\calcindep`.
- GPU: WebGPU (Chrome/Edge 113+ on Windows 10/11). Same rule as the OpenCL
  desktop version: difference < 0.01% of the maximum dose in the thorax
  phantom, and 1.2 times faster in automatic mode.
- Recent Firefox versions also support WebGPU on Windows, but on the test
  laptop (Intel gen-9) the check gave 0.6 times the CPU speed, against 11.5
  times in Chrome with the same GPU. In Firefox, automatic mode calculates on
  the CPU. Firefox does not report the GPU model (it appears as
  "GPU WebGPU"). Recommendation: Chrome or Edge to use the GPU.

## Checks against the desktop version (2026-10-19)

| Test | Result compared with Python |
|---|---|
| Fields in water (10×10, 30×30 with kernel tilt, 5×5 at SSD 90) | max. relative difference 2.6e-9 inside the field |
| Calibration, generic 6X (2.5 mm) | 38.15194049 vs 38.15194050 cGy/unit |
| 3D, 3 mm grid, local gamma, reference = calculation (interface) | dose difference 1.1e-4 % of Dmax; gamma 99.899 %, identical |
| IMRT with forced densities and Somatom curve | dose difference 1.1e-7 %; gamma 100 %, identical |
| VMAT Millennium 120, commissioned model with kernel tilt and quadratic softening (interface) | dose difference 2.7e-8 %; identical gamma; no point changes side; RTDOSE and resumen.json identical |
| Synthetic commissioning, 5 mm (interface) | same parameters (spectrum with relative difference ≤ 1e-5 in the main weights); identical validation gamma for the 15 curves; identical output factors |
| WebGPU, SwiftShader (Linux) | difference with CPU 0.0001 % of Dmax; 3D case on GPU: identical gamma |
| WebGPU, Intel gen-9 (Windows, Chromium 152) | difference with CPU 0.00014 % of Dmax; 0.34 s vs 3.4 s on one CPU thread |
| Superposition on a clinical grid (136×96×80, 2.5 mm), same laptop | CPU 4 threads 4.6 s, GPU 1.0 s |
| GPU check in the application, same laptop | Chrome: 11.5 times the CPU; Firefox: 0.6 times |
| Share of superposition in total time (1 thread) | 3D 73 %, IMRT 84 %, VMAT 73 % (TERMA 20 %) |

Not tested directly: Chrome 109 on Windows 7. The code uses no features newer
than that version.

The calculation method, the physics tests and the known limitations are those
of the desktop version and are described in its README.

## License

CalcIndep is distributed under the MIT license (`LICENSE`). The EDKnrc
kernels (conehead repository), the numerical functions translated from SciPy
and NumPy, the Matplotlib and ColorBrewer color maps, and the NIST XCOM
attenuation coefficients keep their own terms, which are listed in
`THIRD_PARTY_NOTICES.txt`.
