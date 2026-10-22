# CalcIndep webapp · cálculo independiente de dosis en el navegador

**Español** · [English](README.en.md)

Versión web 1.0 de CalcIndep. Cálculo independiente de dosis para radioterapia
externa con fotones: importa el plan del TPS en DICOM (CT, RTSTRUCT, RTPLAN y
RTDOSE), recalcula la dosis con un algoritmo collapsed cone con corrección de
heterogeneidades y compara las dos distribuciones con el índice gamma, estructura
por estructura.

Es la misma herramienta que la versión de escritorio en Python (mismos algoritmos
y mismos resultados), ejecutada en el navegador. No hay que instalar nada y los
datos no salen del ordenador: todo el cálculo se hace en local, sin servidor.
La interfaz y el manual están en español.

> Herramienta de desarrollo propio, sin certificación como producto sanitario.
> Antes de usarla en clínica hay que comisionar el modelo de haz de cada
> máquina y energía, cargar la curva HU–densidad electrónica del CT y validar
> el conjunto frente a medidas y frente al TPS.

## Cómo se abre

1. Descargue el repositorio (botón **Code → Download ZIP**, o `git clone`) y
   descomprímalo en el ordenador o en una carpeta de red. Las carpetas `js`,
   `css` y `manual` tienen que estar junto a `CalcIndep.html`.
2. Haga doble clic en `CalcIndep.html` (o arrástrelo a una ventana del navegador).
3. El manual se abre con la tecla F1 o en `manual/manual.html`.

## Navegadores

- Windows 10/11: Chrome o Edge actualizados (recomendado). Usan la GPU si la
  tarjeta gráfica supera la comprobación de precisión (WebGPU). Firefox también
  tiene WebGPU, pero en las pruebas fue más lento que la CPU, así que en Firefox
  el programa calcula en la CPU.
- Windows 7: Chrome 109 o Firefox 115 ESR. El cálculo se hace en la CPU.
- Firefox: la biblioteca se guarda en el navegador (no se puede elegir una carpeta).
  Use Archivo → Exportar la biblioteca (ZIP) para hacer copias de seguridad.

## Dónde se guardan los datos

Por defecto, en el almacenamiento del navegador de cada ordenador. En Chrome o
Edge se puede elegir una carpeta del disco o de la red (pestaña Ajustes),
compatible con la carpeta `Documentos\calcindep` de la versión de escritorio.

Los modelos de haz (JSON), las curvas HU (CSV) y las configuraciones de
comisionado de la versión de escritorio sirven sin cambios.

## Comprobar el programa en un ordenador nuevo

La carpeta `test_synthetic_plans` contiene dos planes sintéticos (3D y VMAT; no son
pacientes) con los resultados esperados, calculados con la versión de escritorio.
Las instrucciones están en `test_synthetic_plans/LEEME.txt` (en inglés,
`README.txt`). Los dos casos usan el modelo genérico 6X incluido en el programa.

## Estructura

| Fichero o carpeta | Contenido |
|---|---|
| `CalcIndep.html` | Página principal: comprueba la compatibilidad del navegador y carga los scripts |
| `js/datos.js` | Kernels EDKnrc, modelo genérico 6X y curvas HU de ejemplo |
| `js/motor/m00…m13` | Motor de cálculo traducido de Python paso a paso: numérico, física, geometría, kernels, plan, fluencia, TERMA, collapsed cone, motor, DICOM, gamma, verificación, GPU (WebGPU) y comisionado |
| `js/hilos.js` | Web Workers: un coordinador y un subhilo por núcleo, conectados por MessageChannel |
| `js/ui/` | Interfaz: pestañas, visor, DVH, informes HTML, biblioteca y diálogos |
| `css/` | Estilos de la interfaz |
| `manual/` | Manual de usuario (F1) |
| `test_synthetic_plans/` | Planes sintéticos de prueba |
| `LICENSE`, `THIRD_PARTY_NOTICES.txt` | Licencia del programa y de los componentes de terceros |

