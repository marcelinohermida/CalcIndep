# CalcIndep · cálculo independiente de dosis con collapsed cone

**Español** · [English](README.en.md)

Versión 1.0. Manual de usuario: `docs/Manual_CalcIndep.pdf` (en el programa, menú
Ayuda o tecla F1). Este documento es la descripción técnica.

Herramienta en Python para verificar planes de radioterapia externa con fotones.
Importa el plan del TPS en DICOM (CT, RTSTRUCT, RTPLAN y RTDOSE), recalcula la
dosis con un algoritmo de convolución-superposición collapsed cone con
corrección de heterogeneidades y compara las dos distribuciones con el índice
gamma de Low et al. (1998), estructura por estructura. El resultado es un
informe HTML autocontenido y un RTDOSE con la dosis recalculada.

La interfaz y el manual están en español. Hay una versión para el navegador,
con los mismos algoritmos y resultados, que no necesita instalación
(CalcIndep webapp).

> Herramienta de desarrollo propio, sin certificación como producto sanitario.
> Antes de usarla en clínica hay que comisionar el modelo de haz de cada
> máquina y energía, cargar la curva HU–densidad electrónica del CT y validar
> el conjunto frente a medidas y frente al TPS.

## Contenido del repositorio

| Fichero o carpeta | Contenido |
|---|---|
| `calcindep/` | Código del programa |
| `data/` | Kernels EDKnrc, modelo de haz genérico 6X y curvas HU–densidad de ejemplo |
| `docs/` | Manual de usuario en PDF y su fuente (`docs/fuente_manual`) |
| `examples/` | Datos de haz sintéticos, configuraciones e informes de ejemplo |
| `CalcIndep.pyw` | Lanzador de la interfaz gráfica |
| `instalar_windows.bat` | Instalador para Windows |
| `instalar_gpu.bat` | Instalación opcional de la superposición en GPU |
| `environment.yml`, `requirements.txt` | Paquetes de Python necesarios |
| `LEEME_INSTALACION.txt` | Instrucciones de instalación resumidas |
| `LICENSE`, `THIRD_PARTY_NOTICES.txt` | Licencia del programa y de los componentes de terceros |

## Módulos

| Módulo | Función |
|---|---|
| `dicom_io.py` | Lectura de CT, RTSTRUCT (rasterizado de contornos), RTPLAN (puntos de control, mandíbulas, MLC) y RTDOSE |
| `geometry.py` | Rejillas y transformaciones IEC 61217 (gantry, colimador, mesa; HFS, HFP, FFS, FFP) |
| `hu_ed.py` | Curva número CT → densidad electrónica relativa (CSV editable) |
| `beam_model.py` | Modelo de haz en JSON (espectro, perfil radial, fuentes, parámetros de cada MLC, calibración) |
| `mlc.py` | Tipos de MLC (Millennium 120, HD120), identificación por los límites de láminas y franja lengüeta-ranura |
| `fluence.py` | Fluencia en el plano del isocentro para 3D-CRT, step-and-shoot, ventana deslizante y VMAT |
| `terma.py` | TERMA polienergético con trazado de rayos divergentes |
| `ccc.py` | Superposición collapsed cone con escalado por densidad (numba, paralelo) |
| `kernels.py` | Kernels EGSnrc/EDKnrc, kernel polienergético y ajuste exponencial por cono |
| `engine.py` | Motor: densidades, agrupación de incidencias, suma por haces |
| `gpu.py` | Superposición en GPU (OpenCL, opcional): detección, comprobación frente a la CPU y vuelta a la CPU si falla |
| `gamma.py` | Gamma 3D de Low (global o local) y estadísticos por estructura |
| `pipeline.py`, `report.py` | Flujo de verificación e informe HTML |
| `commissioning/` | Lectura de golden beam data (w2CAD, CSV), ajuste del modelo e informe |
| `synthetic.py` | Casos DICOM sintéticos para pruebas |
| `gui/` | Interfaz gráfica (tkinter): verificación, modelos, comisionado, curvas y ajustes |

## Instalación en Windows

1. Si el ordenador no tiene conda, instale Miniforge (https://conda-forge.org/download,
   opción «Just Me»). Se recomienda frente a Anaconda porque solo usa el canal
   libre conda-forge.
