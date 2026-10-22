"""CalcIndep: cálculo independiente de dosis (collapsed cone) y comparación gamma."""
import os
import sys

__version__ = "1.0"


def _prepare_conda_dll_path():
    """En Windows, añade al PATH las carpetas de DLL del entorno de conda.

    Si se lanza python.exe o pythonw.exe del entorno sin activarlo (acceso
    directo, doble clic), las DLL que MKL carga por nombre en la primera
    operación de álgebra lineal pueden resolverse con otra versión instalada en
    el sistema, y el proceso se cierra con el error 0xc06d007f. Aquí se
    reproduce lo que hace «conda activate» con el PATH.
    """
    if not sys.platform.startswith("win"):
        return
    if getattr(sys, "frozen", False):
        return  # ejecutable de PyInstaller: las DLL ya están en su carpeta _internal
    prefix = sys.prefix
    if os.path.normcase(os.environ.get("CONDA_PREFIX", "")) == os.path.normcase(prefix):
        return  # entorno ya activado
    cands = [prefix,
             os.path.join(prefix, "Library", "mingw-w64", "bin"),
             os.path.join(prefix, "Library", "usr", "bin"),
             os.path.join(prefix, "Library", "bin"),
             os.path.join(prefix, "Scripts"),
             os.path.join(prefix, "bin")]
    dirs = [d for d in cands if os.path.isdir(d)]
    os.environ["PATH"] = os.pathsep.join(dirs + [os.environ.get("PATH", "")])
    os.environ["CONDA_PREFIX"] = prefix
    for d in dirs:
        try:
            os.add_dll_directory(d)
        except (OSError, AttributeError):
            pass


_prepare_conda_dll_path()
