<p align="center">
  <a href="README.md">English</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">简体中文</a> · <b>Español</b> · <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/wordmark-dark.png">
    <img src="docs/images/wordmark.png" alt="alpacawork" width="380">
  </picture>
</h1>

<h3 align="center">Deja que la IA gestione tus IA.</h3>

<p align="center">
  Asigna trabajo a Claude Code y Codex<br/>y hace el seguimiento de su progreso.<br/>
  Ya no tienes que sentarte frente al PC para trabajar.
</p>

<p align="center">
  <a href="#instalar"><b>Instalar</b></a> ·
  <a href="docs/es/getting-started.md">Primeros pasos</a> ·
  <a href="docs/es/concept.md">Cómo funciona</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/alpacawork"><img alt="npm" src="https://img.shields.io/npm/v/alpacawork?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
</p>

<!-- The intro video goes here once it is uploaded on github.com: one line holding the URL GitHub gives. Then move the picture below to the end of the features list. -->

<p align="center">
  <img src="docs/images/pc-phone-dark.png" alt="alpacawork en el navegador de un PC, con una lista de diez tareas en curso y tres por revisar junto al informe abierto de una tarea, y a la derecha un teléfono que muestra el mismo informe" width="820">
</p>

alpacawork es una herramienta (un harness de IA) que ejecuta los agentes Claude Code y Codex que ya tienes instalados en tu PC y les asigna trabajo. Escribe lo que quieres en un solo cuadro de chat, y el coordinador, la IA que es tu punto de contacto, lo convierte en tareas, las asigna a otras IA y sigue el progreso. Tú haces tres cosas: pedir, responder preguntas y revisar los resultados. También puedes usarlo desde tu teléfono de la misma manera.

## Instalar

Pega el siguiente texto en Claude Code o Codex, en tu PC. La IA instala alpacawork y te indica la URL de la pantalla de configuración inicial, que normalmente también se abre en tu navegador.

```text
Descarga la siguiente guía, léela completa y síguela para instalar alpacawork en este PC.
https://raw.githubusercontent.com/alpacakit/alpacawork/main/skills/alpacawork/references/setup.md
```

Para instalarlo con comandos, ejecuta estas dos líneas en una terminal (en Windows, dentro de Ubuntu), en orden. La configuración inicial muestra lo que va a preparar y empieza cuando presionas Enter. Al terminar, muestra la URL de la pantalla en la línea `Abrir:` (`Open:` si la terminal está en inglés) y normalmente la abre en tu navegador.

```sh
npm install -g alpacawork
alpacawork setup
```

Funciona en macOS (Apple silicon), Linux (x64) y Windows (WSL2). Después de instalarlo, sigue [Primeros pasos](docs/es/getting-started.md) para hacer tu primera solicitud.

### Volver a abrir la pantalla

Si cierras la pantalla, pide a Claude Code o Codex que la abra, así. La IA abre la pantalla en el navegador o te dice su URL.

```text
/alpacawork abre la pantalla
```

En Codex, escribe `$alpacawork` en lugar de `/alpacawork`. Desde una terminal, también puedes abrirla con este comando.

```sh
alpacawork open
```

En Chrome o Edge, puedes instalarla como app al final de la configuración inicial, o más tarde en Configuración → App y teléfono, y volver a abrirla desde su icono en el Dock o la barra de tareas. En Safari en un Mac, instálala con Archivo → Añadir al Dock en el menú (macOS Sonoma o posterior).

## Qué hace

- **Escribe todas tus solicitudes en un solo cuadro de chat.** El coordinador convierte cada solicitud en una tarea y se la encarga a una IA. No tienes que cambiar de chat ni de IA de un trabajo a otro.
- **Una IA gestiona varias IA a la vez.** Para añadir o cambiar algo en el trabajo en curso, solo tienes que decírselo al coordinador. Escribe “En las tres tareas en curso, comprueba también cómo se ve en el teléfono” y el coordinador se lo indica a cada IA que trabaja en ellas.
- **Describe el proceso con tus palabras y las IA lo llevan a cabo juntas.** Incluso un proceso elaborado, como “Haz tres propuestas, cada una con un modelo distinto. Combínalas en una, haz que otra IA la revise y corrígela antes de pasarme el informe”, se lleva a cabo tal como lo describes: la IA gestiona los pasos y las IA se pasan el trabajo entre sí.
- **Las preguntas de la IA vienen con opciones y una recomendación.** Las preguntas y los informes llegan con imágenes y videos. Para responder, basta con elegir una opción.
- **Una pantalla pensada para el teléfono.** Desliza hacia la derecha para responder una pregunta o para marcar un resultado como completado. Puedes llevar una tarea desde la solicitud hasta completarla solo con tu teléfono. La misma pantalla también funciona en el navegador de tu PC.
- **Funciona con tu entorno de siempre.** `AGENTS.md`, `CLAUDE.md`, las skills, MCP y los hooks se usan tal cual. No necesitas una cuenta ni una clave de API para alpacawork.

## Ten en cuenta

- **Es gratis (licencia MIT).** El uso de IA se factura según el plan que ya tienes con Claude Code, Codex u otro agente.
- **Se ejecuta en tu PC.** La IA se ejecuta en tu PC, así que mantén el PC encendido y configúralo para que no entre en suspensión mientras usas alpacawork.
- **alpacawork inicia los agentes de IA en el mismo modo sin confirmaciones que `bypassPermissions` de Claude Code y `danger-full-access` de Codex, así que no se detienen a preguntar.** Lo que la IA no debe hacer, o lo que debe consultarte antes, puedes escribirlo en la [política del proyecto](docs/es/projects.md#política-del-proyecto).
- **Las tareas, las conversaciones y los archivos de resultados se guardan en tu PC.** alpacawork no los envía a ningún servidor externo gestionado por sus desarrolladores. Tus instrucciones a la IA y lo que la IA lee se envían al proveedor de la IA, igual que cuando usas cada agente de IA directamente ([más sobre el tratamiento de los datos](docs/es/manage.md#dónde-se-guardan-los-datos-y-qué-se-envía-fuera)).

## Documentación

- [Primeros pasos](docs/es/getting-started.md): instalar, pedir una tarea y revisarla
- [Índice de la documentación](docs/es/README.md): la lista de todas las páginas: cómo usarlo, la configuración, la solución de problemas y más
- Por favor, informa de los errores en [Issues](https://github.com/alpacakit/alpacawork/issues)

## Licencia

[Licencia MIT](LICENSE)
