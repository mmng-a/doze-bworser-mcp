# doze-bworser-mcp

[English](README.md) | [日本語](README.ja.md)

Codexの複数スレッドで、必要な時に起動する1個のChrome for Testingを共有するローカルMCPサービスです。初期化やツール一覧の取得ではブラウザを起動しません。JavaScript実行を含めて、別タブへの操作は並行し、同じタブへの操作は順番に実行します。各呼び出しは処理の完了後に結果を返します。

## 必要なもの

- macOS。ビルドにはRust 1.88以降、インストールにはPython 3.11以降が必要です。
- Node.js 22.12.0以降とnpm。
- 自動操作専用のGoogle Chrome for Testing。利用者の通常のブラウザは自動選択しません。
- Streamable HTTP接続のMCPを利用できるCodexクライアント。

待機中はRustの受付だけが動作します。最初のブラウザ操作で、全スレッドが共有するNode.jsのPuppeteerワーカーとChromiumを起動し、最後のタブを閉じると両方を停止します。ブラウザ操作とアクセシビリティ情報の取得には、puppeteer-core 25.16.0の公開APIを使います。タブ一覧のURL・タイトルは、Puppeteerの公開CDPセッションを通じてブラウザ側の情報を取得します。通常のheadless用ブラウザを全体で1個共有します。明示的な共同操作には、別の画面表示用ブラウザを使います。

サンドボックス内からはHTTP MCPで接続します。ChromiumはLaunchAgent側で起動します。ループバック通信が禁止された環境では利用できません。

## インストール

```sh
cargo build --release --locked
python3 scripts/install.py
```

既定では、既存の専用ブラウザ `~/.local/share/codex-browser/chrome/current/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` を使います。別の専用配置を使う場合は、`~/.config/doze-bworser-mcp/config.json` の `chrome_path` を設定してください。

インストーラーは固定バージョンのPuppeteerとワーカーを `~/.local/share/doze-bworser-mcp/runtimes/<version>` に準備します。準備が終わってから、未使用のサービスの新規受付を止めて切り替えます。既存の実行環境は上書きしません。

インストーラーは、LaunchAgent `com.masasam.doze-bworser-mcp`、`~/.codex/config.toml` の認証付きローカルHTTP MCP、開始・終了フックを登録します。サービスはログイン時に起動して待機し、ブラウザ操作を初めて受けた時にChromiumを起動します。既定のポート番号は45917です。アクセストークンを含む個人設定ファイルは公開しないでください。

既存のCodexスレッドではMCP設定の再読込が必要な場合があります。変更したフックは `/hooks` で信頼する必要がある場合があります。無関係な設定は維持し、変更前のCodex設定とフックを個人設定ディレクトリに保存します。従来のcodex-browser開始フックは置き換えますが、既存セッションの後始末用に終了フックを保持します。

## 使い方

更新前には、サービスが管理するタブを閉じてください。インストーラーはタブの有無の確認と新規タブの受付停止を同時に行い、使用中なら更新しません。`/update` に対応していない旧版からの初回更新では、先にサービスを停止する必要があります。

1. `open_page` にHTTP(S)のURLを渡します。画面表示が必要な共同操作では `headed: true` を指定します。
2. 返された `page_id` を、以後のすべてのページ操作に渡します。
3. `inspect_page` でDevTools形式のアクセシビリティツリーを取得します。表示された `uid` を、`click` や `fill` の `element` に渡します。
4. `take_screenshot` で画像を取得します。案件に正式な撮影・監査CLIがある場合は、正式な成果物の作成にそちらを優先します。
5. 作業を終えたら `close_page` でタブを閉じます。

利用できるツールは `open_page`、`list_pages`、`inspect_page`、`navigate_page`、`click`、`fill`、`press_key`、`scroll_page`、`set_viewport`、`take_screenshot`、`evaluate_script`、`handle_dialog`、`close_page` です。

`headed: true` は明示された共同操作にだけ使います。自動操作専用のウインドウを開き、利用者の既存ブラウザには接続しません。`set_viewport` はページの表示条件を変更し、利用者のウインドウはリサイズしません。

