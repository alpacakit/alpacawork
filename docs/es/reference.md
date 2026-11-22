# Términos y comandos

Una página para consultar qué significan las palabras que ves en la pantalla. Lo que significa cada ajuste de la configuración puedes preguntárselo a la IA en el cuadro de texto.

## Nombres de los roles

| Término | Significado |
| --- | --- |
| Tú | La persona que usa la pantalla |
| Coordinador | La IA que es tu punto de contacto. Todo lo que envías desde el cuadro de texto llega aquí |
| Responsable | La IA que se encarga de una tarea |
| Miembro | Una IA a la que el responsable llama para que le ayude |
| Tarea superior, subtarea | La tarea de un nivel por encima, y las tareas de debajo en que se dividió |

## Estados de las tareas

| Término | Significado |
| --- | --- |
| En curso | La IA está trabajando |
| Por revisar | Es tu turno. Ha llegado una pregunta o un informe |
| Requiere atención | Es tu turno. La ejecución de la IA se detuvo |
| En espera | Espera otras respuestas. No es tu turno |
| Sin iniciar | Aún no ha empezado |
| En pausa | Lo que dejaste para más tarde |
| Completada | Lo terminado. También incluye las tareas detenidas |
| Error | Está detenida. En la lista aparece en “Requiere atención” |

## Motivos de detención

Aparecen en las filas de “Requiere atención”. Qué hacer está en [Solución de problemas](troubleshooting.md#una-tarea-se-detuvo).

| Término | Significado |
| --- | --- |
| Falló | La ejecución falló o terminó sin informar |
| Límite alcanzado | Los intercambios automáticos entre IA llegaron al número máximo |
| Recepción sin confirmar | No se puede comprobar si llegó a la IA. Mira el avance en “Historial” |
| Rechazada | No se aceptó la solicitud para continuar |
| Sin perfil de inicio | Ese agente de IA no está en la configuración o no está activado |
| No se puede iniciar | No se puede poner en marcha la IA a cargo |
| No se puede reanudar | No se puede continuar la conversación anterior. Indica “Continúa en una conversación nueva” |
| Límite de profundidad, Límite de solicitudes | Se alcanzó el máximo de niveles de subtareas o de solicitudes en una ejecución |
| Tiempo agotado | Se superó el tiempo máximo de una ejecución |
| Fin anticipado, No se inició | El programa del agente de IA se detuvo o no pudo iniciarse |

## Teclado

“⌘/Ctrl” es ⌘ en Mac y Ctrl en los demás.

| Tecla | Función |
| --- | --- |
| `/` | Ir al cuadro de texto |
| ⌘/Ctrl+Enter | Enviar en cualquier dispositivo (en el PC, basta con Enter) |
| `#` en el cuadro de texto | Elegir una tarea o un proyecto y adjuntarlo |
| ⌘/Ctrl+K | Buscar |
| ⌘/Ctrl+, | Abrir la configuración |
| Esc | Salir del cuadro de texto, cerrar la tarea abierta |
| H | Poner en pausa la tarea abierta |

## Comandos

Se ejecutan en una terminal (en Windows, dentro de Ubuntu). Los demás comandos son para la IA.

| Comando | Función |
| --- | --- |
| `alpacawork setup` | Instalar |
| `alpacawork setup --yes --port <número>` | Cambiar el puerto de la URL de la pantalla |
| `alpacawork setup --yes --public-host <nombre>` | Configurar el nombre `https://` para abrir la pantalla desde otros dispositivos |
| `alpacawork open` | Abrir la pantalla en el navegador |
| `alpacawork start`, `stop`, `restart` | Iniciar, detener, reiniciar |
| `alpacawork status` | Mostrar si está en marcha y la URL de la pantalla |
| `alpacawork workspace url` | Mostrar la URL de la pantalla |
| `alpacawork deploy npm:alpacawork` | Actualizar a la última versión |
| `alpacawork uninstall` | Quitarlo de este PC. La carpeta de datos se queda |
| `alpacawork --version` | Mostrar la versión instalada |
| `alpacawork telemetry off` | Dejar de enviar los datos de uso |
