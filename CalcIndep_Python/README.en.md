# CalcIndep · independent dose calculation with collapsed cone

[Español](README.md) · **English**

Version 1.0. User manual (in Spanish): `docs/Manual_CalcIndep.pdf` (from the
program, Help menu or F1 key). This document is the technical description.

CalcIndep is a Python tool to check external-beam photon radiotherapy plans.
It imports the plan from the treatment planning system (TPS) in DICOM format
(CT, RTSTRUCT, RTPLAN and RTDOSE), recalculates the dose with a collapsed cone
convolution-superposition algorithm with heterogeneity correction, and
compares both distributions structure by structure with the gamma index of
Low et al. (1998). The output is a self-contained HTML report and an RTDOSE
file with the recalculated dose.

The user interface and the manual are in Spanish. Interface labels are quoted
below in Spanish, followed by their meaning. A browser version with the same
algorithms and results, which needs no installation, is also available
(CalcIndep webapp).

> In-house tool, not certified as a medical device. Before use, the
> beam model of each machine and energy must be commissioned, the HU to
> electron density curve of the CT scanner must be loaded.

## Repository contents

| File or folder | Contents |
|---|---|
| `calcindep/` | Program source code |
| `data/` | EDKnrc kernels, generic 6X beam model and example HU–density curves |
| `docs/` | User manual in PDF and its source (`docs/fuente_manual`) |
| `examples/` | Synthetic beam data, example configurations and example reports |
| `CalcIndep.pyw` | Graphical interface launcher |
| `instalar_windows.bat` | Windows installer |
| `instalar_gpu.bat` | Optional installation of GPU superposition |
| `environment.yml`, `requirements.txt` | Required Python packages |
| `LEEME_INSTALACION.txt` | Short installation instructions (Spanish) |
| `LICENSE`, `THIRD_PARTY_NOTICES.txt` | License of the program and of third-party components |

## Modules

| Module | Purpose |
|---|---|
| `dicom_io.py` | Reading of CT, RTSTRUCT (contour rasterization), RTPLAN (control points, jaws, MLC) and RTDOSE |
| `geometry.py` | Grids and IEC 61217 transformations (gantry, collimator, couch; HFS, HFP, FFS, FFP) |
| `hu_ed.py` | CT number → relative electron density curve (editable CSV) |
| `beam_model.py` | Beam model in JSON (spectrum, radial profile, sources, parameters of each MLC, calibration) |
| `mlc.py` | MLC types (Millennium 120, HD120), identification from the leaf boundaries, tongue-and-groove band |
| `fluence.py` | Fluence at the isocenter plane for 3D-CRT, step-and-shoot, sliding window and VMAT |
| `terma.py` | Polyenergetic TERMA with divergent ray tracing |
| `ccc.py` | Collapsed cone superposition with density scaling (numba, parallel) |
| `kernels.py` | EGSnrc/EDKnrc kernels, polyenergetic kernel and exponential fit per cone |
| `engine.py` | Engine: densities, grouping of beam incidences, sum over beams |
| `gpu.py` | GPU superposition (OpenCL, optional): detection, check against the CPU and fallback to the CPU on failure |
| `gamma.py` | 3D gamma (Low; global or local) and statistics per structure |
| `pipeline.py`, `report.py` | Verification workflow and HTML report |
| `commissioning/` | Reading of golden beam data (w2CAD, CSV), model fitting and report |
| `synthetic.py` | Synthetic DICOM cases for testing |
| `gui/` | Graphical interface (tkinter): verification, models, commissioning, curves and settings |

## Installation on Windows

