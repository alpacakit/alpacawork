# 開き直す・止める・更新する

## 画面を開き直す

画面の URL（`http://127.0.0.1:43127/` のような形）は、ブラウザを閉じても PC を再起動しても変わりません。ブックマークするか、Chrome や Edge ならアドレス欄の右端の「インストール」でアプリとして入れておきます。

URL を忘れたときは、PC の Claude Code や Codex に「alpacawork の画面を開いて」と頼むと、ブラウザで開きます。URL は、ターミナルで `alpacawork workspace url` を実行しても確かめられます（`"localUrl"` のあとの URL）。

## Windows で使うとき

alpacawork、Node.js、AI エージェントは、WSL2 の Ubuntu の中に入れます。インストールの文も、Ubuntu の中の AI に貼ります。WSL2 が無ければ、Windows の AI に同じ文を貼ると準備から案内します。

画面は Windows のブラウザで開きます。alpacawork は Ubuntu が動いている間だけ動きます。Ubuntu のウィンドウをすべて閉じると止まることがあるので、使っている間は1つ開いたままにします。Windows を再起動したら、スタートメニューから Ubuntu を開くと、alpacawork も起動します。

systemd が無効と言われたときは、Ubuntu の `/etc/wsl.conf` に `[boot]` と `systemd=true` の2行を足し、PowerShell で `wsl --shutdown` を実行してから Ubuntu を開き直します。

## SSH でつないだ PC に入れたとき

その PC の URL は、手元のブラウザでは開けません。その PC の AI に「alpacawork をほかの端末から使えるようにして」と頼み、伝えられた `https://` の URL を開きます。

## 止める・起動する

alpacawork は PC にログインすると自動で起動します。自分で操作するときは、ターミナルで次を実行します。

- Linux・WSL2: `systemctl --user stop alpacawork.service`（`start`、`restart`、`status` も同じ形）
- macOS: 止める `launchctl bootout gui/$(id -u)/alpacawork.service`、止めたあとに起動する `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/alpacawork.service.plist`、再起動する `launchctl kickstart -k gui/$(id -u)/alpacawork.service`

サーバーを止めても、動いている AI の作業は止まりません。作業を止めるときは、タスクを [中止](guide.md#保留中止) します。

## 更新する

新しい版が出ると、設定（歯車）に印が付きます。設定を開いて「アップデート」を押し、確認の画面でもう一度「アップデート」を押します。終わって「再読み込み」が出たら押します。

- 作業中の AI は止まらずに続きます。前の版には戻せません。
- 「アップデート」の代わりに「止める指示をコピー」が出る版は、作業中の AI が止まってから入れます。コピーした指示を入力欄で送り、AI が止まったら更新し、そのあと「止めていた作業を再開して」と頼みます。
- 進まないときは、設定の上に出る文のボタン（「再試行」「続ける」など）を押します。それでも進まなければ AI に相談します。

画面を使わないときは `alpacawork deploy npm:alpacawork` を実行します。`npm install -g alpacawork` だけでは、動いている alpacawork は新しくなりません。

## アンインストールする

ターミナルで起動した Claude Code や Codex に「alpacawork をアンインストールして」と頼むか、ターミナルで次の2つを順に実行します。AI が作業している間はできません。

```sh
alpacawork uninstall
npm uninstall -g alpacawork
```

1つ目が終わってから2つ目を実行します。逆にすると、1つ目をやり直せなくなります。

データの置き場（`~/alpacawork`）は残ります。要らなければ自分で消します。設定と API キーのファイル、alpacawork が入れたスキルは消えます。

## データの置き場と外へ送られるもの

タスク、やり取り、AI が作ったファイルは、PC のデータの置き場（初めは `~/alpacawork`）にあります。AI が読んだ秘密が残ることがあるので、このフォルダを人に渡しません。

開発元には、タスクや会話の中身は送られません。外へ出るのは次のものです。

- AI への指示と AI が読んだ内容: お使いの AI の提供元へ（ふだん Claude Code などを使うときと同じ）
- 新しい版の確認と取得: npm へ
- 通知（タスクの番号と題）: ブラウザの通知サービスを暗号化されて通ります
- 使用統計データ: 送ると選んだときだけ（[使用統計データ](telemetry.md)）

控えを取るときは、alpacawork を止めてから `cp -a ~/alpacawork <コピー先>` でフォルダごとコピーします。
