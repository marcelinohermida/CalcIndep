Test cases (synthetic DICOM data, not patients)
===============================================

They are used to check the web version on each computer and browser. The
expected results were calculated with the desktop (Python) version using the
same options. Both cases use the beam model included with the program,
"Generico 6X" (generic 6X, not commissioned), and the curve curva_ejemplo.csv.

1. caso_3D_Millennium120 (4 static fields, about 20 s to 2 min)
   - Model: Generico 6X; curve: curva_ejemplo.csv
   - Grid: isotropic 3 mm voxels
   - Gamma: 3 %, 2 mm, Local, 10 % threshold, normalization to maximum,
     reference "Calculo independiente" (independent calculation),
     pass rate 95 %
   - Expected result: CUMPLE (pass), 99.9 % of 157940 points with γ ≤ 1,
     mean gamma 0.15, gamma p95 0.32, max gamma 1.60

2. caso_VMAT_Millennium120 (2 arcs, 2 to 15 minutes depending on the computer)
   - Model: Generico 6X for both arcs; curve: curva_ejemplo.csv
   - Grid: same as the TPS dose
   - Gamma: 3 %, 3 mm, Global, 10 % threshold, normalization to maximum,
     reference "Dosis del TPS" (TPS dose), pass rate 95 %
   - Expected result: CUMPLE (pass), 100.0 % of 182970 points with
     γ ≤ 1, mean gamma 0.01, gamma p95 0.02, max gamma 0.03
   - The "TPS" dose of this case was calculated with the same model, so the
     gamma values are close to zero: any calculation difference would show.

The program warns that the model is not commissioned; this is expected.
With the GPU, values may differ in the last decimal digit (the GPU calculates
in single precision); the percentage of passing points must be the same.
