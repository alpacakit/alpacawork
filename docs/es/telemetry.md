# Datos de uso

Los datos de uso son un recuento de cómo se usa alpacawork (qué acciones se usaron y cuántas veces, la versión, el sistema operativo, etc.). Se envían al desarrollador para mejorar alpacawork: para saber qué funciones se usan, dónde se producen fallos y dónde la pantalla es lenta.

El envío es opcional. No se envía nada hasta que elijas, y alpacawork funciona igual si no envías. Después de elegir enviar, puedes dejar de hacerlo en cualquier momento y eliminar lo que se envió.

## Qué se envía

Por cada día que usas alpacawork, los datos de ese día se reúnen en un solo informe y se envían al día siguiente. Los días se cuentan en UTC. No se envía ningún informe por los días en que no lo usas. Si un informe no se puede enviar, se reintenta durante 7 días; después, se elimina sin enviarlo.

Un informe contiene:

- **Recuentos de acciones**: las acciones en la pantalla (presionar el botón de enviar, buscar, etc.) y los cambios hechos mediante comandos desde una IA o la terminal (crear una tarea, informar de su estado, etc.), contados por tipo. Cada recuento lleva además el tipo de dispositivo (teléfono, tableta o PC) y su sistema operativo, el origen (una persona en la pantalla, una IA o la terminal, más el tipo de IA cuando fue una IA) y el idioma de la interfaz y el tema
- **Entorno**: la versión de alpacawork, el sistema operativo y el tipo de CPU, y la versión de Node
- **Trabajo de la IA**: los tipos de IA usados (`claude`, `codex`, etc.; los nombres que les diste no se envían), los recuentos por nivel de esfuerzo y cuántas veces el trabajo falló a mitad de camino
- **Tamaño**: el número de proyectos y tareas, la profundidad del árbol de tareas, cuántas veces trabajó una IA en una misma tarea, cuántas ejecuciones de IA había al mismo tiempo, etc.
- **Velocidad de visualización**: cuánto tiempo pasó desde que se abrió la pantalla o una tarea hasta que apareció su contenido
- **Sobre el propio informe**: la fecha del informe, su número de formato y el ID de este PC

Cada tipo de acción tiene un nombre fijo. El texto que escribes y los títulos de las tareas nunca pasan a formar parte de un nombre. El tamaño, la velocidad de visualización y los recuentos de fallos se envían como rangos aproximados, como `10-19`.

El ID de este PC es un valor aleatorio que se crea la primera vez que eliges enviar. No se genera a partir de ninguna información del PC ni del usuario. Se usa para contar cuántos días sigue en uso el mismo PC y para que puedas eliminar más adelante los datos enviados. Si dejas de enviar y vuelves a empezar, se usa el mismo ID.

Puedes ver el informe real exactamente como se enviará (“Ver lo que se envía”, más abajo).

## Qué no se envía

- Los títulos y el texto de las tareas, las conversaciones, el texto de las solicitudes
- Los nombres de archivos y carpetas, las URL de repositorios
- Los nombres del PC y del usuario, las direcciones de correo electrónico
- El texto de los errores (solo se cuenta cuántas veces se produjeron)