1. If the computer has no conda, install Miniforge
   (https://conda-forge.org/download, "Just Me" option). It is recommended
   over Anaconda because it only uses the free conda-forge channel.
2. Download the repository (**Code → Download ZIP**, or `git clone`) and
   extract it to a permanent folder (avoid accents in the path). Before
   extracting the ZIP: right click → Properties → "Unblock".
3. Double-click `instalar_windows.bat`. The installer:
   * finds Miniforge, Miniconda or Anaconda;
   * creates the `calcindep` environment from `environment.yml`. If the
     hospital proxy blocks conda, it uses the base environment and installs
     the missing packages with pip;
   * compiles the calculation engine (1–2 minutes, only the first time);
   * creates the launchers `CalcIndep.bat` and `CalcIndep_diagnostico.bat`
     and a desktop shortcut.
4. Open CalcIndep from the shortcut (or double-click `CalcIndep.pyw`). A
   loading window appears at once; the first start may take one or two
   minutes. If the program fails to start, it shows the error and saves it in
   `error_arranque.txt`. To see all messages, run `CalcIndep_diagnostico.bat`,
   which opens the program with a console and saves the output in
   `diagnostico.txt`.

Manual installation, if preferred: `conda env create -f environment.yml`, then
`pythonw -m calcindep.gui` from the program folder. With pip:
`pip install -r requirements.txt` (Python 3.10 or later, with tkinter).

### GPU superposition (optional)

The superposition can run on the graphics card with OpenCL. On the
development laptop (Intel HD Graphics 520, i7-6500U) a two-arc VMAT plan goes
from 590 s to 215 s, because the superposition runs about 9 times faster. If
the computer has no GPU, or no `pyopencl`, the program calculates on the CPU
as usual; nothing needs to be changed.

* **Installation**: `instalar_gpu.bat` adds `pyopencl` to the `calcindep`
  environment without updating the other packages (`--freeze-installed`),
  checks that the program still works and tests the GPU. If something fails,
  it explains how to return the environment to its previous state.
* **Automatic choice**: the first time a GPU is used, and again if the model,
  the driver or the kernel code changes, a thorax phantom is calculated with
  the GPU and with the CPU. The GPU is accepted if the maximum difference is
  below 0.01% of the maximum dose. In automatic mode it is only used if it is
  also at least 1.2 times faster. The result is saved in `gpu.json`, in the
  settings folder, so each computer decides according to its own GPU. If
  several GPUs pass, the fastest one is used.
* **Ajustes → Superposición en GPU** (Settings → GPU superposition):
  "Automático" (automatic), "Solo CPU" (CPU only) or a specific GPU (used if
  it passes the accuracy check, even if it is not faster). "Comprobar GPU de
  nuevo" repeats the check.
* **If the GPU fails** during a calculation (memory, driver), that
  calculation and the following ones in the session continue on the CPU, and
  the result carries a warning.
* **Traceability**: the report and `resumen.json` state where the
  superposition was done (device, precision and driver).
* **Precision**: the GPU calculates in single precision (fp32). For
  x = a·ρ·Δs < 0.1 the series expansions of 1 − e⁻ˣ and 1 − (1 − e⁻ˣ)/x are
  used, because in single precision these expressions lose digits in lung and
  with the long-range component of the kernel. In the test VMAT plan, the
  difference with the CPU was at most 0.0011% of the maximum dose in the
  region above 10%, no point changed its gamma result, and the DVH changed by
  at most 0.0001 cGy. In the outer layer of voxels of the calculation grid
  the difference can reach 0.04%, because some transport lines run exactly
  along the faces of the volume and rounding decides whether they count; that
  layer is usually air (External with a 20 mm margin).
* Command line: `python -m calcindep gpu` lists the GPUs and their check
  (`--comprobar` repeats it); `python -m calcindep --gpu cpu verificar ...`
  forces the CPU.

## Using the graphical interface

The window has five tabs.

**Verificar plan** (Check plan)
1. "Examinar…" (Browse) and choose the folder exported from Eclipse (CT,
   RTSTRUCT, RTPLAN and RTDOSE). It may contain several plans; choose one in
   the "Plan" list.
2. Review the beams and the beam model assigned to each one. The program
   first picks the model marked "Default" in "Modelos de haz" (if it has the
   same energy and fluence mode as the beam) and otherwise the model that
   matches machine, energy and fluence mode. Double-clicking a beam changes
   the model of all beams of that machine and energy, and the choice is
   remembered.
3. Choose the HU–density curve. The curve is linked to the CT scanner and is
   proposed automatically for later plans from the same scanner.
4. If needed, assign densities to structures (couch, bolus) with
   "Densidades por estructura…" (Structure densities).
5. Set the gamma criterion and press "Calcular y comparar" (Calculate and
   compare). The progress bar shows the progress and the estimated remaining
   time; "Cancelar" stops the calculation.
6. Results: overall verdict, table per structure (gamma and differences in
   Dmean, D95, D2 and Dmax), slice viewer with TPS dose, calculated dose,
   difference and gamma (values read with the cursor), DVH comparison, and
   HTML report.
   In the viewer, the "Perfil" (Profile) button activates the profile tool:
   with the "Libre" (free) direction a line is dragged over any of the
   images, and with "Horizontal" or "Vertical" a single click is enough. It
   works on axial, coronal and sagittal slices, and shows the TPS dose and the
   CalcIndep dose along the line, with the difference as a percentage of the
   normalization dose. The "Maximizar visor" button (also in the DVH tab)
   hides the left panel.
   The plan passes if the percentage of points with γ ≤ 1 reaches the pass
   threshold inside the External **and** in each anatomical structure with at
   least 10 evaluated points (structures of type SUPPORT, MARKER, BOLUS and
   similar are not counted). In this way, a local failure in the PTV is not
   hidden by a good overall result.
   Each verification is saved in its own folder inside "resultados", with the
   report, the calculated RTDOSE and a `resumen.json` file.

**Modelos de haz** (Beam models): list of the models in the library. The
"Default" checkbox marks the model used by default in verifications (only one
at a time; a second click clears it). Models can be reviewed and edited,
their MU recalibrated, and they can be duplicated, imported and deleted. If a
physical parameter is changed, the model is recalibrated when saved.

**Comisionado** (Commissioning): creates a model from measured data. It reads
the Varian data for Eclipse (w2CAD files `OPD`, `OPP` and `DPR`, and the 2D
output factor table `06X_00.txt`). Wedge curves (`WDD`, `WDP`, `WLP`) are
discarded, because the model describes open fields. Profiles measured on one
side of the axis only are mirrored for the fit. Diagonal profiles of large
fields are used to fit the circular primary collimator, which rounds the
field corners. The off-axis softening is chosen with the deep profiles
(15 cm or more) of the largest field and of fields of about 10, 15 and 25 cm,
refitting the radial profile for each value; if the minimum falls at the
edge of the search grid, the search is extended, and it is finally refined
with a parabolic interpolation. Two forms are tested, linear and quadratic
with the radius, and the one that best reproduces those profiles is kept.
1. Model name, machine (same as `TreatmentMachineName` in the plan), energy
   and fluence mode.
2. Curves: w2CAD files from the golden beam data, or two-column CSV files
   (field size, SSD, depth and axis are requested).
3. Output factors (CSV `campo_x_mm, campo_y_mm, factor`) with their SSD and
   measurement depth.
4. Parameters of each MLC used by the machine: transmission, DLG and width of
   the tongue-and-groove band (values from the Eclipse configuration; they
   are not fitted).
5. MU calibration conditions.
6. "Comisionar" (Commission). When it finishes, the model is stored in the
   library and the comparison with each measured curve and the commissioning
   report are shown. The configuration can be saved to repeat the
   commissioning.

The repository does not include beam data from any real machine. The data in
`examples/gbd_sintetico` are synthetic and are meant to test the
commissioning.

**Curvas HU–densidad** (HU–density curves): create, import, edit point by
point and validate curves; manage the links between scanners and curves.

**Ajustes** (Settings): library folder (it can be on a network share to share
models and curves within the department), results folder, number of threads
and calculation options.

By default the library is created in `Documents\calcindep`, with the
subfolders `modelos`, `curvas_hu`, `comisionado` and `resultados`. The first
time, the generic 6X model and the example curve are copied there. Settings
and the error log are in `%APPDATA%\calcindep`.

## Command line use (optional)

```
python -m calcindep comisionar examples/gbd_sintetico/comisionado.json
python -m calcindep verificar FOLDER --modelo data/beam_models/generico_6X.json --curva data/hu_ed/curva_ejemplo.csv --gamma 3,2 --umbral 10
python -m calcindep caso-sintetico test_vmat --tecnica VMAT
```

`comisionar` = commission a model, `verificar` = check a plan,
`caso-sintetico` = create a synthetic DICOM case. `python -m calcindep`
without arguments opens the graphical interface. Example JSON configurations
are in `examples/`.

### Export recommendations

* Export the plan dose (DoseSummationType PLAN). If only per-beam doses are
  available, they are summed automatically.
* The TPS dose matrix defines the calculation grid. The TERMA is traced
  through the whole CT, so the attenuation is correct even if the dose matrix
  does not cover the whole patient.
* If the RTSTRUCT does not include the density assigned to the couch, assign
  it in "Densidades por estructura…".

## Calculation method

**Densities.** The CT is converted to relative electron density with the
HU–RED curve and averaged in each voxel of the calculation grid (3×3×3
supersampling). Air is assigned outside the External, except for structures
of type SUPPORT (couch). Structures with a density assigned in the RTSTRUCT
(`REL_ELEC_DENSITY`) keep that density.

**Fluence.** For each pair of control points, the fraction of MU during which
each point of the isocenter plane is uncovered by jaws and leaves is
calculated analytically (linear motion between control points). MLC
transmission, DLG (shift of the leaf tips), jaw transmission, primary source
size, extra-focal source and radial fluence profile are included. Arcs are
divided into incidences of at most 2°.

**MLC.** The MLC type of each beam is identified from the leaf boundaries in
the RTPLAN (`LeafPositionBoundaries`): Millennium 120 (60 pairs, ±200 mm) or
HD120 (60 pairs, ±110 mm). The beam model stores the transmission, the DLG
and the tongue-and-groove width of each MLC, and the calculation uses those
of the MLC of the beam. If the model has no parameters for that MLC, or the
MLC is not recognized, the calculation does not start and the program reports
which beam fails. The transmission is T_MLC under the leaves, T_jaw under the
jaws and the product of both where they overlap.

**Tongue and groove.** Within a band of total width `tg_width_mm`, centered
on each boundary between adjacent leaves, a point is only uncovered when both
leaves are open at the same time; the rest of the time it receives the MLC
transmission. The open time is calculated analytically (intersection of the
intervals of both leaves). Each row of the fluence map (0.5 mm) is weighted
by the fraction of its height that falls within the band. With a width of 0
the effect is not modeled; this is the value for models saved before this
option existed.

**TERMA.** It is calculated for each incidence by divergent ray tracing from
the source, with the model spectrum (12 energies), off-axis softening and the
inverse square law. Softening multiplies the attenuation coefficients by
1 + s rⁿ, where r is the distance to the axis at the isocenter plane (in cm,
up to `softening_rmax_cm`) and n = 1 (linear, s in cm⁻¹) or n = 2 (quadratic,
s in cm⁻²), according to `softening_power` in the model. The quadratic form
has little effect near the axis and grows towards the edge of large fields.
Models saved before this option are linear.

**Superposition.** Collapsed cone (Ahnesjö 1989) with 94 directions per
incidence, oriented along the beam axis. The kernels are EDKnrc kernels
grouped into 13 zenith bands and fitted with two exponentials per band.
Transport along each cone uses the radiological distance (electron density
scaling), which provides the heterogeneity correction. For arcs, incidences
are grouped into 10° sectors for the superposition (the TERMA of each
incidence is calculated at its own angle). In a test with a full arc, 10°
sectors differ by at most 0.17% (20°: 0.44%) from the calculation with 3°
sectors, with 3 and 5 times shorter calculation times.

**Kernel tilt.** In large fields the rays at the field edge arrive at up to
11° from the axis (40×40 cm). If the kernel is always oriented along the
axis, the forward scatter at the edges is directed into the field: with the
Varian data, the PDD of the 40×40 field at 30 cm was 3% too high and the dose
outside the field at 30 cm was 3% to 6% too low. To correct this, nodal
directions are defined every 10° as seen from the source (centered on the
axis). The TERMA of each voxel is shared among the four surrounding nodes
with bilinear weights according to its angle, and each part is superposed
with the kernel oriented along its node. With this sharing the effective
kernel direction changes continuously (a sector split with sharp edges
produced steps of 3–5% in the profiles). It is only applied when the relevant
TERMA extends beyond a cone of 4.5° half-angle (fields larger than about
16 cm); smaller fields are calculated as before.
The difference between the calculation with and without tilt is smooth, so it
is calculated on a grid of about 5 mm and interpolated: compared with the full
calculation on the fine grid it differs by less than 0.3% inside and outside
the field and by up to 1.5% in the penumbra (equivalent to less than 0.2 mm),
with a 4.5 times shorter calculation time. Each model states whether it uses
the tilt (`kernel_tilt`); it is also controlled with the options
`kernel_tilt`, `tilt_tile_deg`, `tilt_min_halfangle_deg` and `tilt_coarse_mm`
of `CalcOptions`.

**Electron contamination.** Exponential term with radiological depth,
proportional to the smoothed aperture.

**Calibration.** The dose is converted to cGy with the factor obtained by
calculating the reference conditions of the model. Output factors follow from
the calculation itself (phantom scatter from the superposition and head
scatter from the extra-focal source).

**Gamma.** Low et al., Med Phys 1998;25:656. For each point of the reference
distribution (by default the TPS dose) above the threshold, the minimum of Γ
is searched on a grid of shifts with step DTA/10 within a radius of 2×DTA,
with trilinear interpolation of the evaluated distribution. It is calculated
inside the External and summarized per structure (percentage with γ ≤ 1,
mean, 95th percentile and maximum), together with the differences in Dmean,
D95, D2 and Dmax.

## Tests performed

* IEC geometry for the four patient positions, couch and collimator;
  analytical fluence (static, sliding window, arc subdivision); gamma against
  cases with a known solution (pure shift, global and local dose difference);
  HU–RED curve; DICOM reading and writing.
* GPU (if an OpenCL device is present): same dose as the CPU in a phantom and
  in water (inside the volume, difference < 0.001% of the maximum dose),
  check and registration per device, use of the CPU if there is no GPU, if
  the GPU fails the check, or if it fails during the calculation.
* Water, generic 6X model: PDD(10 cm) 10×10 = 66.9%, dmax 16 mm; typical
  values for a flattened 6 MV beam.
* Full chain with synthetic data: golden beam data are generated with a
  "true" model, a model is commissioned from them, and plans whose "TPS" dose
  was calculated with the true model are checked. Result with the
  commissioned model: gamma 3%/2 mm 100% in IMRT and VMAT, PTV Dmean +0.6%.
  With the uncommissioned generic model, the gamma pass rate in the PTV drops
  to 17–28% and Dmean rises by 4.9%, that is, the verification detects the
  mismatch. The reports are in `examples/informes_ejemplo`.

These tests check internal consistency. Validation against measurements and
against Eclipse with real plans is still required and must be done at each
center.

## Known limitations

* Energies: the included kernels reach 6 MeV, enough for 6X and 6FFF. For 10X
  or 15X, kernels up to the maximum energy must be added.
* With the Varian data of a 6 MV Clinac (kernel tilt and quadratic softening),
  71 of the 77 curves pass gamma 2%/2 mm in more than 97% of the points. Those
  below are the 15×15 profile at 30 cm (92.2%; shoulder calculated 1.5% low),
  the 30×30 profile at 30 cm (95.2%) and the diagonal profiles of the 40×40
  field (90–92% at all depths, in the corner region clipped by the primary
  collimator).
* The output factor of the 3×3 field is 1.6% high compared with the Varian
  table. The kernel is not the cause (the exponential fit and the angular
  discretization change that factor by less than 0.01%); the likely causes are
  the source model or the detector used in the measurement.
* The extra-focal source has different widths in X and Y, but it does not
  model the position of each jaw separately.
* No model for physical wedges, dynamic wedges (EDW), blocks or radiosurgery
  cones: the plan is calculated without them and the report warns about it.
* MLC: constant DLG, a single transmission per MLC (with the open-beam
  spectrum) and a fixed-width tongue-and-groove band with the same
  transmission as the MLC. Leaf tip shape and interleaf leakage are not
  modeled separately. Only Millennium 120 and HD120; dual-layer MLCs are not
  supported.
* Models saved before the per-MLC parameters are loaded with their
  transmission and DLG assigned to the Millennium 120 and without tongue and
  groove.
* The kernel does not change with spectral hardening at depth or with
  off-axis softening.
* Models saved before the kernel tilt are loaded without it (model option
  `kernel_tilt`), so that they calculate as when they were validated. To use
  it, the model must be commissioned again.
* Media are treated as water with scaled electron density; the calculated
  dose is approximately dose to water within the medium.
* The calibration depends slightly on voxel size; the model is recalibrated
  automatically if the plan grid differs by more than 0.6 mm.

## License

CalcIndep is distributed under the MIT license (`LICENSE`). The EDKnrc
kernels (conehead repository, MIT license) and the NIST XCOM attenuation
coefficients keep their own terms, which are listed in
`THIRD_PARTY_NOTICES.txt`.

## References

* Ahnesjö A. Collapsed cone convolution of radiant energy for photon dose
  calculation in heterogeneous media. Med Phys 1989;16:577-592.
* Mackie TR, Bielajew AF, Rogers DWO, Battista JJ. Generation of photon energy
  deposition kernels using the EGS Monte Carlo code. Phys Med Biol 1988;33:1-20.
* Low DA, Harms WB, Mutic S, Purdy JA. A technique for the quantitative
  evaluation of dose distributions. Med Phys 1998;25:656-661.
* EDKnrc kernels: conehead repository (S. Peet, MIT license); see
  `data/kernels/edknrc_mono/LEEME.md`.
* Water attenuation coefficients: NIST XCOM, Standard Reference Database 8.
