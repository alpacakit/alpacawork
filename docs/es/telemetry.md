# Datos de uso

Los datos de uso son recuentos de cómo se usa alpacawork (qué operaciones se usaron y cuántas veces, la versión, el sistema operativo, etc.). Se envían al desarrollador para mejorar alpacawork, sabiendo qué funciones se usan más, dónde ocurren fallos y dónde la pantalla va lenta.

El envío es opcional. No se envía nada hasta que lo eliges, y si no los envías puedes usarlo igual. Después de elegir enviarlos, puedes dejar de hacerlo en cualquier momento y eliminar los datos enviados.

## Qué se envía

Por cada día que usas alpacawork, los datos de ese día se reúnen en un solo informe y se envían al día siguiente. Los días se cuentan en UTC. No se envía ningún informe por los días en que no lo usas. Si un informe no se puede enviar, se reintenta durante 7 días; después, se elimina sin enviarlo.

El informe incluye lo siguiente:

- **Número de operaciones**: las operaciones en la pantalla (pulsar el botón de enviar, buscar, etc.) y los cambios hechos con comandos desde la IA o la terminal (crear una tarea, informar de un estado, etc.), contados por tipo. También se envían el tipo de dispositivo desde el que se hizo (teléfono, tableta o PC) y su sistema operativo, la vía (una persona desde la pantalla, una IA o la terminal; si es una IA, también qué tipo de IA), y el idioma y el tema de la pantalla
- **Entorno**: la versión de alpacawork, el sistema operativo y el tipo de CPU, y la versión de Node
- **Trabajo de la IA**: los tipos de IA usados (`claude`, `codex`, etc.; los nombres que les pusiste tú no se envían), el número de veces por esfuerzo y el número de veces que fallaron a mitad del trabajo
- **Escala**: el número de proyectos y tareas, la profundidad de la jerarquía de tareas, cuántas veces trabajó la IA en una tarea, cuántos trabajos de IA se ejecutaron a la vez, etc.
- **Velocidad de la pantalla**: el tiempo que pasa desde que abres la pantalla o una tarea hasta que aparece el contenido
- **Datos del propio informe**: la fecha del informe, el número de formato y el ID de este PC

Los tipos de operación son solo nombres definidos de antemano. Nunca se incluye el texto que escribiste ni los títulos de las tareas. La escala, la velocidad de la pantalla y el número de fallos se envían como rangos aproximados, como `10-19`.

El ID de este PC es un valor aleatorio que se crea la primera vez que eliges enviar, y no se genera a partir de datos del PC ni del usuario. Sirve para contar cuántos días seguidos se usa el mismo PC y para poder eliminar después los datos enviados. Si dejas de enviar y vuelves a empezar, se usa el mismo ID.

Puedes ver el informe real tal como se enviará (“Ver lo que se envía”, más abajo).

## Qué no se envía

- Los títulos y el texto de las tareas, las conversaciones y el texto de las solicitudes
- Los nombres de archivos y carpetas, y las URL de los repositorios
- Los nombres del PC y del usuario, y las direcciones de correo electrónico
- El texto de los errores (solo se cuenta cuántas veces ocurren)

