<p align="center">
  <a href="README.md">English</a> · <b>日本語</b> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/wordmark-dark.png">
    <img src="docs/images/wordmark.png" alt="alpacawork" width="380">
  </picture>
</h1>

<h3 align="center">ひとつのチャットで、すべての AI エージェントを操作しよう。</h3>

<p align="center">
  頼みごとを書くと、PC の Claude Code や Codex などの AI エージェントが仕事を分けて同時に進めます。<br/>
  あなたは AI からの質問に答えて、できあがりを確かめます。スマートフォンからも使えます。
</p>

<p align="center">
  <a href="#インストール"><b>インストール</b></a> ·
  <a href="docs/ja/getting-started.md">はじめかた</a> ·
  <a href="docs/ja/concept.md">考え方</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/alpacawork"><img alt="npm" src="https://img.shields.io/npm/v/alpacawork?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark-ja.gif">
    <img src="docs/images/hero-ja.gif" alt="1つの入力欄に書いた依頼を窓口の AI が受け、自社サイト・アプリ開発・マーケティングの3つのプロジェクトにタスクを作り、それぞれに opus · high や gpt-5 · high などの AI を付けて進める。1つのタスクが質問し、答えるとすべて終わる" width="640">
  </picture>
</p>

## alpacawork とは

alpacawork は、AI を連携させて仕事を進めるツール（タスクベースの AI オーケストレーションツール）です。いつもの Claude Code や Codex を「1つのチャット欄」からすべて操作できます。

チャット欄に常駐する窓口の AI（コーディネーター）に頼むだけで、作業の状況を確かめ、作業する AI への指示まで進めてくれます。これにより、自分でタスクを分けたり、AI に細かく指示を出したりする苦痛から解放されます。

<p align="center">
  <img src="docs/images/demo-dark-ja.gif" alt="左に流れの図、右に本物の画面。入力欄に書いた依頼を窓口の AI がタスクにし、3つの案に別々の AI（Claude と Codex）を付けて同時に進める。途中の変更も同じ入力欄から担当の AI に届く。利用上限で止まった AI は別の AI に替わって記録から続け、会話が長くなると自動で圧縮し、さらに伸びたら新しい会話で続ける。質問には案を選んで答え、スマートフォンで右へスワイプして完了にする" width="800">
</p>

### チャットの切り替え不要

頼みごとも、作業中の AI への追加や変更も、1つの入力欄に書くだけ。窓口の AI（コーディネーター）が依頼をタスクにして、担当の AI に任せます。コーディネーターは、複数の[プロジェクト](docs/ja/projects.md#プロジェクトを増やす)にまたがって指示を出すことができます。

### いまの Claude Code や Codex をそのまま使える

いまのログインで、いつものリポジトリからすぐ始められます。専用のアカウントや API キーは不要。`AGENTS.md`、`CLAUDE.md`、スキル、MCP、Hooks もそのまま使えます。GitHub Copilot、Grok Build、pi（ローカルモデル）にも対応（[使う AI](docs/ja/projects.md#使う-ai)）。

### あなたの PC で動く

Claude Code や Codex と同じく、あなたの PC で動きます。タスクや会話、成果のファイルは PC に保存され、外部のサーバーに送信されることはありません（[データの扱い](docs/ja/manage.md#データの置き場と外へ送られるもの)）。

### AI を替えても続きから再開

エラーや利用上限で止まっても、別の AI（Claude Code → Codex など）に替えて続きから再開できます（[止まったタスク](docs/ja/guide.md#止まったタスク)）。[予備の AI](docs/ja/projects.md#モデルを選ぶ) を選んでおけば、上限で止まったときにも別の AI が自動で立ち上がり、作業を続けます。

### 会話が長くなったら、AI が自分で仕切り直す

AI は会話が長くなるほど、指示の見落としや思い込みで精度が落ちることが研究で示されています（[Li ほか 2024](https://arxiv.org/abs/2402.10962)、[Laban ほか 2025](https://arxiv.org/abs/2505.06120)）。alpacawork では、AI が自分で判断して会話を圧縮したり、要点をまとめたタスクの記録から新しい会話で仕切り直したりします。

### 進め方は言葉で

難しい設定は不要で、チャットで指示するだけ。「案を3つ、別々のモデルで作って。まとめたら別の AI にレビューさせて」のように、モデルの指定や複数の AI での作業もできます（[進め方は言葉で伝える](docs/ja/concept.md#進め方は言葉で伝える)）。

### スマートフォンでも作業が進む

依頼も、質問への回答も、できあがりの確認もスマホで。スワイプで快適に操作できます（[スマートフォンで使う](docs/ja/remote.md#スマートフォンで使う)）。

### 質問は選んで答える

AI が決められないことは、選択肢とおすすめ付きの質問で届きます。AI が修正後の画面や操作の動画も付けてくれるので、判断しやすくなっています。

### 会話ではなくタスク

画面に並ぶのは AI との会話ではなく、あなたのタスクです。情報がタスクごとに自動で整理されるので、人にも AI にも仕事が進めやすくなります（[考え方](docs/ja/concept.md#仕事は会話ではなくタスクを単位に進む)）。

## インストール

PC の Claude Code や Codex に、次の文を貼り付けます。AI が alpacawork をインストールし、セットアップの画面の URL を伝えます。ふつうはブラウザでも開きます。

```text
次のドキュメントをダウンロードして全文を読み、その手順に従ってこの PC に alpacawork をインストールしてください。
https://raw.githubusercontent.com/alpacakit/alpacawork/main/skills/alpacawork/references/setup.md
```

コマンドで入れるときは、ターミナル（Windows では Ubuntu の中）で次の2行を順に実行します。セットアップは、設定する内容を表示し、Enter を押すと始まります。

```sh
npm install -g alpacawork
alpacawork setup
```

動作環境は macOS（Apple シリコン）、Linux（x64）、Windows（WSL2）です。入れたあとは [はじめかた](docs/ja/getting-started.md) に沿って、最初の1件を頼みます。

### 画面を開く

ブラウザで画面を開く場合、Claude Code か Codex で次のように頼みます（Codex では `$alpacawork`）。

```text
/alpacawork 画面を開いて
```

ターミナルなら `alpacawork open` でも開けます。

## 知っておくこと

- **無料です（MIT License）。** AI の利用料は、お使いの Claude Code や Codex などの契約のとおりです。
- **あなたの PC で動きます。** 使っている間は PC を起動したまま、スリープしない設定にします。
- **AI エージェントは、Claude Code の `bypassPermissions` や Codex の `danger-full-access` と同じ、確認を求めない設定で起動します。** やってほしくないことや、確認してほしいことは、[プロジェクト方針](docs/ja/projects.md#プロジェクト方針) に書けます。
- **タスクや会話、成果のファイルは PC に保存されます。** alpacawork の開発元が、これらを外部サーバーに送信することはありません。AI への指示や AI が読んだ内容は、各 AI エージェントを直接使う場合と同じように、AI の提供元へ送られます（[詳しいデータの扱い](docs/ja/manage.md#データの置き場と外へ送られるもの)）。

## ドキュメント

- [はじめかた](docs/ja/getting-started.md) — 入れて、1件頼んで、確かめるまで
- [ドキュメントの入口](docs/ja/README.md) — 使いかた、設定、困ったときなど、全ページの一覧
- 不具合の報告は [Issues](https://github.com/alpacakit/alpacawork/issues) へお願いします
- リリースのお知らせは、X の [@codemafia0000](https://x.com/codemafia0000) で発信しています

## ライセンス

[MIT License](LICENSE)
