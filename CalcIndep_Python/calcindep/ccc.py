"""Superposición collapsed cone (Ahnesjö 1989) en CPU con numba.

Para cada dirección de transporte se construye una red de líneas paralelas a
esa dirección (separación h, paso ds). A lo largo de cada línea se aplica la
recursión analítica para un kernel exponencial con escalado por densidad:

    F_out = F_in e^{-a Δl} + T (1 - e^{-a Δl}) / a
    D_seg = A [ F_in (1 - e^{-a Δl})/(a Δl) + (T/a) (1 - (1 - e^{-a Δl})/(a Δl)) ]

con Δl = ρ_e Δs (distancia radiológica). D_seg es la dosis media en el
segmento. La dosis en cada vóxel se obtiene interpolando trilinealmente la
red de cada dirección, y se suman todas las direcciones.
"""
import numpy as np
from numba import njit, prange


@njit(cache=True, fastmath=True)
def _trilinear2(A, B, fz, fy, fx):
    nz, ny, nx = A.shape
    # Fuera de la caja de vóxeles el medio es vacío; dentro del último medio
    # vóxel se usa el valor del borde.
    if fx < -0.5 or fy < -0.5 or fz < -0.5 or fx > nx - 0.5 or fy > ny - 0.5 or fz > nz - 0.5:
        return 0.0, 0.0
    fx = min(max(fx, 0.0), nx - 1.0)
    fy = min(max(fy, 0.0), ny - 1.0)
    fz = min(max(fz, 0.0), nz - 1.0)
    i0 = int(fx)
    j0 = int(fy)
    k0 = int(fz)
    if i0 >= nx - 1:
        i0 = nx - 2 if nx > 1 else 0
    if j0 >= ny - 1:
        j0 = ny - 2 if ny > 1 else 0
    if k0 >= nz - 1:
        k0 = nz - 2 if nz > 1 else 0
    tx = fx - i0
    ty = fy - j0
    tz = fz - k0
    i1 = min(i0 + 1, nx - 1)
    j1 = min(j0 + 1, ny - 1)
    k1 = min(k0 + 1, nz - 1)
    a = 0.0
    b = 0.0
    w000 = (1 - tz) * (1 - ty) * (1 - tx)
    w001 = (1 - tz) * (1 - ty) * tx
    w010 = (1 - tz) * ty * (1 - tx)
    w011 = (1 - tz) * ty * tx
    w100 = tz * (1 - ty) * (1 - tx)
    w101 = tz * (1 - ty) * tx
    w110 = tz * ty * (1 - tx)
    w111 = tz * ty * tx
    a = (w000 * A[k0, j0, i0] + w001 * A[k0, j0, i1] + w010 * A[k0, j1, i0]
         + w011 * A[k0, j1, i1] + w100 * A[k1, j0, i0] + w101 * A[k1, j0, i1]
         + w110 * A[k1, j1, i0] + w111 * A[k1, j1, i1])
    b = (w000 * B[k0, j0, i0] + w001 * B[k0, j0, i1] + w010 * B[k0, j1, i0]
         + w011 * B[k0, j1, i1] + w100 * B[k1, j0, i0] + w101 * B[k1, j0, i1]
         + w110 * B[k1, j1, i0] + w111 * B[k1, j1, i1])
    return a, b


@njit(cache=True, fastmath=True)
def _slab(bx, by, bz, d, lo, hi):
    smin = -1e30
    smax = 1e30
    for ax in range(3):
        if ax == 0:
            b = bx
        elif ax == 1:
            b = by
        else:
            b = bz
        dd = d[ax]
        if abs(dd) < 1e-12:
            if b < lo[ax] or b > hi[ax]:
                return 1e30, -1e30
        else:
            t1 = (lo[ax] - b) / dd
            t2 = (hi[ax] - b) / dd
            if t1 > t2:
                t1, t2 = t2, t1
            if t1 > smin:
                smin = t1
            if t2 < smax:
                smax = t2
    return smin, smax


