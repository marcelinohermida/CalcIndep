@echo off
setlocal enableextensions
cd /d "%~dp0"
echo ============================================================
echo   CalcIndep: superposicion en GPU (opcional)
echo ============================================================
echo.
echo Anade pyopencl al entorno calcindep sin actualizar los demas paquetes,
echo comprueba que el programa sigue funcionando y prueba la GPU frente a la CPU.
echo Si este ordenador no tiene GPU, CalcIndep seguira calculando en la CPU.
echo.

rem --- Localizar Anaconda o Miniconda ------------------------------------
set "CONDA_ROOT="
for %%D in ("%USERPROFILE%\miniforge3" "%LOCALAPPDATA%\miniforge3" "%ProgramData%\miniforge3" "C:\miniforge3" "%USERPROFILE%\miniconda3" "%USERPROFILE%\anaconda3" "%LOCALAPPDATA%\miniconda3" "%LOCALAPPDATA%\anaconda3" "%ProgramData%\miniconda3" "%ProgramData%\anaconda3" "C:\miniconda3" "C:\anaconda3") do (
    if not defined CONDA_ROOT if exist "%%~D\Scripts\activate.bat" set "CONDA_ROOT=%%~D"
)
if not defined CONDA_ROOT (
    echo No se ha encontrado Miniforge, Miniconda ni Anaconda. Ejecute antes instalar_windows.bat.
    pause
    exit /b 1
)
call "%CONDA_ROOT%\Scripts\activate.bat" "%CONDA_ROOT%"
call conda env list | findstr /r /c:"^calcindep " >nul
if errorlevel 1 (
    echo No existe el entorno calcindep. Ejecute antes instalar_windows.bat.
    pause
    exit /b 1
)
set "ENV_PREFIX="
for /f "usebackq delims=" %%P in (`conda run -n calcindep python -c "import sys; print(sys.prefix)"`) do set "ENV_PREFIX=%%P"
if not defined ENV_PREFIX (
    echo No se puede usar el entorno calcindep.
    pause
    exit /b 1
)
set "PY=%ENV_PREFIX%\python.exe"

rem --- Revision actual del entorno, para poder volver atras -------------
set "REV="
for /f "tokens=2 delims=()" %%R in ('conda list -n calcindep --revisions ^| findstr /c:"(rev "') do set "REV=%%R"
if defined REV set "REV=%REV:rev =%"
if defined REV echo Revision actual del entorno calcindep: %REV%

rem --- Instalar pyopencl ------------------------------------------------
"%PY%" -c "import pyopencl" >nul 2>&1
if errorlevel 1 (
    echo.
    echo Instalando pyopencl (sin cambiar los demas paquetes^)...
    call conda install -y -n calcindep -c conda-forge pyopencl --freeze-installed
    "%PY%" -c "import pyopencl" >nul 2>&1
    if errorlevel 1 (
        echo conda no ha podido instalarlo. Se intenta con pip...
        "%PY%" -m pip install pyopencl
    )
) else (
    echo pyopencl ya esta instalado.
)

rem --- Comprobar que CalcIndep sigue funcionando ------------------------
echo.
echo Comprobando los paquetes del programa...
"%PY%" -c "import numpy, scipy, numba, matplotlib, pydicom, skimage, tkinter, pyopencl; numpy.linalg.inv(numpy.eye(3)); print('Paquetes correctos')"
if errorlevel 1 (
    echo.
    echo ERROR: el entorno no funciona despues de la instalacion.
    if defined REV echo Para volver al estado anterior ejecute:  conda install -n calcindep --revision %REV%
    pause
    exit /b 1
)

rem --- Probar la GPU ----------------------------------------------------
echo.
echo Probando la GPU frente a la CPU (la primera vez compila el motor, 1-2 minutos)...
"%PY%" -m calcindep gpu --comprobar
echo.
echo La eleccion se puede cambiar en CalcIndep, pestana Ajustes, "Superposicion en GPU".
if defined REV echo Si quisiera deshacer la instalacion:  conda install -n calcindep --revision %REV%
pause
