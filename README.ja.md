# doze-bworser-mcp

[English](README.md) | [日本語](README.ja.md)

Codexの複数スレッドで専用のChrome for Testingを共有するローカルMCPです。別タブは並行し、同じタブの操作は順番に実行します。各呼び出しは完了を待ちます。JavaScriptダイアログで中断した場合は、元の操作を繰り返さず `handle_dialog` で応答してください。

## 構成

| 要素 | 役割 | 動作期間 |
| --- | --- | --- |
| Rustの標準入出力ランチャー | 共有サービスの起動・接続、認証、データの中継 | MCP接続ごとに1個 |
| 共有のRust監視プロセス | OSのファイルロックを保持してNodeの終了を待つ | サービスの起動中に1個 |
| 共有のNode | 公式MCP SDK、Puppeteer、所有者、順序、取消の管理 | 最後の接続が閉じて短い後始末の待機が終わるまで |
| 専用Chromium | ページの表示と操作 | 最初の `open_page` から最後のタブ終了まで |

Codexは標準入出力のMCPとしてRustを起動します。RustとNodeの間は、macOS・LinuxではUnixドメインソケット、Windowsでは名前付きパイプを使います。RustはMCPを解釈せず、内部用のブラウザ操作RPCも持ちません。MCPを処理するのはNodeだけです。接続開始時にHMAC-SHA256で相互認証し、資格情報そのものは送信しません。Unixソケットは専用の非公開ディレクトリに置きます。小さな認証メッセージで、MCPのストリームか、開始・終了フックや状態確認の処理かを選びます。TCPの待受、HTTP MCPの中継、ログイン時の常駐サービスは使いません。

通常のheadlessブラウザはOSユーザー全体で1個です。明示された共同操作には別の画面表示用ブラウザを1個使います。親スレッドごとに保存領域を分け、担当ごとにタブを所有します。ブラウザ操作とアクセシビリティ情報の取得にはpuppeteer-core 25.16.0の公開APIを使います。テキスト整形にはDevTools MCPのApache-2.0の実装を再利用します。DevTools MCPサーバー自体は起動しません。

## 必要なものとインストール

- macOS、Linux、Windows。ビルドにはRust 1.89以降、インストールにはPython 3.11以降が必要です。
- Node.js 22.12.0以降とnpm。
- 自動操作専用のChrome for Testing。利用者の通常のブラウザは自動選択しません。
- 標準入出力のMCPと開始・終了フックに対応するCodexクライアント。

```sh
cargo build --release --locked
python3 scripts/install.py --chrome '/専用のChrome実行ファイルの絶対パス'
```

WindowsでPythonコマンドが `python` の場合は読み替えてください。2回目以降は設定済みのChromeの配置を再利用でき、`--chrome` を省略できます。

インストーラーは `~/.local/bin` にランチャーを配置し、固定バージョンのNode実行環境を `~/.local/share/doze-bworser-mcp/runtimes` に準備して、Codexに標準入出力のコマンドと開始・終了フックを登録します。認証情報を含む個人設定は `~/.config/doze-bworser-mcp` に保存します。公開しないでください。無関係なCodex設定は保持し、変更前にバックアップします。既存スレッドではMCP設定を再読込し、変更したフックは必要に応じて `/hooks` で信頼してください。

更新前には、このサービスを使うMCP接続を閉じてください。インストーラーは動作中のサービスを置き換えず、置き換え中は監視プロセスと同じOSのロックを保持します。既存の実行環境は上書きしません。旧HTTP・LaunchAgent版から移行する場合は、先にサービスを停止してOSへの登録を解除し、その後で設定の `port` を削除してください。このインストーラーはOSのサービスを管理しません。

```sh
doze-bworser-mcp status
doze-bworser-mcp stop
```

`status` は接続数・タブ数・ブラウザ数を返します。`stop` はMCP接続やタブが残っている間は終了を拒否します。どちらもサービスが存在しない場合はエラーを返します。次のMCP接続時に自動で起動します。

MCPのランチャーは通常、ホスト側クライアントのツール実行環境で動きます。その場合、コーディング用サンドボックスのシェルからChromiumを起動する必要はありません。MCPにしてもOSの制限やツールの承認はなくなりません。MCPプロセス自体も制限するホストでは、実行ファイル、ローカルIPC、ブラウザ起動への許可が必要です。

## ツール

