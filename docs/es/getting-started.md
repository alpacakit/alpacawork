# Primeros pasos

Los pasos para instalar alpacawork, pedirle una tarea a la IA y revisar el resultado. Contando lo que tarda la IA en trabajar, lleva unos 15 minutos.

## Antes de empezar

- Necesitas un PC con macOS (Apple silicon), Linux (x64, con una sesión de usuario de systemd, que tienen la mayoría de las instalaciones de escritorio y servidor) o Windows (WSL2 con systemd activado, lo predeterminado en Ubuntu). En Windows, lee primero [Usarlo en Windows](manage.md#usarlo-en-windows).
- Ten Claude Code o Codex listo para usar en este PC.
- La IA modifica archivos sin pedir confirmación. Se ejecuta con los permisos de tu usuario del PC, así que también puede tocar archivos fuera de la carpeta en la que trabaja.

## 1. Instalar

Pega el siguiente texto tal cual en Claude Code o Codex, en tu PC. La IA instala lo que falta y después instala alpacawork. Si te pide permiso para ejecutar comandos, concédeselo.

```text
Descarga la siguiente guía, léela completa y síguela para instalar alpacawork en este PC.
https://raw.githubusercontent.com/alpacakit/alpacawork/main/skills/alpacawork/references/setup.md
```

Para instalarlo tú desde una terminal, instala Node.js 24.16 o posterior, ejecuta estas dos líneas en orden y presiona Enter cuando te lo pida.

```sh
npm install -g alpacawork
alpacawork setup
```

## 2. Abrir la pantalla

Al terminar la instalación, la pantalla se abre en el navegador. Si no se abrió, o la cerraste después, pide a Claude Code o Codex que la abra, así. La IA abre la pantalla en el navegador o te dice su URL.

```text
/alpacawork abre la pantalla
```

En Codex, escribe `$alpacawork` en lugar de `/alpacawork`. Desde una terminal, también puedes abrirla con este comando.

```sh
alpacawork open
```

También puedes abrir en el navegador la URL que mostró la configuración inicial al final, con la forma `http://127.0.0.1:43127/`.

Esta URL no cambia aunque reinicies el PC. Guárdala en marcadores. alpacawork se inicia solo cuando inicias sesión en el PC, así que no tienes que iniciarlo cada vez.

Si la instalas como app, también puedes volver a abrirla desde su icono en el Dock o la barra de tareas. Cómo instalarla está al final del paso siguiente, “3. Elegir el proyecto”.

Si no se abre, consulta [La pantalla no se abre](troubleshooting.md#la-pantalla-no-se-abre).

## 3. Elegir el proyecto

Sigue en orden los cuatro pasos de la pantalla.

1. Elige el idioma y el tema de la pantalla, y pulsa “Siguiente”.
2. Comprueba que las IA que vas a usar estén en “Activado” y pulsa “Siguiente”. Aquí también puedes elegir si enviar datos de uso a los desarrolladores ([qué se envía](telemetry.md)).
3. En el paso siguiente, deja la selección como está y pulsa “Instalar (número) skills”.
4. Ponle nombre al proyecto, elige la carpeta de tu repositorio como “Carpeta de trabajo” si usas uno existente (búscala con “Elegir” o escribe la ruta en el campo), y pulsa “Finalizar configuración”.

<img src="../images/setup-project.png" alt="El último paso de la configuración, con los campos “Name” y “Working folder”, y el botón “Choose” junto a Working folder" width="480">

Un proyecto es una carpeta en la que trabaja la IA, junto con las reglas para trabajar en ella (la política del proyecto). Para usarlo con un repositorio existente, elige la carpeta del repositorio como carpeta de trabajo. Si solo quieres probar, deja la carpeta de trabajo vacía (la IA trabaja en la carpeta de datos, `~/alpacawork`). Puedes empezar sin escribir una política del proyecto. Lo que no quieras que haga la IA, escríbelo en la política del proyecto ([cómo escribirla](projects.md#política-del-proyecto)).

Al pulsar “Finalizar configuración”, Chrome y Edge preguntan si quieres instalar alpacawork como app. Pulsa “Instalar y empezar” para poder volver a abrirla desde su icono en el Dock o la barra de tareas. Si eliges “Empezar en el navegador”, puedes instalarla más tarde con “Instalar” en “Configuración (el engranaje) → App y teléfono”. En Safari en un Mac, instálala con “Archivo → Añadir al Dock” en el menú (macOS Sonoma o posterior).

## 4. Enviar una solicitud

Al terminar la configuración, aparece “Te damos la bienvenida a alpacawork” y un esquema de cómo una solicitud se convierte en tareas y avanza. Hasta que termines tu primera solicitud, aparecen globos de ayuda en los puntos clave de la pantalla.

<img src="../images/welcome.png" alt="La pantalla “Welcome to alpacawork”: un esquema de cuatro pasos de una solicitud que se convierte en tareas y se pone en la lista, y un globo que señala el cuadro de texto de abajo, “This is the only input box. All your instructions go here.”, con el botón “Insert a demo prompt”" width="560">

Escribe lo que quieres que se haga en el cuadro de texto de la parte inferior de la pantalla y envíalo.

Si solo quieres probar, pulsa “Insertar un prompt de demostración” en el globo y envía tal cual el texto que aparece. Es una solicitud para crear un HTML que muestre “Hello” con dos fuentes y que después te pregunte cuál es mejor.

Si es un repositorio existente, empieza con una solicitud que no modifique archivos.

```text
Lee el contenido de esta carpeta y resume en tres líneas para qué sirve. No modifiques ningún archivo. Después, propón tres trabajos que podría pedirte a continuación y pregúntame cuál quiero que hagas.
```

Al enviarla, el comienzo de la respuesta de la IA de recepción (el coordinador) aparece encima del cuadro de texto. Púlsalo para leerla completa.

<img src="../images/input-reply.png" alt="El cuadro de texto y, encima, el comienzo de la respuesta de la IA que es tu punto de contacto" width="560">

Una solicitud que encargas como trabajo aparece al poco rato como tarea, en una fila de “En curso” en la lista. Una solicitud que se resuelve solo con una respuesta no se convierte en tarea. Si en el ejemplo del repositorio la respuesta trae propuestas, envía en el cuadro de texto la que quieras, por ejemplo “Haz la 1”, y se convierte en una tarea. Si envías primero la solicitud del repositorio, el botón de la demostración desaparece; para probar la demostración más tarde, vuelve a mostrar la guía (al final de “5. Revisar cuando es tu turno”).

Mientras la IA trabaja en la tarea, no hace falta que mires la pantalla.

## 5. Revisar cuando es tu turno

Cuando la IA envía una pregunta o un informe, la tarea pasa a “Por revisar”. Pulsa la fila para abrirla.

<img src="../images/list-waiting.png" alt="El encabezado “Awaiting review” de la lista y la fila de una tarea debajo" width="336">

- Si es una pregunta, al pulsar una opción la respuesta pasa al cuadro de texto. Envíala tal cual para responder (solo con pulsarla no se envía). También puedes enviar otro mensaje sin elegir ninguna opción. Cuando respondes, la IA sigue trabajando y, al terminar, envía un informe.
- Si es un informe, léelo y, si está bien, pulsa “Completar” (la marca de verificación) en la parte inferior de la pantalla. Si quieres que corrija algo o pedirle algo más, escríbelo en el cuadro de texto con la tarea abierta y envíalo (en la demostración, “Insertar un prompt de demostración” en el globo pone “Haz una versión más para que pueda compararlas.”).

<img src="../images/action-bar.png" alt="Los botones que aparecen abajo al abrir una tarea: “Auto-swipe”, “Change state” y “Done”" width="338">

Cuando la tarea pasa a “Completadas”, has terminado (“Completadas” empieza cerrada; pulsa el encabezado para abrirla). La siguiente solicitud también se envía desde el mismo cuadro de texto.

Cuando completas tu primera tarea, los globos terminan indicándote, entre otras cosas, cómo borrar la conversación con la IA de recepción, qué hacer para usar otro repositorio y dónde están los pasos para usar alpacawork desde el teléfono. Para volver a ver la guía, pulsa “Mostrar de nuevo” en “Guía de primeros pasos”, dentro de “Configuración (el engranaje) → Personal”.

## Qué leer después

- [Cómo usarlo](guide.md) — el uso diario
- [Adaptarlo a tu trabajo](projects.md) — cómo escribir la política, qué IA usar
- [Solución de problemas](troubleshooting.md)
