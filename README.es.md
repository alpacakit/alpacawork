<p align="center">
  <a href="README.md">English</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">简体中文</a> · <b>Español</b> · <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

<h1 align="center">
  <img src="docs/images/logo.png" width="44" align="absmiddle" alt="">&nbsp;alpacawork
</h1>

<h3 align="center">Deja que la IA gestione tus IA.</h3>

<p align="center">
  Asigna trabajo a Claude Code y Codex<br/>y hace el seguimiento de su progreso.
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
  <img src="docs/images/pc-phone-dark.png" alt="alpacawork en el navegador de un PC, con la lista de tareas y un informe abierto, uno al lado del otro, junto a un teléfono que muestra una pregunta con dos opciones para elegir" width="820">
</p>

alpacawork es una herramienta (un harness de IA) que ejecuta los agentes Claude Code y Codex que ya tienes instalados en tu PC y les asigna trabajo. Escribe lo que quieres en un solo cuadro de chat, y el coordinador, la IA que es tu punto de contacto, lo convierte en tareas, las asigna a otras IA y sigue el progreso. Tú haces tres cosas: pedir, responder preguntas y revisar los resultados. También puedes usarlo desde tu teléfono de la misma manera.

## Instalar

Pega el siguiente texto en Claude Code o Codex, en tu PC. La IA instala alpacawork y la pantalla de configuración inicial se abre en tu navegador.

```text
Descarga la siguiente guía, léela completa y síguela para instalar alpacawork en este PC.
https://unpkg.com/alpacawork/skills/alpacawork/references/setup.md
```

Para instalarlo con comandos, ejecuta estas dos líneas en una terminal, en orden.

```sh
npm install -g alpacawork
alpacawork setup
```

- **Requisitos:** macOS (Apple silicon), Linux (x64) o Windows (dentro de WSL2). Necesitas un agente de IA en el que hayas iniciado sesión, como Claude Code o Codex, y Node.js 24.16 o posterior (si la instalación la hace una IA, esta instala Node.js cuando falta). [Requisitos completos](docs/es/getting-started.md#requisitos)
- **Después de instalar:** [Hacer tu primera solicitud](docs/es/getting-started.md#2-hacer-tu-primera-solicitud). Para usarlo desde tu teléfono, conéctate a tu PC a través de una VPN como Tailscale ([Usarlo desde tu teléfono](docs/es/getting-started.md#5-usarlo-desde-tu-teléfono)).
- **Detener y desinstalar:** [Detener, actualizar o desinstalar](docs/es/getting-started.md#7-detener-actualizar-o-desinstalar)

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
- **alpacawork inicia los agentes de IA con permisos completos, así que no se detienen a pedir confirmación.** Lo que la IA no debe hacer, o lo que debe consultarte antes, puedes escribirlo en la [política del proyecto](docs/es/getting-started.md#4-escribir-las-reglas-básicas-para-la-ia).
- **Las tareas, las conversaciones y los archivos de resultados se guardan en tu PC.** alpacawork no los envía a ningún servidor externo gestionado por sus desarrolladores. Tus instrucciones a la IA y lo que la IA lee se envían al proveedor de la IA, igual que cuando usas cada agente de IA directamente ([más sobre el tratamiento de los datos](docs/es/getting-started.md#qué-se-guarda-y-qué-se-envía-fuera)).

## Documentación

- [Primeros pasos](docs/es/getting-started.md): desde la instalación hasta tu primera solicitud, el uso desde tu teléfono, la actualización y la desinstalación
- [Las ideas detrás de alpacawork](docs/es/concept.md): cómo avanza una solicitud y los principios de diseño
- [Solución de problemas](docs/es/getting-started.md#solución-de-problemas): cuando algo no funciona. Por favor, informa de los errores en [Issues](https://github.com/alpacakit/alpacawork/issues)

## Licencia

[Licencia MIT](LICENSE)
