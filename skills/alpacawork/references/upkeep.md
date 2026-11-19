# Upkeep

Clear away accumulated information and keep the tree easy to read. An owner does "Tidying accumulated information" when a "scale signal" appears (["Reports" in Owner](owner.md#reports)), at the breakpoint of a merge into main, and before reporting the end. The coordinator does "Tending the tree" when a top task ends and when putting the tree in order.

## Tidying accumulated information

- Field values: do not append; rewrite them into the conclusions, conditions and remaining work that are in effect now (["Reports" in Owner](owner.md#reports)).
- Work locations: once a worktree, working branch or temporary copy has been merged into main, the agent that created it deletes it at that breakpoint. Do not delete things used in the current or the next work, unmerged changes that have no other copy, or uncommitted changes.
- Test output, logs and copies: keep them where ["Reports" in Owner](owner.md#reports) says, and delete the ones whose purpose is over. Do not move them into the task folder as a way of tidying up.
- Things that belong to members and children: the next time you ask that agent for something, ask it to delete them as well (do not wake it only to tidy up). When there is no one to ask (the agent was released or has finished), the owner deletes the things at the locations given in that agent's reply whose purpose is over, judged by the criteria in ["Reports" in Owner](owner.md#reports) (the same criteria say what not to delete). Do not search by name for things whose location is not in the reply and delete them.
- Records: record tidying as a milestone only when it amounts to a change a person needs to know about, such as resolving a shortage of storage space. Do not make a list of each thing deleted or a record of cross-checks.
- Long-running things: stop them as ["Guardrails" in the main skill](../SKILL.md#guardrails) says. Do not stop permanent ones (things kept running as a result).
- Task folder: the task's owner also deletes things that have already piled up there once their purpose is over, by the same criteria in ["Reports" in Owner](owner.md#reports).

## Tending the tree

Archiving, restoring and deleting can be done by a person, or by the coordinator quoting the user's words (deleting requires a quote from the user's current message; see ["Authority" in coordinator.md](coordinator.md#authority)). alpacawork works even if none of them is ever done.

- Ending placements: the placements of a finished task can be ended with `agent release` (see its `-h` for when a placement can be ended). Placement operations are possible only while the task is active, so finish them before archiving. If an owner releases a member, it does so before reporting the end.
- Archive: archive finished work instead of deleting it. The files stay, the task leaves the tree, and `task restore` brings it back. A task can be archived only when it has no children (archived children included) and no unfinished Runs. In a finished branch, archive starting from the tasks that have no children, and leave the parent. A project can be archived even when it has children, as long as there is below it no task that is in progress, waiting for a reply, failed or awaiting review (a task on hold in one of these states counts too), and no unfinished Run; what is below it then leaves the tree list (the state of each child does not change). An open request to an archived child returns to the requester as "closed".
- Delete: use it only for tasks created by mistake. Do not delete a child in order to archive. Even after deletion the files stay, and `task restore` brings the task back.
