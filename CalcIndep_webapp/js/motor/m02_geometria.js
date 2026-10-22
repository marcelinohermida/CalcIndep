/* CalcIndep web · rejillas y geometría IEC 61217 (geometry.py). */
CI_MOTOR_MODULOS.push(function CIMod_geometria(M) {
  "use strict";

  class Grid {
    // origin (x0, y0, z0), spacing (dx, dy, dz), shape (nz, ny, nx)
    constructor(origin, spacing, shape) {
      this.origin = Float64Array.from(origin, Number);
      this.spacing = Float64Array.from(spacing, Number);
      this.shape = Array.from(shape, v => Math.trunc(v));
    }
    get nx() { return this.shape[2]; }
    get ny() { return this.shape[1]; }
    get nz() { return this.shape[0]; }
    get size() { return this.shape[0] * this.shape[1] * this.shape[2]; }
    axes() {
      const ax = (o, s, n) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = o + s * i; return a; };
      return [ax(this.origin[0], this.spacing[0], this.nx), ax(this.origin[1], this.spacing[1], this.ny),
              ax(this.origin[2], this.spacing[2], this.nz)];
    }
    // (x, y, z) mm -> índices fraccionarios (k, j, i)
    worldToIndex(p) {
      return [(p[2] - this.origin[2]) / this.spacing[2], (p[1] - this.origin[1]) / this.spacing[1],
              (p[0] - this.origin[0]) / this.spacing[0]];
    }
    voxelVolumeCC() { return (this.spacing[0] * this.spacing[1] * this.spacing[2]) / 1000.0; }
    extent() {
      const [x, y, z] = this.axes();
      return [x[0], x[x.length - 1], y[0], y[y.length - 1], z[0], z[z.length - 1]];
    }
    crop(k0, k1, j0, j1, i0, i1) {
      const o = [this.origin[0] + this.spacing[0] * i0, this.origin[1] + this.spacing[1] * j0,
                 this.origin[2] + this.spacing[2] * k0];
      return new Grid(o, Array.from(this.spacing), [k1 - k0, j1 - j0, i1 - i0]);
    }
    minSpacing() { return Math.min(this.spacing[0], this.spacing[1], this.spacing[2]); }
    maxSpacing() { return Math.max(this.spacing[0], this.spacing[1], this.spacing[2]); }
    toObj() { return { origin: Array.from(this.origin), spacing: Array.from(this.spacing), shape: this.shape.slice() }; }
    static from(o) { return o instanceof Grid ? o : new Grid(o.origin, o.spacing, o.shape); }
    same(g) {
      return g && this.shape.every((v, i) => v === g.shape[i]) &&
        [0, 1, 2].every(i => this.origin[i] === g.origin[i] && this.spacing[i] === g.spacing[i]);
    }
  }
  M.Grid = Grid;

  function rotX(t) { const c = Math.cos(t), s = Math.sin(t); return [[1, 0, 0], [0, c, -s], [0, s, c]]; }
  function rotY(t) { const c = Math.cos(t), s = Math.sin(t); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; }
  function rotZ(t) { const c = Math.cos(t), s = Math.sin(t); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; }
  M.rotX = rotX; M.rotY = rotY; M.rotZ = rotZ;
  const IEC_TO_DICOM = {
    HFS: [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    HFP: [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    FFS: [[-1, 0, 0], [0, 0, -1], [0, -1, 0]],
    FFP: [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
  };
  M.iecTableToDicom = function (pp) {
    pp = (pp || "HFS").toUpperCase();
    if (!(pp in IEC_TO_DICOM)) throw new Error(`Posición de paciente no soportada: ${pp}`);
    return IEC_TO_DICOM[pp];
  };
  M.beamToDicomMatrix = function (gantry, coll, couch, pp) {
    const g = M.deg2rad(gantry), c = M.deg2rad(coll), t = M.deg2rad(couch);
    const mfb = M.matmul3(rotY(g), rotZ(c));
    const msf = M.transpose3(rotZ(t));
    return M.matmul3(M.matmul3(M.iecTableToDicom(pp), msf), mfb);
  };

  class BeamGeometry {
    constructor(iso, sad, gantry, coll, couch, pp) {
      this.iso = Float64Array.from(iso, Number);
      this.sad = +sad;
      this.gantry = +gantry; this.coll = +coll; this.couch = +couch;
      this.patient_position = pp || "HFS";
      this.m = M.beamToDicomMatrix(this.gantry, this.coll, this.couch, this.patient_position);
    }
    get source() {
      const v = M.matvec3(this.m, [0.0, 0.0, this.sad]);
      return [this.iso[0] + v[0], this.iso[1] + v[1], this.iso[2] + v[2]];
    }
    get axis() { return [-this.m[0][2], -this.m[1][2], -this.m[2][2]]; }
    get u() { return [this.m[0][0], this.m[1][0], this.m[2][0]]; }
    get v() { return [this.m[0][1], this.m[1][1], this.m[2][1]]; }
    toBev(p) {
      const s = this.source, ax = this.axis, u = this.u, v = this.v;
      const q = [p[0] - s[0], p[1] - s[1], p[2] - s[2]];
      const z = M.dot3(q, ax);
      return [M.dot3(q, u) * this.sad / z, M.dot3(q, v) * this.sad / z, z];
    }
    toObj() {
      return { iso: Array.from(this.iso), sad: this.sad, gantry: this.gantry, coll: this.coll, couch: this.couch,
               patient_position: this.patient_position };
    }
    static from(o) {
      return o instanceof BeamGeometry ? o : new BeamGeometry(o.iso, o.sad, o.gantry, o.coll, o.couch, o.patient_position);
    }
  }
  M.BeamGeometry = BeamGeometry;
});