Los datos de contexto se envían una vez a cada subhilo y se liberan al terminar
cada cálculo (y en el comisionado, tras cada maniquí); además hay un límite de
512 MB. La aplicación no usa bibliotecas externas ni hace conexiones de red.

## Compatibilidad

- Chrome/Edge 109+ y Firefox 115+ (Windows 7: Chrome 109 y Firefox 115 ESR). Todo
  el código pasa un análisis sintáctico ES2021.
- Biblioteca en IndexedDB (todos los navegadores) o en una carpeta con File System
  Access (Chrome/Edge), con la misma estructura que `Documentos\calcindep`.
- GPU: WebGPU (Chrome/Edge 113+ en Windows 10/11). Misma regla que la versión de
  escritorio con OpenCL: diferencia < 0.01% de la dosis máxima en el maniquí de
  tórax y 1.2 veces más rápida en modo automático.
- Firefox reciente también tiene WebGPU en Windows, pero en el portátil de pruebas
  (Intel gen-9) la comprobación dio 0.6 veces la velocidad de la CPU, frente a 11.5
  veces en Chrome con la misma GPU. En Firefox el modo automático calcula en la
  CPU. Firefox no informa del modelo de GPU (aparece como «GPU WebGPU»).
  Recomendación: Chrome o Edge para usar la GPU.

## Comprobaciones realizadas frente a la versión de escritorio (19-10-2026)

| Prueba | Resultado frente a Python |
|---|---|
| Campos en agua (10×10, 30×30 con inclinación, 5×5 DFS 90) | dif. máx. 2.6e-9 relativa en el interior |
| Calibración genérico 6X (2.5 mm) | 38.15194049 frente a 38.15194050 cGy/unidad |
| 3D, rejilla 3 mm, gamma local, referencia cálculo (interfaz) | dif. dosis 1.1e-4 % de Dmáx; gamma 99.899 % idéntica |
| IMRT con densidades forzadas y curva Somatom | dif. dosis 1.1e-7 %; gamma 100 % idéntica |
| VMAT Millennium 120, modelo comisionado con inclinación y ablandamiento cuadrático (interfaz) | dif. dosis 2.7e-8 %; gamma idéntica; ningún punto cambia de lado; RTDOSE y resumen.json iguales |
| Comisionado sintético 5 mm (interfaz) | mismos parámetros (espectro con dif. relativa ≤ 1e-5 en los pesos principales); gamma de validación idéntica en las 15 curvas; factores de campo iguales |
| WebGPU, SwiftShader (Linux) | dif. con CPU 0.0001 % de Dmáx; caso 3D por GPU: gamma idéntica |
| WebGPU, Intel gen-9 (Windows, Chromium 152) | dif. con CPU 0.00014 % de Dmáx; 0.34 s frente a 3.4 s en un hilo de CPU |
| Superposición en rejilla clínica (136×96×80, 2.5 mm), mismo portátil | CPU 4 hilos 4.6 s, GPU 1.0 s |
| Comprobación de GPU en la aplicación, mismo portátil | Chrome: 11.5 veces la CPU; Firefox: 0.6 veces |
| Peso de la superposición en el tiempo total (1 hilo) | 3D 73 %, IMRT 84 %, VMAT 73 % (TERMA 20 %) |

No probado directamente: Chrome 109 en Windows 7. El código no usa funciones
posteriores a esa versión.

La descripción del cálculo, las pruebas físicas y las limitaciones conocidas son
las de la versión de escritorio y están en su README.

## Licencia

CalcIndep se distribuye bajo la licencia MIT (`LICENSE`). Los kernels EDKnrc
(repositorio conehead), las funciones numéricas traducidas de SciPy y NumPy, los
mapas de color de Matplotlib y ColorBrewer y los coeficientes de atenuación de
NIST XCOM conservan sus propias condiciones, que se recogen en
`THIRD_PARTY_NOTICES.txt`.
