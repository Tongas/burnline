<p align="center">
  <img src="./docs/banner.jpeg" alt="Burnline — real-time spend tracking in your Claude Code status line" width="100%">
</p>

# Burnline

🇬🇧 [Read in English](README.md)

**Tu gasto real, directo en la barra de estado.**

Burnline es un plugin de [Claude Code](https://claude.com/claude-code) que
muestra tu gasto directamente en la barra de estado: cuánto costó esta
sesión, cuánto lleva gastado este proyecto en el mes y desde que empezaste
a medir, y cuánto gastaste en total este mes y desde siempre — todo
calculado a partir del propio campo `cost.total_cost_usd` de Claude Code,
sin ningún recálculo externo de precios.

```
◆ Sonnet 5 │ session $4.20 │ project $61.30 mo · $1,152 all │ total $240.00 mo · $2,942 all  actual
today $18.40 ▅▇▂▁█▆▄ 7d │ month █████████▋░░ 80% of $300 budget │ pace ~$774.19/mo
5h ████▊░░░░░ 47% resets 14:43 (2h10m) → ~83% at reset │ 7d █▍░░░░ 22% (3d11h) │ cache 94% ● warm
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
- `cost.total_cost_usd` es acumulativo por sesión. Burnline recuerda el
  último valor visto por sesión y suma solo la diferencia positiva en
  cada tick. Si el valor llega a bajar, pasa a ser la nueva base, así que
  el gasto posterior nunca se pierde.
- El gasto se persiste localmente en un único ledger, por proyecto y por
  mes calendario, y se conserva el historial completo — un mes nuevo
  nunca borra el pasado, y las cifras "desde siempre" (`all`) están
  siempre disponibles.
- Los montos se congelan en dólares en el momento en que se gastan. Si
  los precios cambian después, los meses pasados nunca se recalculan: el
  total histórico es simplemente lo gastado antes a los precios de ese
  momento más lo nuevo a los precios nuevos.
- Un proyecto es el directorio donde lanzaste Claude Code
  (`workspace.project_dir`); un `cd` a una subcarpeta durante la sesión
  sigue sumando a ese mismo proyecto, y lo mismo un worktree de Claude
  Code (`<repo>/.claude/worktrees/<nombre>`).
- Cada cuenta de Claude se rastrea por separado: los datos viven en
  `$CLAUDE_CONFIG_DIR/burnline/` (por defecto `~/.claude/burnline/`), y un
  directorio de configuración por cuenta es la forma documentada de usar
  varias cuentas. Las cuentas que alternás con `/login` dentro del mismo
  directorio se suman juntas.
- La detección entre suscripción (Pro/Max) y facturación por API pay-per-
  token es automática, a partir de si el payload de la barra de estado
  incluye `rate_limits` — sin necesidad de configuración. El número es el
  mismo en ambos casos; lo que cambia es la etiqueta, que indica si es
  gasto real o un equivalente estimado de API.

El razonamiento de diseño completo, incluyendo por qué se tomó cada una de
estas decisiones, está en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Cómo leer la barra de estado

La línea 1 muestra dónde está la plata: esta sesión, este proyecto (este
mes y desde siempre), y todo (este mes y desde siempre).

La línea 2 muestra a qué velocidad se gasta, con color:

- **today** — gasto de hoy en todos los proyectos, más un sparkline de 7
  días (hoy resaltado). El seguimiento diario arranca el día en que
  actualizás, así que el sparkline se completa durante la primera semana.
- **month** — una barra del total del mes que pasa de verde → amarillo →
  rojo al 70% / 90%. Se llena hacia tu presupuesto mensual si definiste
  uno; si no, hacia el total del mes pasado.
- **pace** — proyección del total a fin de mes al ritmo actual,
  coloreada contra la misma referencia (presupuesto o mes pasado). Aparece
  pasado el primer día y medio del mes.

La línea 3 muestra tus límites, cuando Claude Code los reporta (Pro/Max):

- **5h** — la ventana de 5 horas: una barra, cuándo se resetea (hora y
  cuenta regresiva), y si al ritmo actual te quedás sin cupo antes
  (`⚠ full ~16:40`) o en qué porcentaje vas a terminar (`→ ~83% at
  reset`).
- **7d** — la ventana semanal y cuánto falta para que se resetee.
- Las ventanas 5h/7d se recuerdan entre sesiones, así que aparecen
  apenas arranca una sesión, antes del primer mensaje.
- **cache** — el porcentaje de aciertos del prompt cache de la sesión, y
  si sigue caliente. Con el cache frío, el próximo mensaje vuelve a pagar
  todo el contexto.

Definí `NO_COLOR=1` en el entorno del comando de statusLine para texto
plano.

## Definir un presupuesto mensual

`/burnline:burnline-budget 300` define un presupuesto de $300/mes para la
barra del mes; `/burnline:burnline-budget off` lo borra, y sin argumento
muestra el actual. Se guarda en `~/.claude/burnline/config.json`
(`{"monthlyBudgetUsd": 300}`).

## Consultar el gasto rastreado

`/burnline:burnline-status` lista cada proyecto que Burnline rastreó en el
mes calendario actual y desde siempre — slug, gasto del mes, gasto
histórico, y la ruta real del proyecto (cuando se conoce; los datos
escritos antes de que se agregara el seguimiento de rutas aparecen como
desconocidos) — más los totales al final. Es de solo lectura: sin pedido de confirmación, nunca borra ni
modifica nada.

## Resetear el gasto rastreado

Burnline incluye un slash command, `/burnline:burnline-reset` (mostrado en
Claude Code como `/burnline-reset`), para volver a empezar el conteo.

- Sin argumento, apunta a **todos** los proyectos del **mes
  calendario actual únicamente** — un reset completo de "empezar de cero
  este mes."
- Con un argumento (un slug de proyecto o un nombre parcial, por ejemplo
  `ads`), apunta solo al proyecto o proyectos que coincidan en el mes
  actual, dejando todo lo demás intacto.
- Nunca toca ningún mes que no sea el actual — esto es un "reset hacia
  adelante," no una forma de borrar datos históricos.
- Antes de cambiar nada, lista exactamente qué proyecto(s) se verían
  afectados y su gasto actual del mes, y espera que confirmes
  explícitamente en un mensaje de seguimiento. No cambia nada en el mismo
  turno en que te muestra el plan.

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
El gasto acumulado se escribe en `~/.claude/burnline/ledger.json` en tu
propia máquina y en ningún otro lado. Borrá esa carpeta en cualquier
momento para resetear. (Versiones anteriores escribían archivos
`<YYYY-MM>/<project-slug>.json`; se importan al ledger automáticamente en
la primera ejecución y después quedan intactos.)

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
una simplemente lee el ledger en disco cuando le toca refrescar.

Una sesión que empezó el mes pasado sigue mostrando su costo completo en
`session`, mientras que las cifras `month` solo cuentan lo gastado este
mes — así que a principio de mes `session` puede superar a `project …
month`. Las cifras `all` siempre lo incluyen.

## Autor

Hecho por [Gastón Parravicini](https://github.com/Tongas).

## Licencia

MIT — ver [LICENSE](LICENSE).
