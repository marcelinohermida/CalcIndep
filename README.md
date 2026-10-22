# CalcIndep introduction

CalcIndep is a "toy" system for the independent dose calculation of external radiotherapy plans of Varian Clinac and TrueBeam linacs.

CalcIndep was created as an **"weekend experiment"** with Claude AI tool. My intention was to test how far a tool like Claude could go to create a system which I considered hard to create, with a minimal effort and involvement from my side. According to this framework, no formal unit tests, etc were done to check the code accuracy and correctness, more than check the calculations with some IMRT and VMAT test plans exported from Eclipse TPS.

The system was created with the Claude Opus 5.5 model with effort set to High, along a period of just 3 days. The initial prompt I provided to Claude was (in Spanish):

*Serías capaz de hacer un sistema de cálculo independiente para planes de radioterapia externa? Tendría que poder importar planes de RT en formato DICOM, incluyendo CT, estructuras , plan y dosis. Tendría que hacer el cálculo con un algoritmo tipo collased cone al menos, y permitir añadir una curva de número CT frente a densidad electrónica. Debería tener corrección pot inhomogeneidades, y debería comparar la distribución de dosis importada con la distribución calculada , usando el gamma índex del artículo de Low, para cada estructura*

Initially, a Python version was created, and later a web app version was developed, giving instructions to Claude to port the Python code to Javascript exactly, checking that an exact traslation was done, allowing only dose differences below 0.001% between both versions. The final result of this code port was a web app of less than 1 MB, which can run IMRT and VMAT dose calculations from a web browser, using GPU if available!

As an estimation, the "human time" needed to create both versions was about 5-6 hours, while the "Claude time" was about 20-25 hours.

A general description of the capabilities of the software is provided below. More details can be found the folders of the Python and webapp versions.

**Of course, this system is not aimed to be used clinically, only for learning and fun!**

To feel how far the AI-assisted programming can go, all the code and documents (manual, README, etc), except this initial introduction section, was written by Claude, following my requests. Only minor editing was done from my side. The code, however, was created 100% by Claude following my prompts to include new features, etc. I did not edit a single line of code.

At the moment, the software GUI and manual are in Spanish. READMEs in English are provided with basic instructions, and explaining the software features.


# Description
CalcIndep is a tool to check external-beam photon radiotherapy plans.
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

<img width="3200" height="1800" alt="imagen" src="https://github.com/user-attachments/assets/fabf0e5c-60af-4d0d-8627-fe0a522a0787" />
Plan verification screen of CalcIndep webapp version.




# Not for clinical use
> In-house tool, not certified as a medical device. Before use, the
> beam model of each machine and energy must be commissioned, the HU to
> electron density curve of the CT scanner must be loaded. **(Human note: A basic model, which was entirely created by Claude, is included so you can start calculating just out of the box).**


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
