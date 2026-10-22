@echo off
setlocal enableextensions
cd /d "%~dp0"
echo ============================================================
echo   Instalacion de CalcIndep 1.0 (calculo independiente de dosis)
echo ============================================================
echo.

rem --- Localizar Anaconda o Miniconda ------------------------------------
set "CONDA_ROOT="
for %%D in ("%USERPROFILE%\miniforge3" "%LOCALAPPDATA%\miniforge3" "%ProgramData%\miniforge3" "C:\miniforge3" "%USERPROFILE%\anaconda3" "%USERPROFILE%\miniconda3" "%LOCALAPPDATA%\anaconda3" "%LOCALAPPDATA%\miniconda3" "%ProgramData%\anaconda3" "%ProgramData%\miniconda3" "C:\anaconda3" "C:\miniconda3" "C:\ProgramData\Anaconda3") do (
    if not defined CONDA_ROOT if exist "%%~D\Scripts\activate.bat" set "CONDA_ROOT=%%~D"
)
if not defined CONDA_ROOT (
    for /f "delims=" %%C in ('where conda.exe 2^>nul') do if not defined CONDA_ROOT set "CONDA_ROOT=%%~dpC.."
)
if not defined CONDA_ROOT (
    echo No se ha encontrado Miniforge, Miniconda ni Anaconda.
    echo.
    echo Instale Miniforge desde https://conda-forge.org/download
    echo ^(opcion "Just Me", no necesita permisos de administrador^)
    echo y despues vuelva a ejecutar este instalador.
    echo Si conda esta en otra carpeta, indiquela en CONDA_ROOT dentro de este fichero.
    pause
    exit /b 1
)
echo Conda encontrado en: %CONDA_ROOT%
call "%CONDA_ROOT%\Scripts\activate.bat" "%CONDA_ROOT%"

rem --- Crear o actualizar el entorno calcindep --------------------------
set "ENV_PREFIX="
call conda env list | findstr /r /c:"^calcindep " >nul
if errorlevel 1 (
    echo Creando el entorno "calcindep" (puede tardar varios minutos^)...
    call conda env create -f environment.yml
) else (
    echo Actualizando el entorno "calcindep"...
    call conda env update -f environment.yml
)
if errorlevel 1 goto :fallback
for /f "usebackq delims=" %%P in (`conda run -n calcindep python -c "import sys; print(sys.prefix)"`) do set "ENV_PREFIX=%%P"
if not defined ENV_PREFIX goto :fallback
goto :check

:fallback
echo.
echo No se ha podido crear el entorno "calcindep" (es habitual si el proxy bloquea conda^).
echo Se usara el entorno base de conda y se instalaran con pip los paquetes que falten.
call python -m pip install numpy scipy numba matplotlib scikit-image "pydicom>=2.4"
set "ENV_PREFIX=%CONDA_ROOT%"

:check
echo.
echo Comprobando paquetes en %ENV_PREFIX% ...
"%ENV_PREFIX%\python.exe" -c "import numpy, scipy, numba, matplotlib, pydicom, skimage, tkinter; print('Paquetes correctos')"
if errorlevel 1 (
    echo Faltan paquetes. Revise los mensajes anteriores.
    pause
    exit /b 1
)

rem --- Compilar el motor de calculo una vez (unos minutos) -------------
echo Preparando el motor de calculo y las fuentes de matplotlib (solo esta vez, 1-3 minutos)...
"%ENV_PREFIX%\python.exe" -c "import matplotlib.pyplot, calcindep.gui.verify_tab, calcindep.gui.commission_tab; from calcindep.gui.app import _warmup; _warmup(); print('Motor listo')"

rem --- Lanzador y acceso directo ---------------------------------------
(
    echo @echo off
    echo start "" "%ENV_PREFIX%\pythonw.exe" "%%~dp0CalcIndep.pyw"
) > "%~dp0CalcIndep.bat"
(
    echo @echo off
    echo echo Diagnostico de CalcIndep. Se abre el programa con consola; los mensajes quedan en diagnostico.txt
    echo "%ENV_PREFIX%\python.exe" -X faulthandler -c "import sys; print(sys.executable); print(sys.version); import numpy, scipy, numba, matplotlib, pydicom, skimage, tkinter; print('Paquetes correctos')" ^> "%%~dp0diagnostico.txt" 2^>^&1
    echo "%ENV_PREFIX%\python.exe" -X faulthandler "%%~dp0CalcIndep.pyw" ^>^> "%%~dp0diagnostico.txt" 2^>^&1
    echo type "%%~dp0diagnostico.txt"
    echo pause
) > "%~dp0CalcIndep_diagnostico.bat"
echo Creados CalcIndep.bat y CalcIndep_diagnostico.bat en esta carpeta.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$w = New-Object -ComObject WScript.Shell; $s = $w.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\CalcIndep.lnk'); $s.TargetPath = '%ENV_PREFIX%\pythonw.exe'; $s.Arguments = '\"%~dp0CalcIndep.pyw\"'; $s.WorkingDirectory = '%~dp0'; $s.Description = 'Calculo independiente de dosis'; $s.IconLocation = '%SystemRoot%\System32\shell32.dll,22'; $s.Save()"
if errorlevel 1 (
    echo No se ha podido crear el acceso directo en el escritorio. Use CalcIndep.bat.
) else (
    echo Creado el acceso directo CalcIndep en el escritorio.
)
echo.
echo Instalacion terminada.
echo Abra CalcIndep con el acceso directo del escritorio. El manual se abre con la tecla F1.
pause
