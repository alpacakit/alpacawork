# Use it from Claude Code or Codex

Besides the input box on the screen, you can operate alpacawork from a Claude Code or Codex conversation opened in a terminal or its app.

## Getting started

At the start of the conversation, make one request with `/alpacawork` in front (`$alpacawork` in Codex).

```text
/alpacawork tell me about each task awaiting review, briefly, one at a time
```

The AI reads the alpacawork skill, and from then on the AI in that conversation acts as the same point of contact as the input box on the screen (the coordinator). From the second request on, you can leave out `/alpacawork`. `/alpacawork` is there to make this conversation read the skill. You don't add it in the input box on the alpacawork screen.

The work you request is carried out by the AIs that alpacawork starts. Closing this conversation does not stop it. Questions and reports arrive under "Awaiting review" on the screen, not in this conversation. To check them here, ask something like "tell me about each task awaiting review, briefly, one at a time".

## Examples of task requests

| To | Example of what to ask |
| --- | --- |
| Request a task | `make a task to fix the login screen bug and start it` |
| See tasks awaiting review | `tell me about each task awaiting review, briefly, one at a time` |
| Ask how tasks are going | `tell me how the tasks are going` |
| Find a task | `find the task that fixed the README` |
| Answer a question | `for T12's question, go with option 2` |
| Ask for a fix | `make the button text in T12 shorter` |
| Mark as done | `I checked T12. Mark it done` |
| Put on hold or stop | `put T12 on hold`, `stop T12` |
| Create a project | `make ~/code/shop a project` |

You can point to a task by its number (such as T12) or by words from its title. The same requests work in the input box on the screen.

## Operating alpacawork itself

You can also ask in this conversation to open the screen, update, restart and the like. In a terminal, the commands in the table do the same.

| To | Example of what to ask | Command |
| --- | --- | --- |
| Open the screen | `open the screen` | `alpacawork open` |
| Check whether it is running | `check whether it is running` | `alpacawork status` |
| Change a setting | `run at most 4 AIs at once` | — |
| Change the model normally used | `use opus for tasks normally` | — |
| Make a new model available | `a new Codex model is out; add it to the model settings so I can choose it` | — |
| Change the project policy | `add "use opus for design work" to the project policy` | — |
| Update to the latest version | `update to the latest version` | `alpacawork deploy npm:alpacawork` |
| Stop, start or restart | `restart alpacawork` | `alpacawork stop`, `start`, `restart` |
| Uninstall | `uninstall alpacawork` | `alpacawork uninstall`, then `npm uninstall -g alpacawork` |

The first time in a conversation, put `/alpacawork` in front of the request. Changes to settings, models and the project policy can also be requested in the input box on the screen, and updating can also be done from Settings on the screen. Stopping, restarting and uninstalling cannot be done from the input box on the screen, so do them in this conversation or in a terminal. For the other commands and how to use them, run `alpacawork -h` (details in [Reopen, stop and update](manage.md)).
