# Usarlo desde Claude Code o Codex

También puedes operar alpacawork desde una conversación de Claude Code o Codex.

## Cómo empezar

Pon `/alpacawork` delante solo en la primera petición de la conversación (`$alpacawork` en Codex).

```text
/alpacawork cuéntame brevemente, una por una, las tareas por revisar
```

Desde entonces, la IA de esa conversación actúa como punto de contacto (el coordinador). En el cuadro de entrada de la pantalla de alpacawork, `/alpacawork` no hace falta.

El trabajo que pides lo hacen las IA encargadas, así que no se detiene aunque cierres la conversación. Las preguntas y los informes llegan a "Por revisar" en la pantalla.

## Ejemplos de qué pedir sobre las tareas

| Para | Ejemplo de qué pedir |
| --- | --- |
| Pedir una tarea | `crea una tarea para corregir el fallo de la pantalla de inicio de sesión y empiézala` |
| Ver las tareas por revisar | `cuéntame brevemente, una por una, las tareas por revisar` |
| Preguntar cómo van las tareas | `dime cómo van las tareas` |
| Buscar una tarea | `busca la tarea que corrigió el README` |
| Responder una pregunta | `para la pregunta de T12, sigue con la opción 2` |
| Pedir un cambio | `acorta el texto del botón en T12` |
| Marcar como completada | `ya revisé T12. Márcala como completada` |
| Poner en pausa o detener | `pon T12 en pausa`, `detén T12` |
| Crear un proyecto | `haz de ~/code/shop un proyecto` |

Puedes señalar una tarea por su número (como T12) o por palabras de su título. Las mismas peticiones funcionan en el cuadro de entrada de la pantalla.

## Operar alpacawork en sí

| Para | Ejemplo de qué pedir | Comando |
| --- | --- | --- |
| Abrir la pantalla | `abre la pantalla` | `alpacawork open` |
| Ver si está en marcha | `mira si está en marcha` | `alpacawork status` |
| Cambiar la configuración | `ejecuta como máximo 4 IA a la vez` | — |
| Cambiar el modelo principal | `usa opus normalmente para las tareas` | — |
| Hacer disponible un modelo nuevo | `salió un modelo nuevo de Codex; añádelo a la configuración de modelos para poder elegirlo` | — |
| Cambiar la política del proyecto | `añade "usa opus para el diseño" a la política del proyecto` | — |
| Actualizar a la última versión | `actualiza a la última versión` | `alpacawork deploy npm:alpacawork` |
| Detener, iniciar o reiniciar | `reinicia alpacawork` | `alpacawork stop`, `start`, `restart` |
| Desinstalar | `desinstala alpacawork` | `alpacawork uninstall` y después `npm uninstall -g alpacawork` |

Los cambios de configuración, de modelos y de la política del proyecto también se pueden pedir en el cuadro de entrada de la pantalla. Detener, reiniciar y desinstalar no se pueden hacer desde el cuadro de entrada de la pantalla. Los demás comandos se consultan con `alpacawork -h` ([Volver a abrir, detener y actualizar](manage.md)).
