# Kernels de deposición de energía

`edk_water_mono.npz` contiene kernels de punto monoenergéticos en agua para
0.5–6.0 MeV (pasos de 0.5 MeV), 48 conos de 3.75° y 24 esferas hasta 60 cm.

* Generados con EGSnrc / EDKnrc (medio H2O521ICRU, ECUT 0.521 MeV, PCUT 0.010 MeV).
* Origen: repositorio *conehead* de Samuel Peet (licencia MIT),
  https://github.com/samuelpeet/conehead, directorio `kernels/`.
* Conversión: se han leído las tablas `.egslst` (columna "total") y se han
  guardado como fracción de energía por bin (cono, esfera).

Arrays del fichero:

| clave | forma | contenido |
|---|---|---|
| `energies_MeV` | (12,) | energía del fotón incidente |
| `angle_edges_deg` | (49,) | límites de los conos |
| `radius_edges_cm` | (25,) | límites de las esferas |
| `total` | (12, 48, 24) | fracción de energía depositada |
| `primary` | (12, 48, 24) | componente primaria |

Para energías nominales por encima de 6 MV (10X, 15X, 10FFF) hacen falta
kernels hasta la energía máxima del espectro. Se pueden generar con EDKnrc
usando el mismo formato y añadirlos a este fichero.
