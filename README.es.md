<p align="center">
  <img src="./docs/banner.jpeg" alt="Burnline — real-time spend tracking in your Claude Code status line" width="100%">
</p>

# Burnline

🇬🇧 [Read in English](README.md)

**Tu gasto real, directo en la barra de estado.**

Burnline es un plugin de [Claude Code](https://claude.com/claude-code) que
muestra tu gasto mensual directamente en la barra de estado: cuánto costó
esta sesión, cuánto lleva gastado este proyecto en el mes, y cuánto
gastaste en total este mes — todo calculado a partir del propio campo
`cost.total_cost_usd` de Claude Code, sin ningún recálculo externo de
precios.

```
[Sonnet 5] session: $0.34 | project (month): $12.87 | total (month): $45.21 [actual]
```

## El problema

Claude Code te muestra un costo corriente para la *sesión actual*, pero
nada que sobreviva a un `/clear`, nada desglosado por proyecto, y nada que
responda "¿cuánto gasté realmente este mes?" — la pregunta que en verdad
importa cuando estás pagando una factura de API o decidiendo si un plan de
suscripción vale la pena. Burnline responde esa pregunta, en vivo, sin que
tengas que correr un comando aparte ni abrir un dashboard.

## Por qué no reutiliza ccusage (ni recalcula nada)

Herramientas como [ccusage](https://github.com/ryoppippi/ccusage)
recalculan el costo a partir de conteos de tokens crudos contra una tabla
mantenida de precios por modelo. Es el enfoque correcto para analítica
histórica profunda, pero también es un blanco móvil: los precios cambian,
salen modelos nuevos, y una tabla desactualizada produce números
confiadamente equivocados sin ninguna señal visible de advertencia.

Burnline apuesta por lo contrario: nunca recalcula nada. Cada número que
muestra se construye a partir de `cost.total_cost_usd`, el valor que el
propio Claude Code calcula desde la contabilidad real de requests que ya
tiene. No hay tabla de precios que mantener sincronizada ni forma de que
quede desactualizada — el número es exactamente tan correcto como el
propio seguimiento de costos de Claude Code, siempre. La contrapartida es
que Burnline solo puede mostrar lo que Claude Code decide exponer, pero
para la pregunta "¿cuánto estoy gastando?", ese es el número que importa.

## En qué se diferencia de ccburn

[ccburn](https://github.com/JuanjoFuchs/ccburn) es una herramienta muy
buena, pero rastrea algo completamente distinto: **el consumo de
rate-limit** — cuánto llevás usado de tu ventana de rate-limit de 5 horas
o de 7 días en Pro/Max. Eso es útil para manejar tu ritmo contra un
límite. Burnline rastrea **dólares**, desglosados por proyecto y por mes.
Son métricas distintas, preguntas distintas, sin superposición — corré
ambas si querés el panorama completo.

## Cómo funciona, en resumen

- Los hooks de Claude Code nunca reciben datos de costo — solo el comando
  `statusLine` los recibe, vía stdin, en cada refresco. Por eso Burnline
  es un único script (`statusline/status.js`), no un hook.
- `cost.total_cost_usd` es acumulativo por sesión. Burnline rastrea el
  valor más alto visto por sesión (un pico corriente) y suma solo la
  diferencia positiva en cada tick — un enfoque que se mantiene correcto
  incluso cuando los ticks de statusLine de una misma sesión se superponen
  en el tiempo, algo que una simple comparación "último valor visto" no
  logra.
- El gasto se persiste localmente, agrupado por mes calendario y por
  proyecto, de modo que "este proyecto, este mes" y "todo, este mes" son
  ambas consultas baratas.
- La detección entre suscripción (Pro/Max) y facturación por API pay-per-
  token es automática, a partir de si el payload de la barra de estado
  incluye `rate_limits` — sin necesidad de configuración. El número es el
  mismo en ambos casos; lo que cambia es la etiqueta, que indica si es
  gasto real o un equivalente estimado de API.

El razonamiento de diseño completo, incluyendo por qué se tomó cada una de
estas decisiones, está en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Consultar el gasto rastreado

`/burnline:burnline-status` lista cada proyecto que Burnline rastreó en el
mes calendario actual — slug, `totalUsd`, y la ruta real del proyecto
(cuando se conoce; los datos escritos antes de que se agregara el
seguimiento de rutas aparecen como desconocidos) — más el total sumado al
final. Es de solo lectura: sin pedido de confirmación, nunca borra ni
modifica nada.

## Resetear el gasto rastreado

Burnline incluye un slash command, `/burnline:burnline-reset` (mostrado en
Claude Code como `/burnline-reset`), para volver a empezar el conteo.

- Sin argumento, apunta a **todos** los archivos de proyecto del **mes
  calendario actual únicamente** — un reset completo de "empezar de cero
  este mes."
- Con un argumento (un slug de proyecto o un nombre parcial, por ejemplo
  `ads`), apunta solo al archivo o archivos del proyecto que coincida en
  el mes actual, dejando todo lo demás intacto.
- Nunca toca ningún mes que no sea el actual — esto es un "reset hacia
  adelante," no una forma de borrar datos históricos.
- Antes de borrar nada, lista exactamente qué archivo(s) se verían
  afectados y su `totalUsd` actual, y espera que confirmes explícitamente
  en un mensaje de seguimiento. No borra nada en el mismo turno en que te
  muestra el plan.

## Instalación

```
/plugin marketplace add Tongas/burnline
/plugin install burnline@burnline
```

El nombre de marketplace que muestra `/plugin marketplace list` después
de agregarlo es el que manda — si en tu máquina difiere de
`burnline`, usá ese en su lugar.

Reiniciá Claude Code (o iniciá una sesión nueva) y la barra de estado va a
adoptar el formato de Burnline automáticamente.

## Datos y privacidad

Burnline es enteramente local. No hace llamadas de red, no envía
telemetría, y no depende de ningún proceso externo — es un único script
de Node.js que usa solo módulos del core (`fs`, `path`, `os`, `crypto`).
El gasto acumulado se escribe en
`~/.claude/burnline/<YYYY-MM>/<project-slug>.json` en tu propia máquina y
en ningún otro lado. Borrá esa carpeta en cualquier momento para
resetear.

## Requisitos

- Claude Code con soporte de statusLine.
- Node.js disponible en tu `PATH` (sin instalación de npm, sin
  dependencias).

## Comportamiento conocido

La barra de estado de cada sesión de Claude Code se refresca de forma
independiente. Si reseteás el gasto (o cambia cualquier otra cosa en
disco) desde una sesión, otras sesiones abiertas no lo van a reflejar
hasta su propio próximo tick de statusLine. Esto no es un bug — no hay
ningún proceso compartido que empuje actualizaciones entre sesiones, cada
una simplemente lee los archivos en disco cuando le toca refrescar.

## Autor

Hecho por [Gastón Parravicini](https://github.com/Tongas).

## Licencia

MIT — ver [LICENSE](LICENSE).
