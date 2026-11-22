# 重新打开、停止、更新

## 重新打开界面

界面的 URL（形如 `http://127.0.0.1:43127/`）在关闭浏览器或重启电脑后都不会变。请把它加入书签，或把它安装为应用：Chrome 或 Edge 用“设置（齿轮）→ 应用和手机”中的“安装”，Mac 上的 Safari 用菜单中的“文件 → 添加到程序坞”（macOS Sonoma 或更高版本）。

忘记 URL 时，在终端执行 `alpacawork open`，浏览器就会打开界面。在通过 SSH 连接的电脑这类无法打开浏览器的地方，会显示 URL 和打开的方法。

## 在 Windows 上使用

alpacawork、Node.js 和 AI 智能体，都装在 WSL2 的 Ubuntu 中。安装用的那段文字，也要贴给 Ubuntu 中的 AI。如果还没有 WSL2，把同样的文字贴给 Windows 上的 AI，它会从准备工作开始引导你。

界面用 Windows 的浏览器打开。alpacawork 只在 Ubuntu 运行期间运行。关掉所有 Ubuntu 窗口后它可能会停止，所以使用期间请保持一个窗口打开。重启 Windows 后，从开始菜单打开 Ubuntu，alpacawork 也会随之启动。

提示 systemd 未启用时，按下面的顺序启用。

1. 在 Ubuntu 中，向 `/etc/wsl.conf` 添加下面两行（需要 `sudo`）。

   ```ini
   [boot]
   systemd=true
   ```

2. 在 PowerShell 中执行 `wsl --shutdown`，然后重新打开 Ubuntu。

## 安装在通过 SSH 连接的电脑上时

那台电脑的 URL，用手边的浏览器打不开。请委托那台电脑上的 AI“让 alpacawork 可以从其他设备使用”，然后打开它告诉你的 `https://` URL。

## 停止与启动

alpacawork 会在你登录电脑时自动启动。要自己操作时，在终端执行下面的命令。

| 要做的事 | 命令 |
| --- | --- |
| 停止 | `alpacawork stop` |
| 停止后再启动 | `alpacawork start` |
| 重启 | `alpacawork restart` |
| 查看是否在运行 | `alpacawork status` |

停止服务器，正在进行的 AI 工作也不会停。要停止工作，请[停止](guide.md#搁置与停止)那个任务。

## 更新

有新版本时，设置（齿轮）上会出现标记。打开设置按“更新”，在确认界面上再按一次“更新”。完成后出现“重新加载”时，按它。

- 正在工作的 AI 不会停下，会继续工作。无法退回旧版本。
- 出现“复制暂停指示”而不是“更新”的版本，要等正在工作的 AI 停下后再安装。把复制的指示在输入框里发送，等 AI 停下后更新，然后委托“恢复之前暂停的工作”。
- 没有进展时，按设置上方显示的消息里的按钮（“重试”“继续”等）。仍然没有进展的话，找 AI 商量。

不用界面时，执行 `alpacawork deploy npm:alpacawork`。只执行 `npm install -g alpacawork`，正在运行的 alpacawork 不会变成新版本。

## 卸载

委托在终端启动的 Claude Code 或 Codex“卸载 alpacawork”，或在终端依次执行下面两条命令。AI 正在工作时无法卸载。

```sh
alpacawork uninstall
npm uninstall -g alpacawork
```

等第 1 条完成后再执行第 2 条。顺序反了，第 1 条就无法再执行。

数据存放位置（`~/alpacawork`）会保留。不需要的话请自己删除。设置文件、API 密钥文件，以及 alpacawork 安装的技能会被删除。

## 数据存放位置与向外发送的内容

任务、往来的对话和 AI 生成的文件，都在电脑上的数据存放位置（起初是 `~/alpacawork`）。其中可能留有 AI 读到的机密信息，所以不要把这个文件夹交给别人。

任务和对话的内容不会发送给开发者。向外发送的是以下内容。

- 给 AI 的指示和 AI 读取的内容：发送给你使用的 AI 的提供商（与平时使用 Claude Code 等时相同）
- 检查和获取新版本：发送给 npm
- 通知（任务编号和标题）：加密后经过浏览器的通知服务
- 使用数据：只在你选择发送时（[使用数据](telemetry.md)）

要备份时，先停止 alpacawork，再用 `cp -a ~/alpacawork <复制目标>` 复制整个文件夹。
