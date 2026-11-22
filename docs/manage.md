# Reopen, stop and update

## Open the screen again

The screen's URL (in the form `http://127.0.0.1:43127/`) stays the same after you close the browser or restart the PC. Bookmark it, or in Chrome or Edge, install it as an app with "Install" at the right end of the address bar.

If you forgot the URL, run `alpacawork open` in a terminal and the screen opens in your browser. Where a browser can't be opened, such as on a PC you connect to over SSH, it prints the URL and how to open it.

## On Windows

Install alpacawork, Node.js and the AI agents inside Ubuntu on WSL2. Paste the install text into an AI inside Ubuntu, too. If you don't have WSL2, paste the same text into an AI on Windows, and it walks you through getting ready.

You open the screen in a browser on Windows. alpacawork runs only while Ubuntu is running. If you close every Ubuntu window, it may stop, so keep one open while you use it. After restarting Windows, open Ubuntu from the Start menu, and alpacawork starts too.

If you are told systemd is off, turn it on in this order.

1. In Ubuntu, add these two lines to `/etc/wsl.conf` (this needs `sudo`).

   ```ini
   [boot]
   systemd=true
   ```

2. Run `wsl --shutdown` in PowerShell, and open Ubuntu again.

## On a PC you connect to over SSH

That PC's URL can't be opened in the browser at hand. Ask the AI on that PC, "Make alpacawork usable from other devices." Then open the `https://` URL it gives you.

## Stop and start

alpacawork starts by itself when you log in to the PC. To control it yourself, run these in a terminal.

| To | Command |
| --- | --- |
| Stop it | `alpacawork stop` |
| Start it after stopping | `alpacawork start` |
| Restart it | `alpacawork restart` |
| See whether it's running | `alpacawork status` |

Stopping the server doesn't stop AI work in progress. To stop the work, [stop](guide.md#put-on-hold-or-stop) the task.

## Update

When a new version is out, a mark appears on Settings (the gear). Open Settings, press "Update", and press "Update" again on the confirmation screen. When it finishes and "Reload" appears, press it.

- AIs at work carry on without stopping. You can't go back to the earlier version.
- For a version that shows "Copy the pause instruction" instead of "Update", install it after the AIs at work have stopped. Send the copied instruction in the input box, update once the AIs have stopped, then ask "Resume the work you paused."
- If the update gets stuck, press the button in the message shown at the top of Settings ("Try again", "Continue" and so on). If it is still stuck, ask an AI for help.

Without the screen, run `alpacawork deploy npm:alpacawork`. `npm install -g alpacawork` alone doesn't update the alpacawork that is running.

## Uninstall

Ask Claude Code or Codex started in a terminal, "Uninstall alpacawork." Or run these two in order in a terminal. You can't while an AI is working.

```sh
alpacawork uninstall
npm uninstall -g alpacawork
```

Run the second only after the first has finished. In the other order, you can't run the first again.

The data folder (`~/alpacawork`) stays. Delete it yourself if you don't need it. The settings and API key files, and the skills alpacawork installed, are removed.

## Where your data is, and what is sent out

Tasks, conversations and the files the AI made are in the data folder on your PC (`~/alpacawork` at first). Secrets the AI read may be left there, so don't give this folder to anyone.

The contents of tasks and conversations are not sent to the developer. What goes out is the following.

- Instructions to the AI and what the AI reads: to your AI's provider (the same as when you use Claude Code and the like on their own)
- Checking for and getting new versions: to npm
- Notifications (the task's number and title): through the browser's notification service, encrypted
- Usage data: only if you chose to send it ([Usage data](telemetry.md))

To make a backup, stop alpacawork, then copy the whole folder with `cp -a ~/alpacawork <destination>`.
