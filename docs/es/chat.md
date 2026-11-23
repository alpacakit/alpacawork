# Usarlo desde Claude Code o Codex

Además del cuadro de entrada de la pantalla, puedes operar alpacawork desde una conversación de Claude Code o Codex abierta en una terminal o en su app. Sirve cuando quieres pedir y revisar tareas dentro de tu conversación habitual, sin abrir la pantalla.

## Cómo empezar

Al principio de la conversación, haz una petición con `/alpacawork` delante (`$alpacawork` en Codex).

```text
/alpacawork cuéntame brevemente, una por una, las tareas por revisar
```

La IA lee la skill de alpacawork y, desde entonces, la IA de esa conversación actúa como el mismo punto de contacto que el cuadro de entrada de la pantalla (el coordinador). A partir de la segunda petición, puedes omitir `/alpacawork`.

El trabajo que pides lo hacen las IA que inicia alpacawork. Cerrar esta conversación no lo detiene.

## Ejemplos de qué pedir

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

Puedes señalar una tarea por su número (como T12) o por palabras de su título. Las mismas peticiones funcionan en el cuadro de entrada de la pantalla (sin `/alpacawork`). Abrir la pantalla, cambiar la configuración o los modelos, actualizar y cosas así están en ["Operaciones habituales" del README](../../README.es.md#operaciones-habituales).