2. Descargue el repositorio (botón **Code → Download ZIP**, o `git clone`) y
   descomprímalo en una carpeta fija (sin tildes en la ruta). Antes de
   descomprimir el ZIP: clic derecho → Propiedades → «Desbloquear».
3. Haga doble clic en `instalar_windows.bat`. El instalador:
   * localiza Miniforge, Miniconda o Anaconda;
   * crea el entorno `calcindep` con `environment.yml`. Si el proxy del hospital
     bloquea conda, usa el entorno base e instala con pip los paquetes que
     falten;
   * compila el motor de cálculo (1–2 minutos, solo esta vez);
   * crea los lanzadores `CalcIndep.bat` y `CalcIndep_diagnostico.bat` y un
     acceso directo en el escritorio.
4. Abra CalcIndep desde el acceso directo (o con doble clic en `CalcIndep.pyw`).
   Al momento aparece una ventana de carga; la primera vez puede tardar uno o
   dos minutos. Si el programa no arranca, muestra el error y lo guarda en
   `error_arranque.txt`. Para ver todos los mensajes, ejecute
   `CalcIndep_diagnostico.bat`, que abre el programa con consola y guarda la
   salida en `diagnostico.txt`.

Instalación manual, si se prefiere: `conda env create -f environment.yml` y
después `pythonw -m calcindep.gui` desde la carpeta del programa. Con pip:
`pip install -r requirements.txt` (Python 3.10 o posterior, con tkinter).

### Superposición en GPU (opcional)

La superposición puede hacerse en la tarjeta gráfica con OpenCL. En el
portátil de desarrollo (Intel HD Graphics 520, i7-6500U) un VMAT de dos arcos
pasa de 590 s a 215 s, porque la superposición se hace unas 9 veces más
rápido. Si el ordenador no tiene GPU, o no tiene `pyopencl`, el programa
calcula en la CPU como siempre; no hace falta cambiar nada.

* **Instalación**: `instalar_gpu.bat` añade `pyopencl` al entorno `calcindep`
  sin actualizar los demás paquetes (`--freeze-installed`), comprueba que el
  programa sigue funcionando y prueba la GPU. Si algo falla, indica cómo
  volver al estado anterior del entorno.
* **Elección automática**: la primera vez que se usa una GPU, y de nuevo si
  cambia el modelo, el driver o el código del kernel, se calcula un maniquí
  de tórax con la GPU y con la CPU. La GPU se acepta si la diferencia máxima
  es menor del 0.01% de la dosis máxima. En modo automático solo se usa si
  además es al menos 1.2 veces más rápida. El resultado se guarda en
  `gpu.json`, en la carpeta de ajustes, así que cada ordenador decide según
  su propia GPU. Si hay varias GPU válidas se usa la más rápida.
* **Ajustes → Superposición en GPU**: «Automático», «Solo CPU» o una GPU
  concreta (se usa si supera la comprobación de precisión, aunque no sea más
  rápida). «Comprobar GPU de nuevo» repite la comprobación.
* **Si la GPU falla** durante un cálculo (memoria, driver), ese cálculo y
  los siguientes de la sesión continúan en la CPU y el resultado lleva un
  aviso.
* **Trazabilidad**: el informe y `resumen.json` indican dónde se hizo la
  superposición (dispositivo, precisión y driver).
* **Precisión**: la GPU calcula en simple precisión (fp32). Para
  x = a·ρ·Δs < 0.1 se usan los desarrollos en serie de 1 − e⁻ˣ y de
  1 − (1 − e⁻ˣ)/x, que en simple precisión pierden cifras en pulmón y con la
  componente de largo alcance del kernel. En el VMAT de prueba, la diferencia
  con la CPU fue como máximo del 0.0011% de la dosis máxima en la zona de más
  del 10%, ningún punto cambió de resultado gamma y el HDV cambió como mucho
  0.0001 cGy. En la capa exterior de vóxeles de la rejilla de cálculo la
  diferencia puede llegar al 0.04%, porque hay líneas de transporte que pasan
  justo por la cara del volumen y el redondeo decide si cuentan; esa capa
  suele ser aire (External con 20 mm de margen).
* Línea de comandos: `python -m calcindep gpu` muestra las GPU y su
  comprobación (`--comprobar` la repite); `python -m calcindep --gpu cpu
  verificar ...` fuerza la CPU.

## Uso con la interfaz gráfica

La ventana tiene cinco pestañas.

