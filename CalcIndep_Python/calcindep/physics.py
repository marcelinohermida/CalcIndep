"""Datos físicos básicos.

Coeficientes másicos de atenuación del agua líquida (NIST XCOM, atenuación
total con dispersión coherente), en cm^2/g. La energía está en MeV.
"""
import numpy as np

_MU_WATER = np.array([
    [1.00000E-02, 5.329E+00],
    [1.50000E-02, 1.673E+00],
    [2.00000E-02, 8.096E-01],
    [3.00000E-02, 3.756E-01],
    [4.00000E-02, 2.683E-01],
    [5.00000E-02, 2.269E-01],
    [6.00000E-02, 2.059E-01],
    [8.00000E-02, 1.837E-01],
    [1.00000E-01, 1.707E-01],
    [1.50000E-01, 1.505E-01],
    [2.00000E-01, 1.370E-01],
    [3.00000E-01, 1.186E-01],
    [4.00000E-01, 1.061E-01],
    [5.00000E-01, 9.687E-02],
    [6.00000E-01, 8.956E-02],
    [8.00000E-01, 7.865E-02],
    [1.00000E+00, 7.072E-02],
    [1.25000E+00, 6.323E-02],
    [1.50000E+00, 5.754E-02],
    [2.00000E+00, 4.942E-02],
    [3.00000E+00, 3.969E-02],
    [4.00000E+00, 3.403E-02],
    [5.00000E+00, 3.031E-02],
    [6.00000E+00, 2.770E-02],
    [8.00000E+00, 2.429E-02],
    [1.00000E+01, 2.219E-02],
    [1.50000E+01, 1.941E-02],
    [2.00000E+01, 1.813E-02],
])


def mu_rho_water(energy_mev):
    """Coeficiente másico de atenuación del agua (cm^2/g).

    Interpolación log-log de la tabla NIST.
    """
    e = np.atleast_1d(np.asarray(energy_mev, dtype=float))
    le = np.log(_MU_WATER[:, 0])
    lm = np.log(_MU_WATER[:, 1])
    out = np.exp(np.interp(np.log(e), le, lm))
    return out if np.ndim(energy_mev) else float(out[0])