@njit(parallel=True, cache=True, fastmath=True)
def _sweep(T, rho, sp, d, e1, e2, u0, v0, s0, h, ds, nu, nv, ns, A, a, box_lo, box_hi,
           t_lo, t_hi, lat, Fbuf):
    # lat se reutiliza entre direcciones: cada línea pone a cero los puntos que
    # no recorre. Fbuf (nu*nv, ncomp) guarda la energía transportada de cada
    # línea, para no reservar memoria dentro del bucle paralelo.
    ncomp = A.shape[0]
    for line in prange(nu * nv):
        iu = line // nv
        iv = line - iu * nv
        bu = u0 + iu * h
        bv = v0 + iv * h
        bx = bu * e1[0] + bv * e2[0]
        by = bu * e1[1] + bv * e2[1]
        bz = bu * e1[2] + bv * e2[2]
        smin, smax = _slab(bx, by, bz, d, box_lo, box_hi)
        if smax <= smin:
            lat[iu, iv, :] = 0.0
            continue
        # Antes de entrar en la caja que contiene TERMA > 0 la energía
        # transportada es nula: se empieza la recursión en esa entrada.
        tmin, tmax = _slab(bx, by, bz, d, t_lo, t_hi)
        if tmax <= tmin:
            lat[iu, iv, :] = 0.0
            continue
        if tmin > smin:
            smin = tmin
        k_in = int(np.floor((smin - s0) / ds))
        k_out = int(np.ceil((smax - s0) / ds))
        if k_in < 0:
            k_in = 0
        if k_out > ns:
            k_out = ns
        if k_out < k_in:
            k_out = k_in
        lat[iu, iv, :k_in] = 0.0
        lat[iu, iv, k_out:] = 0.0
        F = Fbuf[line]
        F[:] = 0.0
        for k in range(k_in, k_out):
            s = s0 + (k + 0.5) * ds
            px = bx + s * d[0]
            py = by + s * d[1]
            pz = bz + s * d[2]
            t, r = _trilinear2(T, rho, pz / sp[2], py / sp[1], px / sp[0])
            dl = r * ds
            dose = 0.0
            for j in range(ncomp):
                aj = a[j]
                x = aj * dl
                if x < 1e-5:
                    e = 1.0 - x
                    f1 = 1.0 - 0.5 * x
                else:
                    e = np.exp(-x)
                    f1 = (1.0 - e) / x
                dose += A[j] * (F[j] * f1 + (t / aj) * (1.0 - f1))
                F[j] = F[j] * e + t * (1.0 - e) / aj
            lat[iu, iv, k] = dose


@njit(parallel=True, cache=True, fastmath=True)
def _gather(lat, sp, d, e1, e2, u0, v0, s0, h, ds, out, mask):
    nz, ny, nx = out.shape
    nu, nv, ns = lat.shape
    for k in prange(nz):
        pz = k * sp[2]
        for j in range(ny):
            py = j * sp[1]
            for i in range(nx):
                if not mask[k, j, i]:
                    continue
                px = i * sp[0]
                fu = (px * e1[0] + py * e1[1] + pz * e1[2] - u0) / h
                fv = (px * e2[0] + py * e2[1] + pz * e2[2] - v0) / h
                fs = (px * d[0] + py * d[1] + pz * d[2] - s0) / ds - 0.5
                if fu < 0 or fv < 0 or fs < 0 or fu > nu - 1 or fv > nv - 1 or fs > ns - 1:
                    continue
                iu = min(int(fu), nu - 2)
                iv = min(int(fv), nv - 2)
                is_ = min(int(fs), ns - 2)
                tu = fu - iu
                tv = fv - iv
                ts = fs - is_
                val = ((1 - tu) * (1 - tv) * (1 - ts) * lat[iu, iv, is_]
                       + (1 - tu) * (1 - tv) * ts * lat[iu, iv, is_ + 1]
                       + (1 - tu) * tv * (1 - ts) * lat[iu, iv + 1, is_]
                       + (1 - tu) * tv * ts * lat[iu, iv + 1, is_ + 1]
                       + tu * (1 - tv) * (1 - ts) * lat[iu + 1, iv, is_]
                       + tu * (1 - tv) * ts * lat[iu + 1, iv, is_ + 1]
                       + tu * tv * (1 - ts) * lat[iu + 1, iv + 1, is_]
                       + tu * tv * ts * lat[iu + 1, iv + 1, is_ + 1])
                out[k, j, i] += val


