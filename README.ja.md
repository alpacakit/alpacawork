<p align="center">
  <a href="README.md">English</a> · <b>日本語</b> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/wordmark-dark.png">
    <img src="docs/images/wordmark.png" alt="alpacawork" width="380">
  </picture>
</h1>

<h3 align="center">AI の管理は、AI に任せる。</h3>

<p align="center">
  Claude Code・Codex への仕事の割り振りも、<br/>進み具合の見張りも。<br/>
  PC の前に座って働くことから、解放されます。
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

<!-- The intro video goes here once it is uploaded on github.com: one line holding the URL GitHub gives. Then move the picture below to the end of the features list. -->

<p align="center">
  <img src="docs/images/pc-phone-dark-ja.png" alt="PC のブラウザで、作業中の10件と確認待ちの3件が並ぶ一覧と、開いたタスクの報告を横に並べた alpacawork。右に、同じ報告を開いたスマートフォン" width="820">
</p>

alpacawork は、あなたの PC に入っている Claude Code や Codex に仕事を割り振って動かす道具（AI ハーネス）です。やりたいことを1つのチャット欄に書くと、窓口の AI（コーディネーター）がタスクにして担当の AI に割り振り、進み具合を管理します。あなたがするのは、頼む、質問に答える、できあがりを確かめる、の3つです。スマートフォンからも同じように使えます。

## インストール

PC の Claude Code や Codex に、次の文を貼り付けます。AI が alpacawork をインストールし、セットアップの画面の URL を伝えます。ふつうはブラウザでも開きます。

```text
次のドキュメントをダウンロードして全文を読み、その手順に従ってこの PC に alpacawork をインストールしてください。
https://raw.githubusercontent.com/alpacakit/alpacawork/main/skills/alpacawork/references/setup.md
```

コマンドで入れるときは、ターミナル（Windows では Ubuntu の中）で次の2行を順に実行します。セットアップは、設定する内容を表示し、Enter を押すと始まります。終わると、画面の URL を `開く:` の行（ターミナルが英語のときは `Open:`）に出し、ふつうはブラウザでも開きます。

```sh
npm install -g alpacawork
alpacawork setup
```

- **動作環境:** macOS（Apple シリコン）、Linux（x64）、Windows（WSL2 の中）。サインイン済みの Claude Code や Codex などの AI エージェントと、Node.js 24.16 以降が要ります（AI に頼む入れ方では、Node.js が無ければ AI が入れます）。[詳しい動作環境](docs/ja/getting-started.md#始める前に)
- **画面を開く:** ブラウザが開かなかったときや、閉じたあと・PC を再起動したあとに開き直すときは、[画面を開く](docs/ja/getting-started.md#2-画面を開く) を見てください。
- **入れたあと:** [最初の依頼を出す](docs/ja/getting-started.md#4-最初の依頼を出す)。スマートフォンから使うときは、Tailscale などの VPN で PC につなぎます（[スマートフォンで使う手順](docs/ja/guide.md#スマートフォンで使う)）。
- **止める・アンインストール:** [止める・更新する・アンインストールする](docs/ja/guide.md#止める更新するアンインストールする)

## できること

- **頼みごとは、1つのチャット欄に書くだけ。** コーディネーターが依頼をタスクにして、担当の AI に任せます。作業ごとにチャットや AI を切り替える必要はありません。
- **複数の AI を、AI が横断して管理する。** 作業中の AI への追加や変更も、コーディネーターに伝えるだけです。「作業中の3つとも、スマホ表示も確認して」と書けば、コーディネーターが、3つを進めている AI それぞれに指示します。
- **進め方を言葉で伝えると、AI 同士が連携して進める。** 「案を3つ、別々のモデルで作って。1つにまとめたら、別の AI にレビューさせて、直してから報告して」のような込み入った進め方も、そのとおりに AI が管理し、AI 同士でやり取りしながらこなします。
- **AI からの質問には、案とおすすめが付く。** 質問も報告も、画像や動画を添えて届きます。案を選べば答えられます。
- **スマートフォンに最適化した画面。** 質問への回答も、できあがりの完了も、右へのスワイプで済みます。依頼から完了まで、スマートフォンだけで終えられます。PC のブラウザでも同じように使えます。
- **いつもの環境のまま動く。** `AGENTS.md` や `CLAUDE.md`、スキル、MCP、Hooks が、そのまま使われます。alpacawork 用のアカウントや API キーは要りません。

## 知っておくこと

- **無料です（MIT License）。** AI の利用料は、お使いの Claude Code や Codex などの契約のとおりです。
- **あなたの PC で動きます。** AI は PC で動くので、使っている間は PC を起動したまま、スリープしない設定にします。
- **AI エージェントは、Claude Code の `bypassPermissions` や Codex の `danger-full-access` と同じ、確認を求めない設定で起動します。** やってほしくないことや、確認してほしいことは、[プロジェクト方針](docs/ja/guide.md#ai-への約束ごとを書く) に書けます。
- **タスクや会話、成果のファイルは PC に保存されます。** alpacawork の開発元が、これらを外部サーバーに送信することはありません。AI への指示や AI が読んだ内容は、各 AI エージェントを直接使う場合と同じように、AI の提供元へ送られます（[詳しいデータの扱い](docs/ja/guide.md#保存されるもの外へ送られるもの)）。

## ドキュメント

- [はじめかた](docs/ja/getting-started.md) — インストールから、画面を開いて最初の依頼を出し、できあがりを確かめるまで
- [使いかた](docs/ja/guide.md) — 画面の開き直し方、自分のリポジトリでの使い方、AI への約束ごと、スマートフォン、更新とアンインストール
- [alpacawork の考え方](docs/ja/concept.md) — 1つの依頼がどう進むかと、設計の考え方
- [画面が開かないとき](docs/ja/guide.md#画面が開かないとき) — ブラウザでつながらないとき
- [困ったとき](docs/ja/guide.md#困ったとき) — そのほか、うまく動かないとき。不具合の報告は [Issues](https://github.com/alpacakit/alpacawork/issues) へお願いします

## ライセンス

[MIT License](LICENSE)
