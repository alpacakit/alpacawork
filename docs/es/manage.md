# Volver a abrir, detener y actualizar

## Volver a abrir la pantalla

La URL de la pantalla (con la forma `http://127.0.0.1:43127/`) no cambia aunque cierres el navegador o reinicies el PC. Guárdala en marcadores o, en Chrome o Edge, instálala como app con “Instalar”, en el extremo derecho de la barra de direcciones.

Si olvidaste la URL, ejecuta `alpacawork open` en una terminal y la pantalla se abrirá en el navegador. Donde no se puede abrir un navegador, como en un PC al que te conectas por SSH, muestra la URL y cómo abrirla.

## Usarlo en Windows

alpacawork, Node.js y los agentes de IA se instalan dentro de Ubuntu en WSL2. El texto de instalación también se pega en la IA de dentro de Ubuntu. Si no tienes WSL2, pega el mismo texto en la IA de Windows y te guiará desde la preparación.

La pantalla se abre en el navegador de Windows. alpacawork solo funciona mientras Ubuntu está en marcha. Si cierras todas las ventanas de Ubuntu, puede detenerse, así que deja una abierta mientras lo usas. Después de reiniciar Windows, al abrir Ubuntu desde el menú Inicio, alpacawork también se inicia.

Si te dice que systemd está desactivado, actívalo así:

1. En Ubuntu, añade estas dos líneas a `/etc/wsl.conf` (necesitas `sudo`).

   ```ini
   [boot]
   systemd=true
   ```

2. En PowerShell, ejecuta `wsl --shutdown` y vuelve a abrir Ubuntu.

## Si lo instalaste en un PC al que te conectas por SSH

La URL de ese PC no se abre en el navegador de tu equipo. Pide a la IA de ese PC “Haz que alpacawork se pueda usar desde otros dispositivos” y abre la URL `https://` que te indique.

## Detener e iniciar

alpacawork se inicia solo cuando inicias sesión en el PC. Para manejarlo tú, ejecuta lo siguiente en una terminal.

| Qué hacer | Comando |
| --- | --- |
| Detener | `alpacawork stop` |
| Iniciar después de detenerlo | `alpacawork start` |
| Reiniciar | `alpacawork restart` |
| Ver si está en marcha | `alpacawork status` |

Detener el servidor no detiene el trabajo de las IA en marcha. Para detener el trabajo, [detén](guide.md#pausar-y-detener) la tarea.

## Actualizar

Cuando sale una versión nueva, aparece una marca en la configuración (el engranaje). Abre la configuración, pulsa “Actualizar” y vuelve a pulsar “Actualizar” en la pantalla de confirmación. Cuando termine y aparezca “Recargar”, púlsalo.

- Las IA que estén trabajando siguen sin detenerse. No se puede volver a la versión anterior.
- En las versiones en que aparece “Copiar instrucción de pausa” en lugar de “Actualizar”, la actualización se instala cuando se han detenido las IA que estaban trabajando. Envía en el cuadro de texto la instrucción copiada, actualiza cuando las IA se detengan y después pide “Reanuda el trabajo que se había detenido”.
- Si no avanza, pulsa el botón del texto que aparece encima de la configuración (“Reintentar”, “Continuar”, etc.). Si aun así no avanza, consúltale a la IA.

Si no usas la pantalla, ejecuta `alpacawork deploy npm:alpacawork`. Con solo `npm install -g alpacawork`, el alpacawork que está en marcha no se actualiza.

## Desinstalar

Pide “Desinstala alpacawork” a Claude Code o Codex iniciado en una terminal, o ejecuta estos dos comandos en orden en una terminal. No se puede mientras una IA está trabajando.

```sh
alpacawork uninstall
npm uninstall -g alpacawork
```

Ejecuta el segundo cuando haya terminado el primero. Si lo haces al revés, ya no podrás volver a ejecutar el primero.

La carpeta de datos (`~/alpacawork`) se queda. Si no la necesitas, bórrala tú. Los archivos de configuración y de claves de API, y las skills que instaló alpacawork, se eliminan.

## Dónde se guardan los datos y qué se envía fuera

Las tareas, las conversaciones y los archivos que crea la IA están en la carpeta de datos del PC (al principio, `~/alpacawork`). Pueden quedar secretos que leyó la IA, así que no se la des a nadie.

Al desarrollador no se le envía el contenido de las tareas ni de las conversaciones. Lo que sale fuera es lo siguiente:

- Las instrucciones a la IA y lo que lee la IA: al proveedor de tu IA (igual que cuando usas Claude Code u otro directamente)
- La comprobación y la descarga de versiones nuevas: a npm
- Las notificaciones (el número y el título de la tarea): pasan cifradas por el servicio de notificaciones del navegador
- Los datos de uso: solo si eliges enviarlos ([Datos de uso](telemetry.md))

Para hacer una copia de seguridad, detén alpacawork y copia la carpeta entera con `cp -a ~/alpacawork <destino>`.