**Verificar plan**
1. «Examinar…» y elija la carpeta exportada de Eclipse (CT, RTSTRUCT, RTPLAN y
   RTDOSE). Puede contener varios planes; se elige en la lista «Plan».
2. Revise los haces y el modelo de haz asignado a cada uno. El programa elige
   primero el modelo marcado como «Default» en «Modelos de haz» (si es de la
   misma energía y modo de fluencia que el haz) y, si no lo hay, el modelo por
   máquina, energía y modo de fluencia; con doble clic en un haz se cambia el
   modelo de todos los haces de esa máquina y energía, y la elección se
   recuerda.
3. Elija la curva HU–densidad. La curva queda asociada al escáner del CT y se
   propone sola en los planes siguientes del mismo escáner.
4. Si hace falta, asigne densidades a estructuras (mesa, bolus) con
   «Densidades por estructura…».
5. Ajuste el criterio gamma y pulse «Calcular y comparar». La barra muestra el
   avance y el tiempo restante estimado; «Cancelar» detiene el cálculo.
6. Resultados: veredicto global, tabla por estructura (gamma y diferencias de
   Dmedia, D95, D2 y Dmáx), visor de cortes con TPS, cálculo, diferencia y
   gamma (lectura de valores con el cursor), DVH comparado, e informe HTML.
   En el visor, el botón «Perfil» activa la herramienta de perfiles: con la
   dirección «Libre» se arrastra una línea sobre cualquiera de las imágenes y
   con «Horizontal» o «Vertical» basta un clic. Funciona en los cortes axial,
   coronal y sagital, y muestra la dosis del TPS y la de CalcIndep a lo largo
   de la línea, con la diferencia en % de la normalización. El botón
   «Maximizar visor» (también en la pestaña DVH) oculta el panel izquierdo.
   El plan cumple si el porcentaje de puntos con γ ≤ 1 alcanza el umbral de
   aprobación dentro del External **y** en cada estructura anatómica con al
   menos 10 puntos evaluados (no cuentan las de tipo SUPPORT, MARKER, BOLUS y
   similares). Así, un fallo localizado en el PTV no queda oculto por un buen
   resultado global.
   Cada verificación se guarda en una carpeta propia dentro de «resultados»
   con el informe, el RTDOSE calculado y un `resumen.json`.

**Modelos de haz**: lista de modelos de la biblioteca. La casilla «Default»
marca el modelo que se usa por defecto en las verificaciones (solo uno a la
vez; un segundo clic la desmarca). Permite revisar y
editar los parámetros, recalibrar las UM, duplicar, importar y eliminar. Si se
cambia un parámetro físico, el modelo se recalibra al guardar.

**Comisionado**: crea un modelo a partir de datos medidos. Lee los datos de
Varian para Eclipse (ficheros w2CAD `OPD`, `OPP` y `DPR`, y la tabla 2D de
factores de campo `06X_00.txt`). Las curvas de cuña (`WDD`, `WDP`, `WLP`) se
descartan, porque el modelo describe campos abiertos. Los perfiles medidos solo
a un lado del eje se reflejan para el ajuste. Con perfiles diagonales de campos
grandes se ajusta el colimador primario circular, que redondea sus esquinas.
El ablandamiento fuera de eje se elige con los perfiles profundos (15 cm o
más) del campo mayor y de los campos de unos 10, 15 y 25 cm, reajustando el
perfil radial para cada valor; si el mínimo queda en el extremo de la rejilla
de búsqueda, la búsqueda se amplía, y al final se afina con una interpolación
parabólica. Se prueban dos formas, lineal y cuadrática con el radio, y se
queda la que reproduce mejor esos perfiles.
1. Nombre del modelo, máquina (igual que `TreatmentMachineName` en el plan),
   energía y modo de fluencia.
2. Curvas: ficheros w2CAD de los golden beam data o CSV de dos columnas
   (se piden campo, DFS, profundidad y eje).
3. Factores de campo (CSV `campo_x_mm, campo_y_mm, factor`) con su DFS y
   profundidad de medida.
4. Parámetros de cada MLC que use la máquina: transmisión, DLG y ancho de la
   zona lengüeta-ranura (valores de la configuración de Eclipse; no se ajustan).
5. Condiciones de calibración de las UM.
6. «Comisionar». Al terminar, el modelo queda en la biblioteca y se muestra la
   comparación con cada curva medida y el informe de comisionado. La
   configuración se puede guardar para repetir el comisionado.

