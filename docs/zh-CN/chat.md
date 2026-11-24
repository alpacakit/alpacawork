# 从 Claude Code 或 Codex 使用

也可以在 Claude Code 或 Codex 的对话中操作 alpacawork。

## 开始方法

只在对话的第一次请求前加上 `/alpacawork`（在 Codex 中是 `$alpacawork`）。

```text
/alpacawork 把待验收的任务一件一件简短地告诉我
```

之后，这个对话里的 AI 就会作为对接 AI（协调员）工作。在 alpacawork 界面的输入框中，不需要 `/alpacawork`。

委托的工作由负责的 AI 推进，所以关闭对话也不会停止。提问和报告会送到界面的“待验收”。

## 任务的说法示例

| 要做的事 | 说法示例 |
| --- | --- |
| 委托任务 | `建一个修复登录界面问题的任务并开始` |
| 查看待验收的任务 | `把待验收的任务一件一件简短地告诉我` |
| 询问任务进展 | `告诉我任务的进展` |
| 查找任务 | `找一下修改 README 的任务` |
| 回答提问 | `T12 的提问按方案 2 进行` |
| 要求修改 | `把 T12 的按钮文字改短一些` |
| 设为完成 | `T12 我确认过了，设为完成` |
| 搁置、停止 | `搁置 T12`、`停止 T12` |
| 创建项目 | `把 ~/code/shop 设为项目` |

任务可以用编号（如 T12）或标题中的词来指定。同样的说法在界面的输入框中也能用。

## alpacawork 本身的操作

| 要做的事 | 说法示例 | 命令 |
| --- | --- | --- |
| 打开界面 | `打开界面` | `alpacawork open` |
| 查看是否在运行 | `看看是否在运行` | `alpacawork status` |
| 更改设置 | `同时最多运行 4 个 AI` | — |
| 更改首选模型 | `让任务平时用 opus 来做` | — |
| 让新模型可用 | `Codex 出了新模型，把它加到模型设置里以便选择` | — |
| 更改项目准则 | `在项目准则中加上“设计工作用 opus 来做”` | — |
| 更新到最新版本 | `更新到最新版本` | `alpacawork deploy npm:alpacawork` |
| 停止、启动、重启 | `重启 alpacawork` | `alpacawork stop`、`start`、`restart` |
| 卸载 | `卸载 alpacawork` | `alpacawork uninstall`，然后 `npm uninstall -g alpacawork` |

设置、模型和项目准则的更改，也可以在界面的输入框中提出。停止、重启和卸载无法在界面的输入框中进行。其他命令可用 `alpacawork -h` 查看（[重新打开、停止、更新](manage.md)）。
