# Las ideas detrás de alpacawork

Qué pasa por detrás después de enviar una solicitud, y qué tienes que hacer tú.

## Para qué sirve

Cuando encargas varios trabajos a la IA, a la persona le queda otro trabajo: recordar qué pidió y dónde, ir viendo cómo avanza todo y decidir a quién encargar qué después. alpacawork también deja este trabajo de gestión en manos de la IA.

Tú haces tres cosas: pedir, responder preguntas y revisar los resultados. Las tres están pensadas para poder hacerse desde el teléfono.

## Cómo avanza una solicitud

Supongamos que pides “Haz un formulario de reservas para la web de la tienda”. Los números del diagrama son los mismos que los del texto de abajo.

<p align="center">
  <img src="../images/concept-flow.svg" alt="1 Le dices lo que quieres que se haga a la IA que es tu punto de contacto (Coordinator). 2 Coordinator lo convierte en una tarea y se lo pasa a la IA que se encarga de ella (Owner). 3 Owner la divide en subtareas y pide ayuda a miembros (Member). 4 Las preguntas y los resultados te llegan a ti." width="410">
</p>

1. La solicitud que escribes en el cuadro de texto llega a la IA que es tu punto de contacto (el coordinador).
2. El coordinador decide si la convierte en una tarea nueva o la añade a una tarea en curso, y se la pasa a la IA que se encarga de esa tarea (el responsable).
3. El responsable divide el trabajo en subtareas como “Decidir los campos de la reserva”, “Hacer la pantalla del formulario” y “Comprobar cómo se ve en el teléfono”, y encarga cada una a su propio responsable. Cuando necesita ayuda, llama a miembros (IA que ayudan). Lo que no tiene que esperar avanza en paralelo. El resultado de cada subtarea vuelve al responsable de arriba.
4. Lo que la IA no puede decidir, como “Qué campos poner en la reserva”, te llega como una pregunta con opciones y una recomendación. Cuando el trabajo está hecho, llega un informe. Revisa el informe y pulsa “Completar”: has terminado.

En el historial de la pantalla aparecen estos nombres de roles, como “Responsable”. Todas las IA son las mismas Claude Code, Codex u otras que tienes instaladas en tu PC.

## Qué te llega

Solo te llega lo que solo tú puedes decidir. Las tareas con una pregunta o un informe aparecen en “Por revisar” de la lista, y las tareas en las que se detuvo la ejecución de la IA, en “Requiere atención”.

![A la izquierda, la lista de tareas: arriba “In progress” y abajo “Awaiting review”. A la derecha, el informe abierto de una tarea por revisar. Bajo la lista, el botón “Done”](../images/home-desktop-dark.png)


- Preguntas para elegir gustos o el rumbo
- Revisar lo que se ha hecho
- Aprobar operaciones que afectan al exterior, como publicar o eliminar
- Decidir qué hacer cuando se detiene la ejecución de una IA

La forma de trabajar, el reparto, el orden y cómo comprobarlo los decide la IA. Puedes seguir pidiendo sin esperar a que termine la solicitud anterior.

## Indica cómo trabajar con tus palabras

En lugar de buscar una opción en la configuración, pídelo con una frase normal.

- “Haz este trabajo con opus, con esfuerzo high”
- “Haz que Claude Code y Codex preparen propuestas por separado, y compáralas para enseñármelas”
- “Cuando esté hecho, haz que lo compruebe un modelo distinto del que lo hizo”
- “La IA a cargo parece confundida; cámbiala por una IA nueva y sigue”

Lo que quieras siempre, escríbelo en la [política del proyecto](projects.md#política-del-proyecto). La política es algo que la IA se compromete a cumplir, no un mecanismo que la frene.

Los `AGENTS.md`, `CLAUDE.md`, skills y MCP que ya usas siguen funcionando tal cual.

## Para qué no está pensado

- Compartirlo en equipo: es una herramienta para una sola persona. La pantalla no tiene inicio de sesión.
- Publicarlo en internet: desde otros dispositivos, se da por hecho que conectas por VPN solo los tuyos.
