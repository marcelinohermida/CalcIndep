"""Superposición collapsed cone en GPU (OpenCL), opcional.

El motor pide la superposición a un «backend» (get_backend). Según el modo:

  "auto"   Usa una GPU solo si este ordenador tiene una con OpenCL, ha superado
           la comprobación automática y es más rápida que la CPU. Si no, CPU.
  "cpu"    Siempre la CPU (numba, calcindep.ccc).
  nombre   Usa la GPU con ese nombre si ha superado la comprobación de
           precisión, aunque no sea más rápida. Si no existe, CPU.

Comprobación automática: la primera vez que se usa una GPU (y de nuevo si
cambia el modelo, el driver o el código del kernel) se calcula un maniquí con
la GPU y con la CPU. La GPU se acepta si la diferencia máxima es menor que
TOLERANCE_PCT de la dosis máxima. El resultado se guarda en gpu.json, en la
carpeta de ajustes, así que cada ordenador decide según su propia GPU.

Si la GPU falla durante un cálculo (memoria, driver...), ese cálculo y los
siguientes de la sesión continúan en la CPU, y se añade un aviso al resultado.

El kernel es la misma recursión que calcindep.ccc en simple precisión. Para
x = a·ρ·Δs < 0.1 se usan los desarrollos en serie de 1 - e^-x y de
1 - (1 - e^-x)/x, que en simple precisión pierden casi todas las cifras en
pulmón y con el exponente de largo alcance del kernel. En un VMAT real la
diferencia con la CPU fue como máximo del 0.0011% de la dosis máxima en la
zona de más del 10% (0.0055% en el aire del inmovilizador).

En la capa exterior de vóxeles de la rejilla de cálculo la diferencia puede ser
mayor (hasta un 0.04% de la dosis máxima en un cubo de agua): hay líneas de
transporte que pasan justo por la cara del volumen, y si cuentan o no lo decide
el redondeo (también en la CPU, que depende del ruido de 1e-16 de las
direcciones). La rejilla de cálculo es el External con 20 mm de margen, así que
esa capa suele ser aire.
"""
import hashlib
import json
import logging
import os
import threading
import time
from dataclasses import asdict, dataclass

import numpy as np

from .ccc import _basis
from .ccc import superpose as cpu_superpose

log = logging.getLogger(__name__)

TOLERANCE_PCT = 0.01        # diferencia máxima admitida en la comprobación (% de la dosis máxima)
MIN_SPEEDUP = 1.2           # en modo automático, la GPU debe ser al menos esto más rápida
PRECISION = "fp32"
TEST_VOX_MM = 4.0           # vóxel del maniquí de la comprobación

_LOCK = threading.RLock()
_CACHE = {}
_DEFAULT_MODE = "auto"


