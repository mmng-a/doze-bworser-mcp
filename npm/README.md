# npm配布物の作成・検証・公開

利用者向けの導入方法は [README.ja.md](../README.ja.md) に記載しています。この文書は配布物の保守手順です。作成・導入テストのコマンドとCIは、レジストリへの公開を行いません。

| 配布先 | Rustターゲット | ネイティブパッケージ |
| --- | --- | --- |
| macOS arm64 | `aarch64-apple-darwin` | `doze-bworser-mcp-darwin-arm64` |
| macOS x64 | `x86_64-apple-darwin` | `doze-bworser-mcp-darwin-x64` |
| Windows x64 | `x86_64-pc-windows-msvc` | `doze-bworser-mcp-win32-x64` |
| Linux x64、glibc、Ubuntu 22.04以降相当 | `x86_64-unknown-linux-gnu` | `doze-bworser-mcp-linux-x64` |

メインパッケージ `doze-bworser-mcp` が、npmの `optionalDependencies` と各パッケージの `os`・`cpu` で実行ファイルを選びます。Linux版はglibc向けです。対応するネイティブパッケージがない場合は起動時にエラーにします。利用端末ではRustのビルドを行わず、Node.js 22.12以降を使います。Git管理下の保存領域の判定にはGitも必要です。専用Chromeは従来どおり初回利用時に取得します。

Nodeの依存関係は `runtime/package-lock.json` から導入してメインパッケージに同梱します。利用者側のインストールスクリプトやGitHubからの実行ファイルダウンロードは使いません。ランチャーは導入先のNodeと実行部の絶対パスをRustへ渡すため、ビルド端末のパスや利用者の作業ディレクトリに依存しません。

## ローカルで作成する

作成端末にはRust、Node.jsとnpmが必要です。現在のOS・CPU向けに次を実行します。

```sh
npm run package:npm
npm run test:npm
```

別ターゲットを指定する場合は `npm run package:npm -- <Rustターゲット>` を使います。対応するRustターゲットとリンカーが必要です。通常は各OS上で作成します。

`dist/npm/<OS-CPU>/` にメインパッケージとネイティブパッケージの `.tgz` ができます。`test:npm` は一時ディレクトリへ二つのtarballをオフライン導入し、コマンドの起動、版番号、空白・日本語を含むパス、Node以外をPATHから外したMCP接続、切断後の終了、ネイティブパッケージ欠損時のエラーを確認します。Chromeは起動しません。

実行時に必要なファイルだけを梱包します。Cookie、プロファイル、接続設定、開発用テスト、リポジトリ管理情報は含めません。生成した `dist` はGit管理外です。

## CIで4種類を作成する

```sh
gh workflow run npm-packages.yml --ref main
```

ワークフローは手動実行のみです。4種類それぞれでRustをビルドし、tarballの導入検証後に `npm-<OS-CPU>` というActions artifactへ保存します。npm認証情報は使いません。

## レジストリへ公開するとき

パッケージ名の所有権とnpmアカウントの認証を確認し、同一コミット・同一バージョンで4種類のネイティブパッケージを先に公開します。その後、メインパッケージを公開し、実際のレジストリから導入を確認します。メインパッケージは全ネイティブパッケージを同じ版へ固定しています。

公開用メインtarballには [MITライセンス](../LICENSE) と、再利用したフォーマッターの [Apache-2.0ライセンス](../runtime/vendor/LICENSE) を含めます。同梱したNode依存関係のライセンスも各パッケージ内に保持します。
