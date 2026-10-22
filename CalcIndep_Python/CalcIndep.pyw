"""Lanzador de CalcIndep (doble clic o acceso directo con pythonw.exe).

Añade la carpeta del programa a sys.path, de modo que no depende de la
carpeta de trabajo con la que se lance.
"""
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
try:
    os.chdir(HERE)
except OSError:
    pass

from calcindep.gui.launcher import run  # noqa: E402

run()