# ----------------------------------------------------------------------------
# Kernels OpenCL (traducción de _sweep y _gather de calcindep/ccc.py)
# ----------------------------------------------------------------------------
CL_SRC = r"""
#ifdef USE_FP64
#pragma OPENCL EXTENSION cl_khr_fp64 : enable
typedef double real;
#else
typedef float real;
#endif

inline int slab(real bx, real by, real bz, real dx, real dy, real dz,
                real lx, real ly, real lz, real hx, real hy, real hz,
                real *smin_out, real *smax_out)
{
    real smin = -1e30, smax = 1e30;
    real b[3] = {bx, by, bz};
    real d[3] = {dx, dy, dz};
    real lo[3] = {lx, ly, lz};
    real hi[3] = {hx, hy, hz};
    for (int ax = 0; ax < 3; ax++) {
        if (fabs(d[ax]) < (real)1e-12) {
            if (b[ax] < lo[ax] || b[ax] > hi[ax]) return 0;
        } else {
            real t1 = (lo[ax] - b[ax]) / d[ax];
            real t2 = (hi[ax] - b[ax]) / d[ax];
            if (t1 > t2) { real t = t1; t1 = t2; t2 = t; }
            if (t1 > smin) smin = t1;
            if (t2 < smax) smax = t2;
        }
    }
    *smin_out = smin; *smax_out = smax;
    return smax > smin;
}

inline void trilinear2(__global const float *A, __global const float *B,
                       int nz, int ny, int nx, real fz, real fy, real fx,
                       real *ra, real *rb)
{
    if (fx < (real)-0.5 || fy < (real)-0.5 || fz < (real)-0.5 ||
        fx > nx - (real)0.5 || fy > ny - (real)0.5 || fz > nz - (real)0.5) {
        *ra = 0; *rb = 0; return;
    }
    fx = fmin(fmax(fx, (real)0), (real)(nx - 1));
    fy = fmin(fmax(fy, (real)0), (real)(ny - 1));
    fz = fmin(fmax(fz, (real)0), (real)(nz - 1));
    int i0 = (int)fx, j0 = (int)fy, k0 = (int)fz;
    if (i0 >= nx - 1) i0 = nx > 1 ? nx - 2 : 0;
    if (j0 >= ny - 1) j0 = ny > 1 ? ny - 2 : 0;
    if (k0 >= nz - 1) k0 = nz > 1 ? nz - 2 : 0;
    real tx = fx - i0, ty = fy - j0, tz = fz - k0;
    int i1 = min(i0 + 1, nx - 1), j1 = min(j0 + 1, ny - 1), k1 = min(k0 + 1, nz - 1);
    real w000 = (1 - tz) * (1 - ty) * (1 - tx), w001 = (1 - tz) * (1 - ty) * tx;
    real w010 = (1 - tz) * ty * (1 - tx),       w011 = (1 - tz) * ty * tx;
    real w100 = tz * (1 - ty) * (1 - tx),       w101 = tz * (1 - ty) * tx;
    real w110 = tz * ty * (1 - tx),             w111 = tz * ty * tx;
    long s1 = nx, s2 = (long)nx * ny;
    long b000 = k0 * s2 + j0 * s1 + i0, b001 = k0 * s2 + j0 * s1 + i1;
    long b010 = k0 * s2 + j1 * s1 + i0, b011 = k0 * s2 + j1 * s1 + i1;
    long b100 = k1 * s2 + j0 * s1 + i0, b101 = k1 * s2 + j0 * s1 + i1;
    long b110 = k1 * s2 + j1 * s1 + i0, b111 = k1 * s2 + j1 * s1 + i1;
    *ra = w000 * A[b000] + w001 * A[b001] + w010 * A[b010] + w011 * A[b011]
        + w100 * A[b100] + w101 * A[b101] + w110 * A[b110] + w111 * A[b111];
    *rb = w000 * B[b000] + w001 * B[b001] + w010 * B[b010] + w011 * B[b011]
        + w100 * B[b100] + w101 * B[b101] + w110 * B[b110] + w111 * B[b111];
}

// Una línea de transporte por hilo. lat se guarda como (ns, nu*nv) para que
// hilos vecinos escriban en posiciones contiguas.
__kernel void sweep(__global const float *T, __global const float *R,
                    int nz, int ny, int nx, real spx, real spy, real spz,
                    real dx, real dy, real dz, real e1x, real e1y, real e1z,
                    real e2x, real e2y, real e2z,
                    real u0, real v0, real s0, real h, real ds,
                    int nu, int nv, int ns,
                    __global const real *Aall, __global const real *aall, int dir,
                    real blx, real bly, real blz, real bhx, real bhy, real bhz,
                    real tlx, real tly, real tlz, real thx, real thy, real thz,
                    __global float *lat)
{
    int line = get_global_id(0);
    int nl = nu * nv;
    if (line >= nl) return;
    int iu = line / nv, iv = line - iu * nv;
    real bu = u0 + iu * h, bv = v0 + iv * h;
    real bx = bu * e1x + bv * e2x, by = bu * e1y + bv * e2y, bz = bu * e1z + bv * e2z;
    real smin, smax, tmin, tmax;
    int k_in = 0, k_out = 0;
    if (slab(bx, by, bz, dx, dy, dz, blx, bly, blz, bhx, bhy, bhz, &smin, &smax) &&
        slab(bx, by, bz, dx, dy, dz, tlx, tly, tlz, thx, thy, thz, &tmin, &tmax)) {
        if (tmin > smin) smin = tmin;
        k_in = (int)floor((smin - s0) / ds);
        k_out = (int)ceil((smax - s0) / ds);
        if (k_in < 0) k_in = 0;
        if (k_out > ns) k_out = ns;
        if (k_out < k_in) k_out = k_in;
    }
    for (int k = 0; k < k_in; k++) lat[(long)k * nl + line] = 0.0f;
    for (int k = k_out; k < ns; k++) lat[(long)k * nl + line] = 0.0f;
    real F[NCOMP], Aj[NCOMP], aj[NCOMP];
    for (int j = 0; j < NCOMP; j++) {
        F[j] = 0; Aj[j] = Aall[dir * NCOMP + j]; aj[j] = aall[dir * NCOMP + j];
    }
    for (int k = k_in; k < k_out; k++) {
        real s = s0 + (k + (real)0.5) * ds;
        real px = bx + s * dx, py = by + s * dy, pz = bz + s * dz;
        real t, r;
        trilinear2(T, R, nz, ny, nx, pz / spz, py / spy, px / spx, &t, &r);
        real dl = r * ds;
        real dose = 0;
        for (int j = 0; j < NCOMP; j++) {
            real x = aj[j] * dl;
#ifdef USE_FP64
            real e, f1;
            if (x < (real)1e-5) { e = 1 - x; f1 = 1 - (real)0.5 * x; }
            else { e = exp(-x); f1 = (1 - e) / x; }
            dose += Aj[j] * (F[j] * f1 + (t / aj[j]) * (1 - f1));
            F[j] = F[j] * e + t * (1 - e) / aj[j];
#else
            // om = 1 - e^-x ; g = 1 - (1 - e^-x)/x. En simple precisión se usan
            // sus desarrollos en serie para x < 0.1 (error de truncado < 1e-10).
            real om, g;
            if (x < 0.1f) {
                om = x * (1.0f - x * (0.5f - x * (1.0f / 6 - x * (1.0f / 24 - x * (1.0f / 120 - x / 720)))));
                g = x * (0.5f - x * (1.0f / 6 - x * (1.0f / 24 - x * (1.0f / 120 - x * (1.0f / 720 - x / 5040)))));
            } else {
                om = 1 - exp(-x);
                g = 1 - om / x;
            }
            dose += Aj[j] * (F[j] * (1 - g) + (t / aj[j]) * g);
            F[j] = F[j] * (1 - om) + t * om / aj[j];
#endif
        }
        lat[(long)k * nl + line] = (float)dose;
    }
}

__kernel void gather(__global const float *lat, int nz, int ny, int nx,
                     real spx, real spy, real spz,
                     real dx, real dy, real dz, real e1x, real e1y, real e1z,
                     real e2x, real e2y, real e2z,
                     real u0, real v0, real s0, real h, real ds,
                     int nu, int nv, int ns,
                     __global const uchar *mask, __global real *outd)
{
    int i = get_global_id(0), j = get_global_id(1), k = get_global_id(2);
    if (i >= nx || j >= ny || k >= nz) return;
    long idx = ((long)k * ny + j) * nx + i;
    if (!mask[idx]) return;
    real px = i * spx, py = j * spy, pz = k * spz;
    real fu = (px * e1x + py * e1y + pz * e1z - u0) / h;
    real fv = (px * e2x + py * e2y + pz * e2z - v0) / h;
    real fs = (px * dx + py * dy + pz * dz - s0) / ds - (real)0.5;
    if (fu < 0 || fv < 0 || fs < 0 || fu > nu - 1 || fv > nv - 1 || fs > ns - 1) return;
    int iu = min((int)fu, nu - 2), iv = min((int)fv, nv - 2), is = min((int)fs, ns - 2);
    real tu = fu - iu, tv = fv - iv, ts = fs - is;
    long nl = (long)nu * nv;
    long l00 = (long)iu * nv + iv, l01 = l00 + 1, l10 = l00 + nv, l11 = l10 + 1;
    long a0 = (long)is * nl, a1 = a0 + nl;
    real val = (1 - tu) * (1 - tv) * (1 - ts) * lat[a0 + l00]
             + (1 - tu) * (1 - tv) * ts * lat[a1 + l00]
             + (1 - tu) * tv * (1 - ts) * lat[a0 + l01]
             + (1 - tu) * tv * ts * lat[a1 + l01]
             + tu * (1 - tv) * (1 - ts) * lat[a0 + l10]
             + tu * (1 - tv) * ts * lat[a1 + l10]
             + tu * tv * (1 - ts) * lat[a0 + l11]
             + tu * tv * ts * lat[a1 + l11];
    outd[idx] += val;
}
"""