操作結果はMCPの `content` だけで返します。`open_page` は `page_id`、`list_pages` はID・URL・タイトルの配列、`inspect_page` はテキスト、`take_screenshot` は画像、`evaluate_script` は評価結果のJSON、それ以外は `OK` を返します。ページの初期表示サイズは1440×900です。変更する場合は `set_viewport` を使います。

内容取得にはPuppeteerのアクセシビリティツリーを使い、ページ単位の要素IDを付けます。テキスト整形はChrome DevTools MCP 1.12.0の実装をApache-2.0ライセンスに従って再利用しています。要素IDは最新の取得結果だけが有効です。要素への解決と、ページ移動後の古い参照の拒否はPuppeteerが行います。DevTools MCPサーバーやPuppeteerの非公開APIは使いません。

## 注意点

- CodexのスレッドIDは呼び出し情報から取得し、モデルが入力する引数にはしません。親子の情報と開始・終了フックを使い、関連するスレッドを同じブラウザコンテキストへ対応付けます。コンテキストごとにCookieや保存領域を分離します。
- 呼び出し元が一覧取得・操作できるのは自分のタブだけです。Codex以外のMCPクライアントは接続単位で分離します。MCP接続を終了すると、その接続のタブを閉じます。別の接続が使っているタブは保持します。親スレッドの終了時には、その親と子の管理対象を閉じます。
- 30分以上操作していないタブを定期的に閉じます。操作中のタブは対象にしません。終了後の操作には、新しいタブを開くようエラーを返します。
- 最後のタブを閉じると、対応する専用ブラウザを停止します。待機するMCPサービスは残ります。
- ページ移動と要素の操作準備の待機はPuppeteerが行います。入力操作の成功は、外部処理の成功まで保証しません。必要な結果を操作後の画面で確認してください。
- 要素の参照IDには、最新の `inspect_page` が返した `uid` を使います。要素のハンドルはPuppeteerが管理します。アクセシビリティツリーには、ブラウザが公開する入力値や状態も含まれます。
- `evaluate_script` の実行中にスクリプトが開いたダイアログは、閉じます。
- 新規タブの読み込み中にダイアログが開いた場合もタブを保持し、エラーに `page_id` を含めます。
- JavaScriptのダイアログが開いている場合は、その内容をエラーで返します。元の操作を繰り返さず、`handle_dialog` で応答してから結果を確認してください。
- 順番待ちと実行の制限時間は、それぞれ既定で20秒です。順番待ちで時間切れになった要求は実行しません。実行中の時間切れやキャンセルでは、結果が不明なタブに操作を重ねないよう、そのタブを閉じます。外部への変更がすでに起きた可能性は残ります。自動で再実行しません。
- タブの終了要求にも応答しない場合は、該当する共有ワーカーを停止します。そのワーカーが持つ他のタブも失われます。
- ブラウザが異常終了すると、そのブラウザのページは失われます。古いページIDを別のページへ割り当て直しません。
- 接続先は `127.0.0.1` に限定し、Bearer認証とHost・Originの検証を行います。サービスは自身のOS権限で動作します。MCPにしても、OSの権限やCodexのツール承認はなくなりません。
- 終了処理の対象は、自分で起動した専用ブラウザと一時プロファイルです。

## 検証

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
npm ci --ignore-scripts --prefix runtime
npm test --prefix runtime
python3 -m unittest discover -s scripts -p 'test_*.py'
DOZE_BROWSER_CHROME='/専用のChrome for Testing実行ファイルの絶対パス' cargo test --locked --test service -- --ignored --test-threads=1
```

実ブラウザの検証には、ローカルの検証用ページと専用headlessブラウザを使います。共有起動、Cookie・保存領域の分離、タブの所有者、移動中の別タブ操作、同じタブの実行順序、入力、画像出力、接続終了・時間切れ時の後始末を確認します。

CIはpushとプルリクエストで、整形、Clippy、Rust・Node.js・インストーラーの通常テストを実行します。実ブラウザの検証は明示的に実行します。自動デプロイ・リリースはありません。別の指定がない開発では現在のブランチを使います。

## ライセンス

MIT。再利用したテキスト整形部分はApache-2.0です。[出典とライセンス](runtime/vendor/README.md)を参照してください。