| ツール | 引数 | 結果 |
| --- | --- | --- |
| `open_page` | `url`、任意の `headed` | `{ "page_id": "…" }` |
| `list_pages` | なし | 自分のタブのID・URL・タイトル |
| `inspect_page` | `page_id` | `uid` 付きのDevTools形式のテキスト |
| `navigate_page` | `page_id`、`url` | DOMの準備後に `OK` |
| `click` | `page_id`、`element` | `OK` |
| `fill` | `page_id`、`element`、`value` | `OK` |
| `press_key` | `page_id`、`key` | `OK` |
| `scroll_page` | `page_id`、`y`、任意の `x` | `OK` |
| `set_viewport` | `page_id`、`width`、`height` | `OK` |
| `take_screenshot` | `page_id`、任意の `full_page` | PNG画像 |
| `evaluate_script` | `page_id`、`expression` | Promiseの完了を待ってJSONの値 |
| `handle_dialog` | `page_id`、`accept` | 中断した操作の完了後に `OK`、または次のダイアログ |
| `close_page` | `page_id` | 終了後に `OK` |

結果はMCPの `content` だけで返します。URLはHTTP(S)か `about:blank` に限定します。公開スキーマと引数の検証は、公式MCP SDKを通じて同じZod定義から生成します。真偽値に文字列の `"false"` は使えません。

要素の操作には、最新の `inspect_page` が返す `uid` を使ってください。HTMLの選択肢はPuppeteerの選択APIで操作し、無効な選択肢や値が重複して一意に選べない場合はエラーにします。独自の選択UIは通常のクリックを使います。初期表示は1440×900です。ビューポートの変更では利用者のウインドウをリサイズしません。画面表示は明示された共同操作にだけ使います。成果物の作成に正式な撮影・検査CLIがある場合はそちらを優先します。

## 動作と後始末

- 所有者はCodexの呼び出し情報から取得し、モデルが入力する引数にはしません。フックと親子情報で親スレッドを特定します。Codex以外のクライアントは接続ごとに分離します。切断時にはその接続のタブを閉じ、親スレッド終了時には子のタブも閉じます。
- 30分以上操作していないタブは、ダイアログの応答待ちも含めて終了します。実行中の操作には別の制限時間を適用します。古いページIDは再利用しません。終了後は新しいタブを開いてください。
- 順番待ちと実行の制限時間は、それぞれ既定で20秒です。起動と一覧取得にも制限時間を適用します。ダイアログの応答待ちはPuppeteer内部の別の制限時間では打ち切りません。待機中に取り消された要求や時間切れの要求は実行しません。実行中の取消・時間切れでは、結果が不明なタブを閉じます。外部への変更が起きている可能性は残ります。自動再実行はしません。
- ダイアログの通知を返しても、元の操作の順番は解放しません。元の操作を追跡し、応答待ちでは実行の制限時間を止め、通常操作との重複を防ぎます。`handle_dialog` は元の操作を再開して完了を待ちます。`open_page` 中に開いた場合は、保持した `page_id` をエラーに含めます。
- `close_page` は実行中の操作を中断します。終了を始める前の取消ではタブを保持し、終了を始めた後は完了まで続けます。タブの割当を安全に取り消せない場合や、後始末が停止した場合は、その専用ブラウザを強制終了し、同じブラウザの他のタブも失われます。
- 最後のタブを閉じると対応するChromiumと一時プロファイルを終了します。MCP接続中はNodeが残り、最後の切断後に終了します。NodeやChromiumの異常終了時にはページが失われるため、再接続して新しく開いてください。開始済みの操作は再実行しません。MCP転送前の接続切断・終了中通知だけは、10秒以内で再接続します。認証不一致や開始済みのMCP要求は再送しません。
- 入力操作の成功は、外部の業務処理の成功を保証しません。必要に応じて操作後の画面で結果を確認してください。

## 検証とCI

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
npm ci --ignore-scripts --prefix runtime
npm test --prefix runtime
python3 -m unittest discover -s scripts -p 'test_*.py'
DOZE_BROWSER_CHROME='/専用のChrome実行ファイルの絶対パス' cargo test --locked --test service
```

通常のテストではChromeを起動せず、並行した初回起動、SDKのスキーマ、所有者の呼び出し情報、OSのロック、設定の保持、待機中の取消、ダイアログの順序、後始末を確認します。任意の実ブラウザ検証では、ローカルの検証用ページと専用headless Chromeで入力・内容取得・画像・保存領域の分離・ダイアログ・並行操作・取消を確認します。

CIはpushとプルリクエストでmacOS・Linux・Windowsの整形、Clippy、Rust、Node、インストーラーの検証を実行します。デプロイやサービスのインストールは行いません。ブランチは依頼で別の指定がない限り現在のものを使います。