El repositorio no incluye datos de haz de ninguna máquina real. Los datos de
`examples/gbd_sintetico` son sintéticos y sirven para probar el comisionado.

**Curvas HU–densidad**: crear, importar, editar punto a punto y validar
curvas; gestionar la asociación entre escáneres y curvas.

**Ajustes**: carpeta de la biblioteca (puede estar en red para compartir
modelos y curvas en el servicio), carpeta de resultados, número de hilos y
opciones de cálculo.

La biblioteca se crea por defecto en `Documentos\calcindep`, con las
subcarpetas `modelos`, `curvas_hu`, `comisionado` y `resultados`. La primera
vez se copian el modelo genérico 6X y la curva de ejemplo. Los ajustes y el
registro de errores están en `%APPDATA%\calcindep`.

## Uso desde la línea de comandos (opcional)

```
python -m calcindep comisionar examples/gbd_sintetico/comisionado.json
python -m calcindep verificar CARPETA --modelo data/beam_models/generico_6X.json --curva data/hu_ed/curva_ejemplo.csv --gamma 3,2 --umbral 10
python -m calcindep caso-sintetico prueba_vmat --tecnica VMAT
```

`python -m calcindep` sin argumentos abre la interfaz gráfica. Las
configuraciones en JSON tienen ejemplos en `examples/`.

### Recomendaciones de exportación

* Exporte la dosis de plan (DoseSummationType PLAN). Si solo hay dosis por
  haz, se suman automáticamente.
* La matriz de dosis del TPS define la rejilla de cálculo. El TERMA se traza
  a través de todo el CT, de modo que la atenuación es correcta aunque la
  matriz de dosis no cubra todo el paciente.
* Si el RTSTRUCT no incluye la densidad asignada a la mesa, asígnela en
  «Densidades por estructura…».

## Descripción del cálculo

**Densidades.** El CT se convierte a densidad electrónica relativa con la
curva HU–RED y se promedia en cada vóxel de la rejilla de cálculo (supermuestreo
3×3×3). Fuera del External se asigna aire, salvo las estructuras de tipo
SUPPORT (mesa). Las estructuras con densidad asignada en el RTSTRUCT
(`REL_ELEC_DENSITY`) se respetan.

**Fluencia.** Para cada par de puntos de control se calcula, de forma
analítica, la fracción de UM durante la que cada punto del plano del isocentro
está descubierto por mandíbulas y láminas (movimiento lineal entre puntos de
control). Se incluyen la transmisión del MLC, la DLG (desplazamiento de las
puntas de lámina), la transmisión de mandíbulas, el tamaño de la fuente
primaria, la fuente extrafocal y el perfil radial de fluencia. Los arcos se
dividen en incidencias de como máximo 2°.

**MLC.** El tipo de MLC de cada haz se identifica por los límites de las
láminas del RTPLAN (`LeafPositionBoundaries`): Millennium 120 (60 pares,
±200 mm) o HD120 (60 pares, ±110 mm). El modelo de haz guarda la transmisión,
la DLG y el ancho lengüeta-ranura de cada MLC y el cálculo usa los del MLC del
haz. Si el modelo no tiene los parámetros de ese MLC, o el MLC no se reconoce,
el cálculo no empieza y se indica qué haz falla. La transmisión es T_MLC bajo
las láminas, T_mandíbula bajo las mandíbulas y el producto de ambas donde se
superponen.

**Lengüeta-ranura.** En una franja de ancho total `tg_width_mm`, centrada en
cada límite entre láminas vecinas, un punto solo está descubierto cuando lo
están las dos láminas a la vez; el resto del tiempo recibe la transmisión del
MLC. El tiempo abierto se calcula de forma analítica (intersección de los
intervalos de las dos láminas). Cada fila del mapa de fluencia (0.5 mm) se
pondera por la fracción de su altura que cae en la franja. Con ancho 0 el
efecto no se modela, que es el valor de los modelos guardados antes de esta
opción.