KERNEL_ID = hashlib.sha1(CL_SRC.encode("utf-8")).hexdigest()[:12]


# ----------------------------------------------------------------------------
# Dispositivos
# ----------------------------------------------------------------------------
@dataclass
class DeviceInfo:
    name: str
    vendor: str
    platform: str
    driver: str
    version: str
    kind: str              # "GPU" o "CPU"
    compute_units: int
    memory_gb: float
    fp64: bool

    @property
    def key(self):
        return f"{self.platform}|{self.name}|{self.driver}|{PRECISION}|{KERNEL_ID}"


def _allow_cpu_devices():
    """Solo para pruebas: aceptar dispositivos OpenCL de tipo CPU."""
    return os.environ.get("CALCINDEP_OPENCL_CPU", "") == "1"


def list_devices():
    """Dispositivos OpenCL utilizables: ([(DeviceInfo, dispositivo pyopencl)], motivo si no hay ninguno)."""
    try:
        import pyopencl as cl
    except Exception as e:  # noqa: BLE001
        return [], f"pyopencl no está instalado ({e.__class__.__name__})"
    try:
        platforms = cl.get_platforms()
    except Exception as e:  # noqa: BLE001
        return [], f"no hay ninguna plataforma OpenCL ({e})"
    out = []
    for p in platforms:
        try:
            devs = p.get_devices()
        except Exception:  # noqa: BLE001
            continue
        for d in devs:
            is_gpu = bool(d.type & cl.device_type.GPU)
            if not is_gpu and not _allow_cpu_devices():
                continue
            info = DeviceInfo(name=d.name.strip(), vendor=d.vendor.strip(), platform=p.name.strip(),
                              driver=str(d.driver_version).strip(), version=d.version.strip(),
                              kind="GPU" if is_gpu else "CPU", compute_units=int(d.max_compute_units),
                              memory_gb=round(d.global_mem_size / 2 ** 30, 1),
                              fp64="cl_khr_fp64" in d.extensions)
            out.append((info, d))
    if not out:
        return [], "no hay ninguna GPU con OpenCL"
    return out, ""