Las direcciones IP no se incluyen en los informes, y el receptor no las conserva. Sin embargo, Cloudflare, que aloja el receptor, las procesa en tránsito ([política de privacidad de Cloudflare](https://www.cloudflare.com/es-es/privacypolicy/)).

## Elegir si se envía y dejar de enviar

Eliges en el primer paso de la pantalla de configuración inicial, que es la que se abre en una instalación nueva. No se envía nada hasta que elijas; si no hay una elección (por ejemplo, en un espacio de trabajo creado antes de que existiera la pantalla de configuración inicial), no se envía nada y la pantalla no pregunta.

Para cambiar tu elección más adelante, usa el interruptor “Enviar datos de uso para ayudar a mejorar alpacawork”, al final de Configuración → Servidor. Al desactivarlo, el envío se detiene; al activarlo, comienza. Si solo quieres dejar de enviar, también puedes ejecutar `alpacawork telemetry off`.

Cuando dejas de enviar, los datos aún no enviados se eliminan sin enviarlos. Los datos ya enviados no se eliminan solo por dejar de enviar (“Eliminar lo que se envió”, más abajo).

Si actualizas a una versión que cambia qué campos se envían o cómo se envían, se te vuelve a preguntar solo si habías elegido enviar. No se envía nada hasta que respondas.

En algunos casos, como cuando alpacawork se ejecuta en CI o dentro de un contenedor, no se envía nada aunque hayas elegido enviar. En ese caso, el interruptor no se puede cambiar y el motivo aparece debajo.

Tampoco se envía nada mientras la variable de entorno `ALPACAWORK_TELEMETRY_DISABLED=1` o `DO_NOT_TRACK=1` está definida para el servidor. Sin embargo, cuando la quitas, se envían los datos no enviados de los últimos 7 días. Además, las variables de entorno definidas en una terminal no llegan al servidor que se inicia automáticamente. Para asegurarte de que el envío se detiene, usa la pantalla o el comando.

## Ver lo que se envía

- Pantalla: “Ver lo que se envía”, debajo del interruptor de datos de uso al final de Configuración → Servidor, muestra el informe de hoy hasta el momento (el que se envía mañana), exactamente como se enviará. Solo muestra contenido mientras el envío está activado. Lo que aparece ahí todavía no se ha enviado, así que, si dejas de enviar, no se enviará.
- Comando: `alpacawork telemetry show` muestra los datos de hoy hasta el momento, los informes de días anteriores aún no enviados, tus copias de los informes ya enviados y la lista de nombres y valores que se pueden enviar. La lista se muestra incluso antes de que elijas enviar.

Ambos muestran JSON. Los comandos `alpacawork telemetry` solo funcionan cuando una persona los escribe en una terminal de este PC.

## Eliminar lo que se envió

- Pantalla: usa “Eliminar datos enviados”, debajo del interruptor de datos de uso al final de Configuración → Servidor. Funciona incluso después de haber dejado de enviar. Los datos del PC aún no enviados también se eliminan.
- Página de eliminación: escribe el ID de este PC en <https://alpacakit-telemetry.alpacakit.workers.dev/delete>. Úsala cuando no puedas abrir la pantalla de alpacawork o para eliminar los datos de un PC que ya no usas. Puedes encontrar el ID en la ventana que abre “Eliminar datos enviados”, o como `id` en `alpacawork telemetry status`.

Al eliminar se quitan los informes enviados con ese ID y el registro de ese ID (el primer y el último día en que envió). Los datos no se pueden quitar de los totales que no distinguen un PC de otro (como el número de acciones o de PC por día).

Eliminar no detiene el envío. Si el envío continúa, los datos nuevos se envían con el mismo ID. La página de eliminación no elimina lo que está en el PC, así que, si ese PC sigue enviando, primero detén el envío y después elimina. De lo contrario, los datos aún no enviados se enviarán más adelante.

## Adónde van, quién puede verlos y cuánto tiempo se conservan

- Adónde: al receptor que el desarrollador configuró en Cloudflare Workers (`https://alpacakit-telemetry.alpacakit.workers.dev/v1/report`).
- Quién: solo el desarrollador de alpacawork. El panel de totales requiere inicio de sesión y muestra los recuentos tal cual, incluidos los pequeños. Cuando se publican recuentos, se omiten los grupos de menos de 10 PC y se indica que proceden solo de los PC que eligieron enviar.
- Cuánto tiempo: cada informe se conserva con su ID durante unos 3 meses y luego se elimina. El registro de un ID se elimina unos 3 meses después del último día en que envió. Los totales que no incluyen el ID se conservan indefinidamente. No se pueden rastrear hasta los informes de cada PC.
