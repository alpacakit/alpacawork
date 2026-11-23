# Solución de problemas

Si la pantalla se abre, lo más rápido es preguntar a la IA en el cuadro de texto (“¿Por qué no avanza la tarea del formulario de reservas?”). La IA puede leer los pasos para arreglarlo.

No borres tú la carpeta de datos (`~/alpacawork`) ni los archivos de registro para empezar de nuevo.

## Una tarea se detuvo

En las tareas de “Requiere atención”, la ejecución de la IA se detuvo. Al abrirla, el motivo aparece bajo el título.

- “Falló”: pulsa “Seguir con la misma IA”, “Seguir con otra IA” o “Detener”. Si quieres que cambie la forma de hacerlo, en lugar de pulsar un botón, escríbelo en el cuadro de texto y envíalo. Si el motivo es el límite de uso o que el modelo está saturado, pulsa “Seguir con la misma IA” cuando se restablezca el límite, o pulsa “Seguir con otra IA”, añade qué IA usar a la frase que aparece en el cuadro de texto y envíala. Aunque el límite se restablezca, no se reanuda sola.
- “Límite alcanzado”: los intercambios automáticos entre IA llegaron al número fijado (20 al principio). Si te parece bien que siga, pulsa “Continuar”.
- Motivos sin botones (“Recepción sin confirmar”, “Sin perfil de inicio”, etc.): lee el texto que aparece y da una instrucción en el cuadro de texto, como “Continúa”. Su significado está en [Motivos de detención](reference.md#motivos-de-detención).

## Enviaste algo y no avanza

El estado del envío aparece encima del cuadro de texto. Al pulsarlo, se abre la conversación con la IA que es tu punto de contacto.

- “Enviando…”, “En cola”, “Trabajando en ello…”, etc.: espera.
- “No enviado (motivo)”: lee el motivo, corrígelo y vuelve a enviarlo.
- “No se pudo confirmar si llegó”: abre la conversación y pulsa “Reenviar” o “Cancelar”.
- “No se pudo recibir una respuesta”: pulsa “Reenviar”. Los adjuntos no se reenvían, así que, si la solicitud tenía adjuntos, vuelve a escribirla y envíala. Si es por el límite de uso, espera a que se restablezca o elige otro modelo antes de enviar.
- “No se pudo iniciar el coordinador.”: consulta “Los agentes de IA no están disponibles”, más abajo.

## No sabes si una tarea está avanzando

- Si el tiempo de la fila “En curso” aumenta, la IA está trabajando.
- “La última salida es antigua”: no significa necesariamente que se haya detenido. Espera un poco y, si no cambia, pregunta en el cuadro de texto.
- “En cola” en la fila: se alcanzó el máximo de ejecuciones simultáneas y está esperando un hueco.
- “Espera a T12” en la fila: está esperando a que termine T12. Si T12 se detuvo, resuelve T12 primero.

## Reiniciaste el PC o entró en suspensión

Cuando inicias sesión en el PC, alpacawork se inicia solo y las tareas siguen como estaban. El trabajo que estaba en marcha antes de reiniciar se detiene. Abre las tareas que pasaron a “Requiere atención” y pulsa “Seguir con la misma IA”. No se reanudan solas.

Durante la suspensión, el trabajo no avanza. Un portátil se detiene al cerrar la tapa.

## La pantalla no se abre

Si aparece “No se puede acceder a este sitio web”, alpacawork no está en marcha. Inícialo y vuelve a cargar la página.

- Ejecuta `alpacawork start` en una terminal.
- Windows: al abrir Ubuntu desde el menú Inicio, alpacawork también se inicia. Deja la ventana abierta. Si aun así no se abre, ejecuta `alpacawork start` en esa ventana.

Si olvidaste la URL, consulta [Volver a abrir la pantalla](manage.md#volver-a-abrir-la-pantalla).

Desde otros dispositivos no se puede abrir `http://127.0.0.1:...`. Usa la URL `https://` de [Usarlo desde tu teléfono](remote.md#usarlo-desde-tu-teléfono) o de [un PC al que te conectas por SSH](manage.md#si-lo-instalaste-en-un-pc-al-que-te-conectas-por-ssh).

Si no se inicia desde que actualizaste Node.js, ejecuta `alpacawork setup` y presiona Enter.

## Aparece “Sin conexión” u otro aviso

- “Estás sin conexión”, “Esperando a que alpacawork responda.”: comprueba que alpacawork está en marcha (“La pantalla no se abre”, más arriba). Cuando vuelve la conexión, se recupera solo.
- “La versión de alpacawork cambió.”: pulsa “Recargar”.
- “Este equipo tiene mucha carga”: comprueba con “Ver” qué trabajo es pesado y reduce el máximo de ejecuciones simultáneas.

## Los agentes de IA no están disponibles

El estado aparece en “Agentes” de “Configuración (el engranaje) → Servidor”.

- “Requiere iniciar sesión”: ejecuta en una terminal el comando para iniciar sesión.

  | Agente de IA | Comando |
  | --- | --- |
  | Claude Code | `claude auth login` |
  | Codex | `codex login` |
  | GitHub Copilot | `gh auth login` |

- “No encontrado”: si no está instalado, instálalo. Si lo está, indica su ruta en “Ejecutable” de la tarjeta.
- “No hay ningún agente activado”: activa las IA que vas a usar.

Después de arreglarlo, haz avanzar las tareas detenidas con “Seguir con la misma IA”.

## La instalación se detiene

Corrige la causa que aparece y vuelve a ejecutar el mismo comando: sigue desde donde se quedó.

- `requires Node >=24.16.0`: instala Node.js 24 y vuelve a ejecutarlo.
- `command not found`: vuelve a abrir la terminal.
- Errores al escribir archivos, `does not run as root`: ejecútalo sin `sudo`, con un Node.js instalado con nvm u otro gestor similar.
- `User service manager is unavailable`: en WSL2, [activa systemd](manage.md#usarlo-en-windows).

Si aparece otro mensaje, pégale a la IA el texto tal cual y pregúntale.

## Qué darle a la IA cuando le consultes

Inicia Claude Code o Codex en una terminal, llama a la skill de alpacawork (`/alpacawork` o `$alpacawork`) y pásale lo siguiente.

- El texto que apareció, tal cual. El número de la tarea (como T12)
- Qué hiciste justo antes de que ocurriera
- La salida de `alpacawork workspace url`

Informa de los errores en [Issues](https://github.com/alpacakit/alpacawork/issues). Las vulnerabilidades no las escribas en un Issue: comunícalas siguiendo los pasos de [SECURITY.md](https://github.com/alpacakit/alpacawork/blob/main/SECURITY.md).
