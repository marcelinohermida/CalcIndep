"""Cálculo de TERMA polienergético con trazado de rayos divergentes.

1. Se lanza una red de rayos desde la fuente (separación definida en el plano
   del isocentro) y se acumula la profundidad radiológica a lo largo de cada
   rayo, parametrizada por la distancia z a la fuente medida sobre el eje.
2. Para cada vóxel se proyecta su posición al plano del isocentro, se
   interpola la fluencia de energía y la profundidad radiológica, y se
   evalúa
       T = Psi (SAD/z)^2 sum_E psi_E (mu/rho)_E s(r) exp(-(mu/rho)_E s(r) d_rad)
   donde s(r) es el factor de ablandamiento fuera de eje.
3. La contaminación electrónica se modela como
       D_e = Psi_e (SAD/z)^2 exp(-k_e d_rad)
   con Psi_e una apertura suavizada.
"""
import numpy as np
from numba import njit, prange

from .ccc import _trilinear2


@njit(parallel=True, cache=True, fastmath=True)
def _ray_cumulative(rho, sp_mm, org_mm, src, u, v, ax, sad, xr, yr, z0, hz, nk, out):
    nrx = xr.shape[0]
    nry = yr.shape[0]
    for idx in prange(nrx * nry):
        ix = idx // nry
        iy = idx - ix * nry
        qx = (xr[ix] * u[0] + yr[iy] * v[0] + sad * ax[0]) / sad
        qy = (xr[ix] * u[1] + yr[iy] * v[1] + sad * ax[1]) / sad
        qz = (xr[ix] * u[2] + yr[iy] * v[2] + sad * ax[2]) / sad
        L = np.sqrt(qx * qx + qy * qy + qz * qz)
        cum = 0.0
        out[ix, iy, 0] = 0.0
        for k in range(1, nk):
            zm = z0 + (k - 0.5) * hz
            px = src[0] + zm * qx
            py = src[1] + zm * qy
            pz = src[2] + zm * qz
            r, _ = _trilinear2(rho, rho, (pz - org_mm[2]) / sp_mm[2],
                               (py - org_mm[1]) / sp_mm[1], (px - org_mm[0]) / sp_mm[0])
            cum += r * hz * L * 0.1  # mm -> cm
            out[ix, iy, k] = cum


@njit(cache=True, fastmath=True)
def _bilin(img, x0, dx, y0, dy, x, y):
    ny, nx = img.shape
    fx = (x - x0) / dx
    fy = (y - y0) / dy
    if fx < 0 or fy < 0 or fx > nx - 1 or fy > ny - 1:
        return 0.0
    i0 = min(int(fx), nx - 2)
    j0 = min(int(fy), ny - 2)
    tx = fx - i0
    ty = fy - j0
    return ((1 - tx) * (1 - ty) * img[j0, i0] + tx * (1 - ty) * img[j0, i0 + 1]
            + (1 - tx) * ty * img[j0 + 1, i0] + tx * ty * img[j0 + 1, i0 + 1])


@njit(parallel=True, cache=True, fastmath=True)
def _voxel_terma(shape, sp_mm, org_mm, src, u, v, ax, sad,
                 flu, fx0, fdx, fy0, fdy, eflu,
                 cum, xr0, dxr, yr0, dyr, z0, hz,
                 psiE, muE, soft, soft_rmax, soft_pow, ke, T, De):
    nz, ny, nx = T.shape
    nE = psiE.shape[0]
    nrx, nry, nk = cum.shape
    for k in prange(nz):
        pz = org_mm[2] + k * sp_mm[2]
        for j in range(ny):
            py = org_mm[1] + j * sp_mm[1]
            for i in range(nx):
                px = org_mm[0] + i * sp_mm[0]
                rx = px - src[0]
                ry = py - src[1]
                rz = pz - src[2]
                z = rx * ax[0] + ry * ax[1] + rz * ax[2]
                if z <= 1.0:
                    continue
                xb = (rx * u[0] + ry * u[1] + rz * u[2]) * sad / z
                yb = (rx * v[0] + ry * v[1] + rz * v[2]) * sad / z
                psi = _bilin(flu, fx0, fdx, fy0, fdy, xb, yb)
                pe = _bilin(eflu, fx0, fdx, fy0, fdy, xb, yb)
                if psi <= 0.0 and pe <= 0.0:
                    continue
                # Profundidad radiológica interpolada en la red de rayos.
                fxr = (xb - xr0) / dxr
                fyr = (yb - yr0) / dyr
                fz = (z - z0) / hz
                if fxr < 0 or fyr < 0 or fz < 0 or fxr > nrx - 1 or fyr > nry - 1 or fz > nk - 1:
                    continue
                d, _ = _trilinear2(cum, cum, fxr, fyr, fz)
                isq = (sad / z) * (sad / z)
                rcm = np.sqrt(xb * xb + yb * yb) * 0.1
                if rcm > soft_rmax:
                    rcm = soft_rmax
                if soft_pow == 1.0:
                    sf = 1.0 + soft * rcm
                elif soft_pow == 2.0:
                    sf = 1.0 + soft * rcm * rcm
                else:
                    sf = 1.0 + soft * rcm ** soft_pow
                t = 0.0
                for e in range(nE):
                    m = muE[e] * sf
                    t += psiE[e] * m * np.exp(-m * d)
                T[k, j, i] = psi * isq * t
                De[k, j, i] = pe * isq * np.exp(-ke * d)


