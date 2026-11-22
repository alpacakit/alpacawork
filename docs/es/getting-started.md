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

Al terminar la instalación, la pantalla se abre en el navegador. Si no se abrió, o la cerraste después, pídeselo así a Claude Code o Codex. La IA abre la pantalla en el navegador o te dice su URL.

```text
/alpacawork abre la pantalla
```

En Codex, escribe `$alpacawork` en lugar de `/alpacawork`. Desde una terminal, también la abre este comando.

```sh
alpacawork open
```

También puedes abrir en el navegador la URL que mostró la configuración inicial al final, con la forma `http://127.0.0.1:43127/`.

Esta URL no cambia aunque reinicies el PC. Guárdala en marcadores. alpacawork se inicia solo cuando inicias sesión en el PC, así que no tienes que iniciarlo cada vez.

Si no se abre, consulta [La pantalla no se abre](troubleshooting.md#la-pantalla-no-se-abre).

## 3. Elegir el proyecto

Sigue en orden los cuatro pasos de la pantalla.

1. Elige el idioma y el tema de la pantalla, y pulsa “Siguiente”.
2. Comprueba que las IA que vas a usar estén en “Activado” y pulsa “Siguiente”.
3. En el paso siguiente, deja la recomendación como está y pulsa el botón de instalar.
4. Ponle nombre al proyecto, elige la carpeta de tu repositorio como “Ubicación del código” si usas uno existente, y pulsa “Finalizar configuración”.

<img src="../images/setup-project.png" alt="El último paso de la configuración, con los campos “Name” y “Working folder”, y el botón “Choose” junto a Working folder" width="480">

Un proyecto es una carpeta en la que trabaja la IA, junto con las reglas para trabajar en ella (la política del proyecto). Para usarlo con un repositorio existente, elige esa carpeta como ubicación del código. Si solo quieres probar, deja la ubicación del código vacía (la IA trabaja en la carpeta de datos, `~/alpacawork`). Puedes empezar con la política del proyecto de ejemplo tal como está.

## 4. Enviar una solicitud

Escribe lo que quieres que se haga en el cuadro de texto de la parte inferior de la pantalla y envíalo. Al enviarlo, el comienzo de la respuesta aparece encima del cuadro de texto. Púlsalo para leerla completa.

<img src="../images/input-reply.png" alt="El cuadro de texto y, encima, el comienzo de la respuesta de la IA que es tu punto de contacto" width="560">

Si es un repositorio existente, empieza con una solicitud que no modifique archivos.

```text
Lee el contenido de esta carpeta y resume en tres líneas para qué sirve. No modifiques ningún archivo. Después, propón tres trabajos que podría pedirte a continuación y pregúntame cuál quiero que hagas.
```

La IA lee la carpeta y escribe en su respuesta un resumen y propuestas de trabajo (a veces crea una tarea y te lo pregunta). Si vienen en la respuesta, envía en el cuadro de texto la propuesta que quieras, por ejemplo “Haz la 1”: se convierte en una tarea y aparece una fila en la lista.

Si solo quieres probar, pulsa el ejemplo de la pantalla “Elige una idea de minijuego y pide que lo creen” y envíalo.

Mientras la IA trabaja en la tarea, no hace falta que mires la pantalla.

## 5. Revisar cuando es tu turno

Cuando la IA envía una pregunta o un informe, la tarea pasa a “Por revisar”. Abre la tarea.

<img src="../images/list-waiting.png" alt="El encabezado “Awaiting review” de la lista y la fila de una tarea debajo" width="336">

- Si es una pregunta, pulsa una opción y envíala. Solo con pulsarla no se envía. Cuando respondes, la IA sigue trabajando y, al terminar, envía un informe.
- Si es un informe, léelo y, si está bien, pulsa “Completar” (la marca de verificación) en la parte inferior de la pantalla. Si quieres que corrija algo, escríbelo en el cuadro de texto y envíalo.

<img src="../images/action-bar.png" alt="Los botones que aparecen abajo al abrir una tarea: “Auto-swipe”, “Change state” y “Done”" width="338">

Cuando la tarea pasa a “Completadas”, has terminado (“Completadas” empieza cerrada; pulsa el encabezado para abrirla). La siguiente solicitud también se envía desde el mismo cuadro de texto.

## Qué leer después

- [Cómo usarlo](guide.md) — el uso diario
- [Adaptarlo a tu trabajo](projects.md) — cómo escribir la política, qué IA usar
- [Solución de problemas](troubleshooting.md)