# ----------------------------------------------------------------------------
# Superposición en OpenCL
# ----------------------------------------------------------------------------
class CLSuperposer:
    """Misma interfaz y misma geometría de red que calcindep.ccc.superpose."""

    def __init__(self, device, precision=PRECISION):
        import pyopencl as cl
        self.cl = cl
        self.device = device
        self.fp64 = precision == "fp64"
        self.real = np.float64 if self.fp64 else np.float32
        self.ctx = cl.Context([device])
        self.queue = cl.CommandQueue(self.ctx)
        self._programs = {}

    def _kernels(self, ncomp):
        if ncomp not in self._programs:
            opts = [f"-DNCOMP={int(ncomp)}"] + (["-DUSE_FP64"] if self.fp64 else [])
            prg = self.cl.Program(self.ctx, CL_SRC).build(options=opts)
            self._programs[ncomp] = (self.cl.Kernel(prg, "sweep"), self.cl.Kernel(prg, "gather"))
        return self._programs[ncomp]

    def superpose(self, terma, rho, spacing_cm, directions, A, a, mask=None,
                  line_spacing_cm=None, step_cm=None, margin_vox=2):
        cl = self.cl
        mf = cl.mem_flags
        rl = self.real
        T = np.ascontiguousarray(terma, dtype=np.float32)
        R = np.ascontiguousarray(rho, dtype=np.float32)
        sp = np.asarray(spacing_cm, float)
        nz, ny, nx = T.shape
        if mask is None:
            mask = np.ones(T.shape, dtype=np.bool_)
        M = np.ascontiguousarray(mask, dtype=np.uint8)
        h = float(line_spacing_cm or sp.min())
        ds = float(step_cm or sp.min())
        m = margin_vox * sp
        box_lo = -0.5 * sp - m
        box_hi = np.array([(nx - 0.5) * sp[0], (ny - 0.5) * sp[1], (nz - 0.5) * sp[2]]) + m
        corners = np.array([[x, y, z] for x in (box_lo[0], box_hi[0])
                            for y in (box_lo[1], box_hi[1]) for z in (box_lo[2], box_hi[2])])
        nzT = np.nonzero(np.asarray(terma) > 0)
        if nzT[0].size == 0:
            return np.zeros(T.shape, dtype=np.float64)
        t_lo = np.array([nzT[2].min() - 1.0, nzT[1].min() - 1.0, nzT[0].min() - 1.0]) * sp
        t_hi = np.array([nzT[2].max() + 1.0, nzT[1].max() + 1.0, nzT[0].max() + 1.0]) * sp
        geo = []
        maxlat = 0
        for n in range(directions.shape[0]):
            d, e1, e2 = _basis(np.asarray(directions[n], float))
            pu, pv, ps = corners @ e1, corners @ e2, corners @ d
            u0, v0, s0 = pu.min(), pv.min(), ps.min()
            nu = int(np.ceil((pu.max() - u0) / h)) + 1
            nv = int(np.ceil((pv.max() - v0) / h)) + 1
            ns = int(np.ceil((ps.max() - s0) / ds)) + 1
            geo.append((d, e1, e2, u0, v0, s0, nu, nv, ns))
            maxlat = max(maxlat, nu * nv * ns)
        k_sweep, k_gather = self._kernels(A.shape[1])
        bT = cl.Buffer(self.ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=T)
        bR = cl.Buffer(self.ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=R)
        bM = cl.Buffer(self.ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=M)
        bA = cl.Buffer(self.ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=np.ascontiguousarray(A, dtype=rl))
        ba = cl.Buffer(self.ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=np.ascontiguousarray(a, dtype=rl))
        outh = np.zeros(T.shape, dtype=rl)
        bO = cl.Buffer(self.ctx, mf.READ_WRITE | mf.COPY_HOST_PTR, hostbuf=outh)
        bL = cl.Buffer(self.ctx, mf.READ_WRITE, size=4 * maxlat)
        try:
            I = np.int32
            r = rl
            spr = [r(x) for x in sp]
            blo = [r(x) for x in box_lo]
            bhi = [r(x) for x in box_hi]
            tlo = [r(x) for x in t_lo]
            thi = [r(x) for x in t_hi]
            wg = 64
            for n, (d, e1, e2, u0, v0, s0, nu, nv, ns) in enumerate(geo):
                common = ([r(x) for x in d] + [r(x) for x in e1] + [r(x) for x in e2]
                          + [r(u0), r(v0), r(s0), r(h), r(ds), I(nu), I(nv), I(ns)])
                k_sweep.set_args(bT, bR, I(nz), I(ny), I(nx), *spr, *common, bA, ba, I(n),
                                 *blo, *bhi, *tlo, *thi, bL)
                nl = nu * nv
                cl.enqueue_nd_range_kernel(self.queue, k_sweep, ((nl + wg - 1) // wg * wg,), (wg,))
                k_gather.set_args(bL, I(nz), I(ny), I(nx), *spr, *common, bM, bO)
                cl.enqueue_nd_range_kernel(self.queue, k_gather, (nx, ny, nz), None)
            cl.enqueue_copy(self.queue, outh, bO)
            self.queue.finish()
        finally:
            for b in (bT, bR, bM, bA, ba, bO, bL):
                b.release()
        return outh.astype(np.float64)


# ----------------------------------------------------------------------------
# Comprobación automática y registro por ordenador
# ----------------------------------------------------------------------------
def registry_path():
    from .gui.settings import config_dir
    return config_dir() / "gpu.json"


def load_registry():
    try:
        d = json.loads(registry_path().read_text(encoding="utf-8"))
        return d.get("devices", {})
    except (OSError, ValueError):
        return {}


def _save_record(key, rec):
    p = registry_path()
    with _LOCK:
        reg = load_registry()
        reg[key] = rec
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps({"devices": reg}, indent=2, ensure_ascii=False), encoding="utf-8")
        except OSError as e:
            log.warning("No se puede guardar %s: %s", p, e)


def _test_case(vox_mm=None):
    """Maniquí de tórax 30 x 30 x 24 cm (agua, pulmón, hueso y aire) con un campo 10 x 10."""
    from .beam_model import BeamModel, default_model_path
    from .kernels import build_cone_set, load_edk, polyenergetic_kernel
    m = BeamModel.from_json(default_model_path())
    edk = load_edk()
    k = polyenergetic_kernel(edk, m.energies, m.weights, m.kernel_weight_depth_cm)
    cs = build_cone_set(k, edk.angle_edges, edk.radius_edges, n_comp=m.kernel_components)
    sp = (vox_mm or TEST_VOX_MM) / 10.0
    nx, ny, nz = int(round(30 / sp)), int(round(30 / sp)), int(round(24 / sp))
    x = (np.arange(nx) - (nx - 1) / 2) * sp
    y = (np.arange(ny) - (ny - 1) / 2) * sp
    z = (np.arange(nz) - (nz - 1) / 2) * sp
    Z, Y, X = np.meshgrid(z, y, x, indexing="ij")
    body = X ** 2 + Y ** 2 <= 13.0 ** 2
    rho = np.where(body, 1.0, 0.001)
    rho[body & (Y > -9) & (Y < -1) & (X > -9) & (X < 2)] = 0.2
    rho[body & (np.abs(X - 1) < 1) & (Y > -12) & (Y < -10.5)] = 1.6
    rd = np.cumsum(rho, axis=1) * sp
    edge = lambda q: 0.5 * (1 + np.tanh((5.0 - np.abs(q)) / 0.3))  # noqa: E731
    T = edge(X) * edge(Z) * np.exp(-0.05 * rd) * (100.0 / (100.0 + Y)) ** 2 * (rho > 0.01) * rho
    u, w = np.array([1.0, 0, 0]), np.array([0, 1.0, 0])
    M = np.column_stack([u, np.cross(w, u), w])
    return T, rho, body, (sp, sp, sp), cs.directions @ M.T, cs.A, cs.a


def self_test(info, device, progress=None):
    """Calcula el maniquí con la GPU y con la CPU, guarda el resultado y lo devuelve."""
    if progress:
        progress(f"Comprobando la GPU {info.name} (solo la primera vez, unos segundos)")
    rec = {"nombre": info.name, "plataforma": info.platform, "driver": info.driver, "precision": PRECISION,
           "kernel": KERNEL_ID, "fecha": time.strftime("%Y-%m-%d %H:%M"), "valida": False,
           "mas_rapida": False, "dif_max_pct": None, "t_cpu_s": None, "t_gpu_s": None, "error": None}
    try:
        T, rho, body, sp, dirs, A, a = _test_case()
        Ts, rs, bs = T[::4, ::4, ::4], rho[::4, ::4, ::4], body[::4, ::4, ::4]
        sps = tuple(4 * s for s in sp)
        cpu_superpose(Ts, rs, sps, dirs[:2], A[:2], a[:2], mask=bs)          # compilación numba
        g = CLSuperposer(device)
        g.superpose(Ts, rs, sps, dirs[:2], A[:2], a[:2], mask=bs)           # compilación OpenCL

        def best(f, n=2):
            tb, res = 1e30, None
            for _ in range(n):
                t0 = time.perf_counter()
                res = f()
                tb = min(tb, time.perf_counter() - t0)
            return tb, res
        t_cpu, Dc = best(lambda: cpu_superpose(T, rho, sp, dirs, A, a, mask=body))
        t_gpu, Dg = best(lambda: g.superpose(T, rho, sp, dirs, A, a, mask=body))
        dmax = float(Dc[body].max())
        diff = float(np.abs(Dg - Dc)[body].max() / dmax * 100.0)
        rec.update(dif_max_pct=diff, t_cpu_s=round(t_cpu, 3), t_gpu_s=round(t_gpu, 3),
                   valida=bool(np.isfinite(diff) and diff <= TOLERANCE_PCT),
                   mas_rapida=bool(t_gpu * MIN_SPEEDUP < t_cpu))
    except Exception as e:  # noqa: BLE001
        log.warning("Fallo en la comprobación de la GPU %s: %s", info.name, e)
        rec["error"] = f"{e.__class__.__name__}: {e}"
    _save_record(info.key, rec)
    return rec


def describe_record(rec):
    if rec is None:
        return "sin comprobar"
    if rec.get("error"):
        return f"la comprobación falló ({rec['error']})"
    sp = rec["t_cpu_s"] / max(rec["t_gpu_s"], 1e-9)
    txt = (f"comprobada el {rec['fecha']}: diferencia máxima con la CPU {rec['dif_max_pct']:.5f} % de la dosis "
           f"máxima, {sp:.1f} veces la velocidad de la CPU")
    if not rec["valida"]:
        txt += f" — NO VÁLIDA (tolerancia {TOLERANCE_PCT:g} %)"
    elif not rec["mas_rapida"]:
        txt += " — no es más rápida que la CPU"
    return txt


def check_devices(force=False, progress=None):
    """Lista las GPU con el resultado de su comprobación; la hace si falta o si force."""
    devs, reason = list_devices()
    reg = load_registry()
    out = []
    for info, dev in devs:
        rec = reg.get(info.key)
        if force or rec is None:
            rec = self_test(info, dev, progress)
        out.append((info, rec))
    with _LOCK:
        _CACHE.clear()
    return out, reason


# ----------------------------------------------------------------------------
# Backend: lo que usa el motor
# ----------------------------------------------------------------------------
class Backend:
    def __init__(self, label, gpu=None, note=""):
        self._label = label
        self.gpu = gpu
        self.note = note          # por qué se usa la CPU, si es el caso
        self.failed = None
        self.warnings = []

    @property
    def is_gpu(self):
        return self.gpu is not None and self.failed is None

    def describe(self):
        if self.gpu is not None and self.failed is not None:
            return f"CPU (numba); la GPU falló en esta sesión: {self.failed}"
        if self.gpu is None:
            return "CPU (numba)" + (f"; {self.note}" if self.note else "")
        return self._label

    def short(self):
        """Dispositivo en uso, sin el motivo."""
        return self._label if self.is_gpu else "CPU (numba)"

    def superpose(self, *args, **kw):
        if self.is_gpu:
            try:
                with _LOCK:
                    return self.gpu.superpose(*args, **kw)
            except Exception as e:  # noqa: BLE001
                self.failed = f"{e.__class__.__name__}: {e}"
                msg = f"La GPU ha fallado ({self.failed}); el resto del cálculo se ha hecho en la CPU"
                log.warning(msg)
                self.warnings.append(msg)
        return cpu_superpose(*args, **kw)


def set_default_mode(mode):
    """Modo para los cálculos que no indican CalcOptions.gpu (lo fija la interfaz con el ajuste)."""
    global _DEFAULT_MODE
    _DEFAULT_MODE = mode or "auto"


def default_mode():
    return _DEFAULT_MODE


def get_backend(mode=None, progress=None):
    mode = mode or _DEFAULT_MODE
    with _LOCK:
        b = _CACHE.get(mode)
        if b is None:
            b = _make_backend(mode, progress)
            _CACHE[mode] = b
        return b


def _make_backend(mode, progress):
    if mode == "cpu":
        return Backend("CPU (numba)", note="elegido en los ajustes")
    devs, reason = list_devices()
    if mode != "auto":
        devs = [x for x in devs if x[0].name == mode]
        if not devs:
            return Backend("CPU (numba)", note=f"no se encuentra la GPU «{mode}» ({reason or 'otro modelo'})")
    if not devs:
        return Backend("CPU (numba)", note=reason)
    reg = load_registry()
    cands, notes = [], []
    for info, dev in devs:
        rec = reg.get(info.key) or self_test(info, dev, progress)
        ok = rec.get("valida") and not rec.get("error") and (mode != "auto" or rec.get("mas_rapida"))
        if ok:
            cands.append((rec["t_gpu_s"], info, dev))
        else:
            notes.append(f"{info.name}: {describe_record(rec)}")
    if not cands:
        return Backend("CPU (numba)", note="; ".join(notes))
    _, info, dev = min(cands, key=lambda c: c[0])
    try:
        g = CLSuperposer(dev)
    except Exception as e:  # noqa: BLE001
        return Backend("CPU (numba)", note=f"no se puede iniciar la GPU {info.name} ({e})")
    return Backend(f"GPU {info.name} (OpenCL, {PRECISION}, driver {info.driver})", gpu=g)


def device_summary():
    """Texto breve para la interfaz: GPU detectadas y su estado (sin hacer comprobaciones)."""
    devs, reason = list_devices()
    if not devs:
        return reason
    reg = load_registry()
    return "\n".join(f"{i.name} ({i.platform}, driver {i.driver}): {describe_record(reg.get(i.key))}"
                     for i, _ in devs)


def info_dict(info):
    return asdict(info)