def compute_terma(rho, grid, geom, fluence, fl_axes, efluence, energies, weights,
                  mu, softening=0.0, softening_rmax_cm=20.0, ke=0.5, softening_power=1.0,
                  ray_spacing_mm=None, step_mm=None, trace=None):
    """TERMA y dosis de contaminación electrónica de una incidencia.

    trace: (rho_t, grid_t) opcional; densidad usada para el trazado de rayos
    (por ejemplo, todo el CT) cuando la rejilla de cálculo es más pequeña.

    fluence, efluence: mapas 2D (ny_f, nx_f) en el plano del isocentro.
    fl_axes: (x0, dx, y0, dy) de los mapas en mm (sistema BLD).
    energies, weights: espectro (MeV, fracción de fotones).
    mu: (mu/rho) del agua para cada energía (cm^2/g).
    """
    sp = np.asarray(grid.spacing, float)
    org = np.asarray(grid.origin, float)
    src = geom.source
    u, v, ax = geom.u, geom.v, geom.axis
    sad = float(geom.sad)
    x0, dx, y0, dy = fl_axes
    flu = np.ascontiguousarray(fluence, dtype=np.float64)
    efl = np.ascontiguousarray(efluence if efluence is not None else np.zeros_like(flu), dtype=np.float64)
    # Extensión de la red de rayos: zona con fluencia no despreciable.
    tot = flu + efl
    thr = tot.max() * 1e-5
    jj, ii = np.nonzero(tot > thr)
    if jj.size == 0:
        z = np.zeros(grid.shape)
        return z, z.copy()
    rs = float(ray_spacing_mm or min(sp.min(), 2.5))
    xa = x0 + dx * ii.min() - rs
    xb_ = x0 + dx * ii.max() + rs
    ya = y0 + dy * jj.min() - rs
    yb_ = y0 + dy * jj.max() + rs
    xr = np.arange(xa, xb_ + rs, rs)
    yr = np.arange(ya, yb_ + rs, rs)
    # Rango de z (distancia a la fuente sobre el eje) que cubre las rejillas.
    rho_t, grid_t = trace if trace is not None else (rho, grid)
    corners = []
    for gg in (grid, grid_t):
        ext = gg.extent()
        corners += [[x, y, zc] for x in ext[0:2] for y in ext[2:4] for zc in ext[4:6]]
    zc = (np.array(corners) - src) @ ax
    z0 = max(1.0, zc.min() - 2 * sp.max())
    z1 = zc.max() + 2 * sp.max()
    hz = float(step_mm or 0.5 * sp.min())
    nk = int(np.ceil((z1 - z0) / hz)) + 1
    cum = np.zeros((xr.size, yr.size, nk))
    R = np.ascontiguousarray(rho_t, dtype=np.float64)
    _ray_cumulative(R, np.asarray(grid_t.spacing, float), np.asarray(grid_t.origin, float),
                    src, u, v, ax, sad, xr, yr, z0, hz, nk, cum)
    e = np.asarray(energies, float)
    w = np.asarray(weights, float)
    psiE = w * e
    psiE = psiE / psiE.sum()
    T = np.zeros(grid.shape)
    De = np.zeros(grid.shape)
    _voxel_terma(np.array(grid.shape), sp, org, src, u, v, ax, sad,
                 flu, x0, dx, y0, dy, efl, cum, xr[0], rs, yr[0], rs, z0, hz,
                 psiE, np.asarray(mu, float), float(softening), float(softening_rmax_cm),
                 float(softening_power), float(ke), T, De)
    return T, De
