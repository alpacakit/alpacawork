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

alpacawork は、AI オーケストレーションツールです。あなたの PC に入っている Claude Code や Codex などの AI エージェントを、1つのチャットからまとめて動かせます。やりたいことを書くと、窓口の AI（コーディネーター）がタスクにして担当の AI に割り振り、進み具合を管理します。あなたがするのは、頼む、質問に答える、できあがりを確かめる、の3つです。スマートフォンからも同じように使えます。

<p align="center">
  <img src="docs/images/demo-dark-ja.webp" alt="スマートフォンの入力欄に依頼を1つ書いて送ると、PC の一覧に3つのタスクができて並行で進む。届いた報告を確かめて右へスワイプで完了にし、AI の質問には案を選んで答える。最後に、スマートフォンと PC を並べた全体" width="800">
</p>

## 会話ではなく、タスクを単位に進める

AI エージェントを使うツールの多くは、AI との会話を単位に仕事を進めます。alpacawork は、タスクを単位に進めます。そのため画面の中心にあるのは、AI との会話ではなくタスクの一覧です。タスクごとに要る AI を割り当て、結果とあなたへの質問もタスクごとにまとまります。会話を新しくしても、AI を替えても、仕事を子タスクに分けても、経緯はタスクに残ります。理由は [考え方](docs/ja/concept.md#会話ではなくタスクを単位に進める) に書いています。

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

## できること

依頼から完了までの流れを、実際の画面で見られます（約100秒、音なし）。

https://github.com/user-attachments/assets/00353d76-ca96-432a-adb0-ed971e72fe25

- **頼みごとは、1つの入力欄に書くだけ。** コーディネーターが依頼をタスクにして、担当の AI に任せます。作業ごとに会話や AI を切り替える必要はありません。
- **複数の AI を、AI が横断して管理する。** 作業中の AI への追加や変更も、コーディネーターに伝えるだけです。「作業中の3つとも、スマホ表示も確認して」と書けば、コーディネーターが、3つを進めている AI それぞれに指示します。
- **進め方を言葉で伝えると、AI 同士が連携して進める。** 「案を3つ、別々のモデルで作って。1つにまとめたら、別の AI にレビューさせて、直してから報告して」のような込み入った進め方も、そのとおりに AI が管理し、AI 同士でやり取りしながらこなします。
- **AI からの質問には、案とおすすめが付く。** 質問も報告も、画像や動画を添えて届きます。案を選べば答えられます。
- **スマートフォンに最適化した画面。** 質問への回答も、できあがりの完了も、右へのスワイプで済みます。依頼から完了まで、スマートフォンだけで終えられます。PC のブラウザでも同じように使えます。
- **いつもの環境のまま動く。** `AGENTS.md` や `CLAUDE.md`、スキル、MCP、Hooks が、そのまま使われます。alpacawork 用のアカウントや API キーは要りません。すでにあるリポジトリのフォルダを作業フォルダにすれば、そのまま始められます。

## 知っておくこと

- **無料です（MIT License）。** AI の利用料は、お使いの Claude Code や Codex などの契約のとおりです。
- **あなたの PC で動きます。** AI は PC で動くので、使っている間は PC を起動したまま、スリープしない設定にします。
- **AI エージェントは、Claude Code の `bypassPermissions` や Codex の `danger-full-access` と同じ、確認を求めない設定で起動します。** やってほしくないことや、確認してほしいことは、[プロジェクト方針](docs/ja/projects.md#プロジェクト方針) に書けます。
- **タスクや会話、成果のファイルは PC に保存されます。** alpacawork の開発元が、これらを外部サーバーに送信することはありません。AI への指示や AI が読んだ内容は、各 AI エージェントを直接使う場合と同じように、AI の提供元へ送られます（[詳しいデータの扱い](docs/ja/manage.md#データの置き場と外へ送られるもの)）。

## ドキュメント

- [はじめかた](docs/ja/getting-started.md) — 入れて、1件頼んで、確かめるまで
- [ドキュメントの入口](docs/ja/README.md) — 使いかた、設定、困ったときなど、全ページの一覧
- 不具合の報告は [Issues](https://github.com/alpacakit/alpacawork/issues) へお願いします
- リリースのお知らせは、X の [@codemafia0000](https://x.com/codemafia0000) で発信しています

## ライセンス

[MIT License](LICENSE)
