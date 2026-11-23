# Adaptarlo a tu trabajo

Cómo decidir los proyectos, la política y las IA que usas. Todos los ajustes de esta página los cambia la IA si se lo pides en el cuadro de texto (solo el inicio de sesión en la IA y las claves de API tienes que hacerlos tú).

## Usarlo con un repositorio existente

Elige la carpeta de ese repositorio como “Carpeta de trabajo” del proyecto. No hace falta mover nada. La IA sigue leyendo los `AGENTS.md` y `CLAUDE.md` de la carpeta como siempre.

Para cambiarla después: nombre del proyecto arriba a la izquierda → “Configuración de (nombre del proyecto)…” → “Elegir” en “Carpeta de trabajo” → “Guardar”.

La IA modifica archivos sin pedir confirmación. Si haces un commit antes de empezar, podrás distinguir los cambios de la IA y deshacerlos.

## Añadir proyectos

Crea un proyecto por repositorio. Pulsa el nombre del proyecto arriba a la izquierda → “Nuevo proyecto”, escribe el nombre y la carpeta de trabajo, y pulsa “Crear”.

Los proyectos que ya no uses se pueden archivar desde el final de la configuración del proyecto.

## Política del proyecto

Escribe con frases normales, en “Política del proyecto” de la configuración del proyecto, lo que dejas en manos de la IA, lo que quieres que te pregunte antes y lo que no debe hacer. Llega a todas las IA de ese proyecto.

Sirve básicamente para lo mismo que `AGENTS.md`. En la política del proyecto, escribe las instrucciones que quieres que la IA lea solo cuando usa alpacawork.

```text
Objetivo: que la web de la tienda se vea bien en el teléfono y publicarla
Cómo trabajar: antes de hacer un cambio que afecte al aspecto, muestra un ejemplo y pregunta
Lo que dejo en tus manos: decide sin preguntar cómo trabajar, las pruebas y la limpieza, e informa
Lo que no debes hacer: hacer push a GitHub o publicar sin aprobación
```

La política es algo que la IA se compromete a cumplir, no un mecanismo que la frene. Si quieres limitar lo que la IA puede tocar, usa un PC o un usuario del sistema operativo aparte para el trabajo.

## Las IA que usas

| Agente de IA | Qué necesita |
| --- | --- |
| Claude Code, Codex | Haber iniciado sesión en su CLI |
| GitHub Copilot | Haber iniciado sesión en GitHub CLI (`gh auth login`). El agente viene incluido |
| Grok Build, pi | Haber iniciado sesión o una clave de API |

Activa las IA que vas a usar en “Agentes” de “Configuración (el engranaje) → Servidor” y pulsa “Guardar”. Si quieres repartirlas según el trabajo, escríbelo en la política (“Implementación con Codex, revisión con Claude Code”).

Se usan tus suscripciones y configuraciones actuales de las IA tal como están. El coste también es el de tu plan.

## Elegir el modelo

El modelo que eliges junto al cuadro de texto es el de la IA que es tu punto de contacto. El modelo de las IA que hacen las tareas se indica en la solicitud o en la política (“Haz este trabajo con opus”).

Para añadir un modelo nuevo, abre su tarjeta en “Agentes” de “Configuración (el engranaje) → Servidor”, añade el nombre del modelo en la fila `model` de “Valores disponibles al pedir trabajo” y pulsa “Guardar”.

## Pasar claves de API

No escribas las claves en el cuadro de texto ni en la pantalla; escríbelas tú en un archivo.

1. Comprueba la ruta en “Archivo de entorno”, al final de “Configuración (el engranaje) → Servidor” (normalmente `~/.config/alpacawork/env`).
2. Escribe una por línea, como `ANTHROPIC_API_KEY=...`, y haz que otros usuarios no puedan leer el archivo: `chmod 600 ~/.config/alpacawork/env`
3. Reinicia alpacawork ([Detener e iniciar](manage.md#detener-e-iniciar)).
4. Comprueba que el nombre está en “Variables de entorno adicionales” de la tarjeta de la IA. Si no está, añádelo y pulsa “Guardar”.

## Cuántas se ejecutan a la vez

Al principio se ejecutan hasta 8 IA a la vez. Si consumes demasiado de tu cuota de uso, reduce “Máximo de ejecuciones simultáneas” en “Configuración (el engranaje) → Servidor” → “Opciones avanzadas” y pulsa “Guardar”.