Las direcciones IP no se incluyen en el informe, y el receptor tampoco las conserva. Sin embargo, Cloudflare, que aloja el receptor, las procesa en tránsito ([política de privacidad de Cloudflare](https://www.cloudflare.com/es-es/privacypolicy/)).

## Elegir si enviar o dejar de enviar

Se elige en el segundo paso de la pantalla de configuración que se abre al instalarlo por primera vez. No se envía nada hasta que eliges. Si no has elegido (por ejemplo, en un espacio de trabajo creado antes de que existiera la pantalla de configuración), tampoco se envía nada, y la pantalla no te lo pregunta.

Para cambiarlo después, usa el interruptor “Enviar datos de uso para ayudar a mejorar alpacawork”, en Configuración → General. Al desactivarlo se deja de enviar, y al activarlo se empieza. Si solo quieres dejar de enviar, también puedes usar el comando `alpacawork telemetry off`.

Al dejar de enviar, lo que aún no se ha enviado se elimina sin enviarlo. Lo ya enviado no se elimina solo por dejar de enviar (“Eliminar los datos enviados”, más abajo).

Si actualizas a una versión que añade un tipo de información a lo que se envía, o cambia la forma de enviarlo, una ventana vuelve a pedir tu consentimiento al abrir la pantalla, solo en los PC que habían elegido enviar. La ventana muestra los campos añadidos. No se envía nada hasta que respondes. Cada tipo de información es un campo del informe (por ejemplo `shape.tasks`); tu elección registra los campos que cubría, así que siempre se pregunta por un campo añadido después.

En algunos casos no se envía aunque hayas elegido enviar, como cuando se ejecuta en CI o en un contenedor. Entonces no puedes usar el interruptor, y el motivo aparece debajo.

Mientras la variable de entorno `ALPACAWORK_TELEMETRY_DISABLED=1` o `DO_NOT_TRACK=1` esté configurada en el servidor, tampoco se envía. Pero, al quitarla, se envía lo de los últimos 7 días que aún no se haya enviado. Además, las variables de entorno que configuras en una terminal no llegan al servidor que se inicia automáticamente. Para dejar de enviar con seguridad, usa la pantalla o el comando.

## Ver lo que se envía

- Pantalla: con “Ver lo que se envía”, debajo del interruptor de datos de uso en Configuración → General, puedes ver el borrador de hoy, los informes pendientes y las solicitudes que hace alpacawork. Cada intento muestra el destino, el contenido exacto y el resultado si se conoce. También aparecen los reintentos y las solicitudes de eliminación hechas desde la aplicación.
- Comando: `alpacawork telemetry show` muestra el mismo historial y la lista de nombres y valores que se pueden enviar.

Cada intento se registra antes del envío y queda en este PC durante 13 semanas, aunque desactives el envío o solicites la eliminación de datos en el receptor. Si no se pudo registrar la respuesta, el historial muestra que se desconoce el resultado.

Los comandos `alpacawork telemetry` solo funcionan cuando una persona los escribe desde una terminal en este PC.

## Eliminar los datos enviados

- Pantalla: usa “Eliminar datos enviados”, debajo del interruptor de datos de uso en Configuración → General. Funciona incluso después de dejar de enviar. Lo que aún no se ha enviado desde el PC también se elimina.
- Página de eliminación: escribe el ID de este PC en <https://alpacakit-telemetry.alpacakit.workers.dev/delete>. Úsala cuando no puedas abrir la pantalla de alpacawork o para eliminar los datos de un PC que ya no usas. El ID aparece en la pantalla que abre “Eliminar datos enviados” o como `id` en `alpacawork telemetry status`.

Se eliminan los informes enviados con ese ID y el registro de ese ID (los días del primer y del último envío). Los datos no se pueden eliminar de los recuentos que no distinguen entre PC (como el número de operaciones o de equipos por día).

Eliminar no detiene el envío. Si sigues enviando, los datos nuevos se envían con el mismo ID. La página de eliminación no borra lo que está en el PC, así que, si ese PC sigue enviando, primero deja de enviar y después elimina. Si no, lo que aún no se ha enviado se enviará más adelante.

## Adónde se envía, quién lo ve y cuánto tiempo se conserva

- Adónde: al receptor que el desarrollador puso en Cloudflare Workers (`https://alpacakit-telemetry.alpacakit.workers.dev/v1/report`).
- Quién lo ve: solo los desarrolladores de alpacawork. La pantalla de recuentos está protegida con inicio de sesión y muestra tal cual incluso las cifras pequeñas. Cuando se publican cifras, se excluyen los grupos de menos de 10 equipos y se indica que solo cuentan los PC que eligieron enviar.
- Cuánto tiempo se conserva: cada informe se conserva con su ID unos 3 meses y después se elimina. El registro del ID se elimina unos 3 meses después del último envío. Los recuentos sin ID se conservan sin plazo. A partir de los recuentos no se puede volver a los informes de cada equipo.