**TERMA.** Se calcula para cada incidencia con trazado de rayos divergentes
desde la fuente, el espectro del modelo (12 energías), el ablandamiento fuera
de eje y la ley del inverso del cuadrado. El ablandamiento multiplica los
coeficientes de atenuación por 1 + s rⁿ, con r la distancia al eje en el plano
del isocentro (en cm, hasta `softening_rmax_cm`) y n = 1 (lineal, s en cm⁻¹)
o n = 2 (cuadrática, s en cm⁻²), según `softening_power` del modelo. La forma
cuadrática apenas actúa cerca del eje y crece hacia el borde de los campos
grandes. Los modelos guardados antes de esta opción son lineales.

**Superposición.** Collapsed cone (Ahnesjö 1989) con 94 direcciones por
incidencia, orientadas según el eje del haz. Los kernels son los de EDKnrc
agrupados en 13 bandas cenitales y ajustados a dos exponenciales por banda. El
transporte a lo largo de cada cono usa la distancia radiológica (escalado por
densidad electrónica), que es la corrección de heterogeneidades. En los arcos,
las incidencias se agrupan en sectores de 10° para la superposición (el TERMA
de cada incidencia se calcula con su propio ángulo). En una prueba con un arco
completo, sectores de 10° difieren como máximo un 0.17% (20°: 0.44%) del
cálculo con sectores de 3°, con un tiempo 3 y 5 veces menor.

**Inclinación del kernel.** En campos grandes los rayos del borde llegan con
un ángulo de hasta 11° respecto al eje (40×40 cm). Si el kernel se orienta
siempre según el eje, la dispersión hacia delante de los bordes se dirige
hacia dentro del campo: con los datos de Varian, la PDD del 40×40 a 30 cm
salía un 3% alta y la dosis fuera del campo a 30 cm, entre un 3% y un 6%
baja. Para corregirlo se definen direcciones nodales cada 10° vistas desde la
fuente (centradas en el eje). El TERMA de cada vóxel se reparte entre los
cuatro nodos que lo rodean con pesos bilineales según su ángulo, y cada parte
se superpone con el kernel orientado según su nodo. Con este reparto la
dirección efectiva del kernel varía de forma continua (un reparto en sectores
con bordes netos producía escalones del 3–5% en los perfiles). Solo se aplica
cuando el TERMA relevante sale de un cono de 4.5° de semiapertura (campos de
más de unos 16 cm); los campos menores se calculan igual que antes.
La diferencia entre el cálculo con y sin inclinación es suave, así que se
calcula en una rejilla de unos 5 mm y se interpola: frente al cálculo completo
en la rejilla fina difiere menos de un 0.3% dentro y fuera del campo y hasta
un 1.5% en la penumbra (equivale a menos de 0.2 mm), con un tiempo 4.5 veces
menor. Cada modelo indica si usa la inclinación (`kernel_tilt`); además se
controla con las opciones `kernel_tilt`, `tilt_tile_deg`, `tilt_min_halfangle_deg`
y `tilt_coarse_mm` de `CalcOptions`.

**Contaminación electrónica.** Término exponencial con la profundidad
radiológica, proporcional a la apertura suavizada.

**Calibración.** La dosis se pasa a cGy con el factor obtenido al calcular
las condiciones de referencia del modelo. Los factores de campo resultan del
propio cálculo (dispersión en maniquí por la superposición y dispersión en el
cabezal por la fuente extrafocal).

**Gamma.** Low et al., Med Phys 1998;25:656. Para cada punto de la referencia
(por defecto la dosis del TPS) por encima del umbral se busca el mínimo de
Γ en una red de desplazamientos de paso DTA/10 dentro de un radio de 2×DTA,
interpolando trilinealmente la distribución evaluada. Se calcula dentro del
External y se resume por estructura (porcentaje con γ ≤ 1, media, percentil
95 y máximo), junto con diferencias de Dmedia, D95, D2 y Dmáx.

## Pruebas realizadas

* Geometría IEC para las cuatro posiciones de paciente, mesa y colimador;
  fluencia analítica (estático, ventana deslizante, subdivisión de arcos);
  gamma frente a casos con solución conocida (desplazamiento puro, diferencia
  de dosis global y local); curva HU–RED; lectura y escritura DICOM.
* GPU (si hay un dispositivo OpenCL): misma dosis que la CPU en un maniquí y
  en agua (dentro del volumen, diferencia < 0.001% de la dosis máxima),
  comprobación y registro por dispositivo, uso de la CPU si no hay GPU, si
  la GPU no supera la comprobación o si falla durante el cálculo.