def _basis(d):
    d = d / np.linalg.norm(d)
    ref = np.array([1.0, 0.0, 0.0]) if abs(d[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    e1 = np.cross(d, ref)
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(d, e1)
    return d, e1, e2


def superpose(terma, rho, spacing_cm, directions, A, a, mask=None,
              line_spacing_cm=None, step_cm=None, margin_vox=2):
    """Dosis por superposición collapsed cone.

    terma, rho: arrays (nz, ny, nx); rho es la densidad electrónica relativa.
    spacing_cm: (dx, dy, dz) en cm.
    directions: (n, 3) vectores unitarios (x, y, z) de propagación.
    A, a:       (n, ncomp) parámetros del kernel por dirección.
    mask:       vóxeles donde se evalúa la dosis (por defecto todos).
    """
    # TERMA, densidad y red de dosis de cada dirección en float32 (precisión
    # relativa ~1e-7, menos memoria que mover); las sumas se hacen en float64.
    T = np.ascontiguousarray(terma, dtype=np.float32)
    R = np.ascontiguousarray(rho, dtype=np.float32)
    sp = np.asarray(spacing_cm, float)
    nz, ny, nx = T.shape
    if mask is None:
        mask = np.ones(T.shape, dtype=np.bool_)
    h = float(line_spacing_cm or sp.min())
    ds = float(step_cm or sp.min())
    m = margin_vox * sp
    box_lo = -0.5 * sp - m
    box_hi = np.array([(nx - 0.5) * sp[0], (ny - 0.5) * sp[1], (nz - 0.5) * sp[2]]) + m
    corners = np.array([[x, y, z] for x in (box_lo[0], box_hi[0])
                        for y in (box_lo[1], box_hi[1]) for z in (box_lo[2], box_hi[2])])
    out = np.zeros(T.shape, dtype=np.float64)
    nzT = np.nonzero(np.asarray(terma) > 0)
    if nzT[0].size == 0:
        return out
    t_lo = np.array([nzT[2].min() - 1.0, nzT[1].min() - 1.0, nzT[0].min() - 1.0]) * sp
    t_hi = np.array([nzT[2].max() + 1.0, nzT[1].max() + 1.0, nzT[0].max() + 1.0]) * sp
    ncomp = A.shape[1]
    buf = np.empty(0, dtype=np.float32)
    fbuf = np.empty(0, dtype=np.float64)
    for n in range(directions.shape[0]):
        d, e1, e2 = _basis(np.asarray(directions[n], float))
        pu = corners @ e1
        pv = corners @ e2
        ps = corners @ d
        u0, v0, s0 = pu.min(), pv.min(), ps.min()
        nu = int(np.ceil((pu.max() - u0) / h)) + 1
        nv = int(np.ceil((pv.max() - v0) / h)) + 1
        ns = int(np.ceil((ps.max() - s0) / ds)) + 1
        if buf.size < nu * nv * ns:
            buf = np.empty(int(1.25 * nu * nv * ns), dtype=np.float32)
        if fbuf.size < nu * nv * ncomp:
            fbuf = np.empty(int(1.25 * nu * nv) * ncomp, dtype=np.float64)
        lat = buf[:nu * nv * ns].reshape(nu, nv, ns)
        _sweep(T, R, sp, d, e1, e2, u0, v0, s0, h, ds, nu, nv, ns,
               np.ascontiguousarray(A[n], dtype=np.float64),
               np.ascontiguousarray(a[n], dtype=np.float64), box_lo, box_hi, t_lo, t_hi, lat,
               fbuf[:nu * nv * ncomp].reshape(nu * nv, ncomp))
        _gather(lat, sp, d, e1, e2, u0, v0, s0, h, ds, out, mask)
    return out
