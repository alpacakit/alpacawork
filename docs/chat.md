# Use it from Claude Code or Codex

Besides the input box on the screen, you can operate alpacawork from a Claude Code or Codex conversation opened in a terminal or its app.

## Getting started

At the start of the conversation, make one request with `/alpacawork` in front (`$alpacawork` in Codex).

```text
/alpacawork tell me about each task awaiting review, briefly, one at a time
```

The AI reads the alpacawork skill, and from then on the AI in that conversation acts as the same point of contact as the input box on the screen (the coordinator). From the second request on, you can leave out `/alpacawork`.

The work you request is carried out by the AIs that alpacawork starts. Closing this conversation does not stop it. Questions and reports arrive under "Awaiting review" on the screen, not in this conversation. To check them here, ask something like "tell me about each task awaiting review, briefly, one at a time".

## Examples of what to ask

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

You can point to a task by its number (such as T12) or by words from its title. The same requests work in the input box on the screen (without `/alpacawork`). Opening the screen, changing settings or models, updating and the like are in ["Common operations" in the README](../README.md#common-operations).