* Agua, modelo genérico 6X: PDD(10 cm) 10×10 = 66.9%, dmáx 16 mm; valores
  típicos de un 6 MV con filtro.
* Cadena completa con datos sintéticos: se generan golden beam data con un
  modelo "verdad", se comisiona a partir de ellos y se verifican planes cuya
  dosis "TPS" se calculó con el modelo verdad. Resultado con el modelo
  comisionado: gamma 3%/2 mm 100% en IMRT y VMAT, Dmedia del PTV +0.6%. Con el
  modelo genérico sin comisionar, la gamma en el PTV baja al 17–28% y la
  Dmedia sube un 4.9%, es decir, la verificación detecta el desajuste.
  Los informes están en `examples/informes_ejemplo`.

Estas pruebas comprueban la coherencia interna. Falta la validación frente a
medidas y frente a Eclipse con planes reales, que debe hacerse en el centro.

## Limitaciones conocidas

* Energías: los kernels incluidos llegan a 6 MeV, suficiente para 6X y 6FFF.
  Para 10X o 15X hay que añadir kernels hasta la energía máxima.
* Con los datos de Varian de un Clinac 6 MV (inclinación del kernel y
  ablandamiento cuadrático), 71 de las 77 curvas pasan la gamma 2%/2 mm en más
  del 97% de los puntos. Las que quedan por debajo son el perfil del 15×15 a
  30 cm (92.2%; hombro calculado un 1.5% bajo), el del 30×30 a 30 cm (95.2%) y
  los perfiles diagonales del 40×40 (90–92% a todas las profundidades, en la
  zona de las esquinas que recorta el colimador primario).
* El factor de campo del 3×3 sale un 1.6% alto respecto a la tabla de Varian.
  El kernel no es la causa (el ajuste exponencial y la discretización angular
  cambian ese factor menos de un 0.01%); las causas probables son el modelo de
  fuentes o el detector usado en la medida.
* La fuente extrafocal tiene anchuras distintas en X e Y, pero no modela por
  separado la posición de cada mandíbula.
* Sin modelo de cuñas físicas, cuñas dinámicas (EDW), bloques ni conos de
  radiocirugía: el plan se calcula sin ellos y el informe lo avisa.
* MLC: DLG constante, una sola transmisión por MLC (con el espectro del haz
  abierto) y franja lengüeta-ranura de ancho fijo con transmisión igual a la
  del MLC. No se modelan la forma de la punta ni la fuga entre láminas por
  separado. Solo Millennium 120 y HD120; los MLC de doble capa no se admiten.
* Los modelos guardados antes de los parámetros por MLC se cargan con su
  transmisión y DLG asignadas al Millennium 120 y sin lengüeta-ranura.
* El kernel no varía con el endurecimiento del espectro en profundidad ni
  con el ablandamiento fuera de eje.
* Los modelos guardados antes de la inclinación del kernel se cargan sin ella
  (opción del modelo `kernel_tilt`), para que calculen igual que cuando se
  validaron. Para usarla hay que comisionar de nuevo.
* Los medios se tratan como agua con densidad electrónica escalada; la dosis
  calculada es aproximadamente dosis en agua dentro del medio.
* La calibración depende ligeramente del tamaño de vóxel; el modelo se
  recalibra automáticamente si la rejilla del plan difiere más de 0.6 mm.

## Licencia

CalcIndep se distribuye bajo la licencia MIT (`LICENSE`). Los kernels EDKnrc
(repositorio conehead, licencia MIT) y los coeficientes de atenuación de NIST
XCOM conservan sus propias condiciones, que se recogen en
`THIRD_PARTY_NOTICES.txt`.

## Referencias

* Ahnesjö A. Collapsed cone convolution of radiant energy for photon dose
  calculation in heterogeneous media. Med Phys 1989;16:577-592.
* Mackie TR, Bielajew AF, Rogers DWO, Battista JJ. Generation of photon energy
  deposition kernels using the EGS Monte Carlo code. Phys Med Biol 1988;33:1-20.
* Low DA, Harms WB, Mutic S, Purdy JA. A technique for the quantitative
  evaluation of dose distributions. Med Phys 1998;25:656-661.
* Kernels EDKnrc: repositorio conehead (S. Peet, licencia MIT); ver
  `data/kernels/edknrc_mono/LEEME.md`.
* Coeficientes de atenuación del agua: NIST XCOM, Standard Reference Database 8.
