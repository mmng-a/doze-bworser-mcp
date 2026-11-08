# doze-bworser-mcp

[English](README.md) | [日本語](README.ja.md)

Codexの複数スレッドで専用のChrome for Testingを共有するローカルMCPです。別タブは並行し、同じタブの操作は順番に実行します。各呼び出しは完了を待ちます。JavaScriptダイアログで中断した場合は、元の操作を繰り返さず `handle_dialog` で応答してください。

## 構成

| 要素 | 役割 | 動作期間 |
| --- | --- | --- |
| Rustの標準入出力ランチャー | 共有サービスの起動・接続、認証、データの中継 | MCP接続ごとに1個 |
| 共有のRust監視プロセス | OSのファイルロックを保持してNodeの終了を待つ | サービスの起動中に1個 |
| 共有のNode | 公式MCP SDK、Puppeteer、所有者、順序、取消の管理 | 最後の接続が閉じて短い後始末の待機が終わるまで |
| プロジェクトごとの専用Chromium | ページの表示と操作、保存済みのログイン状態の利用 | そのプロジェクトの最初の `open_page` から最後のタブ終了まで |

Codexは標準入出力のMCPとしてRustを起動します。RustとNodeの間は、macOS・LinuxではUnixドメインソケット、Windowsでは名前付きパイプを使います。RustはMCPを解釈せず、内部用のブラウザ操作RPCも持ちません。MCPを処理するのはNodeだけです。接続開始時にHMAC-SHA256で相互認証し、資格情報そのものは送信しません。Unixソケットは専用の非公開ディレクトリに置きます。小さな認証メッセージで、MCPのストリームか、状態確認の処理かを選びます。MCP用のTCP待受、HTTP MCPの中継、ログイン時の常駐サービスは使いません。

Git管理下では作業ツリーのルートごと、Git管理外では作業フォルダごとに専用ブラウザと永続プロファイルを使います。同じ保存領域を使うスレッドはCookie等を共有し、担当ごとにタブを所有します。操作対象のブラウザは常にheadlessで動きます。明示された共同操作では、別の専用ChromeにDevToolsのライブ表示を開きます。表示するのは同じページなので、Cookie等の同期やプロファイルの同時起動は不要です。headlessの別ページも並行利用でき、共有ブラウザを再起動しません。ブラウザ操作とアクセシビリティ情報の取得にはpuppeteer-core 25.16.0の公開APIを使います。テキスト整形にはDevTools MCPのApache-2.0の実装を再利用します。DevTools MCPサーバー自体は起動しません。

## 共同操作の画面

`open_page` の `headed: true`、または既存ページへの `show_page` で表示します。DevTools内のアドレスバー、戻る・進む・再読み込み、ページ上のクリック・入力を使えます。同じページでは利用者とAIが交代して操作してください。画面表示を閉じてもページは動き続け、再度 `show_page` で表示できます。`close_page` やMCP切断でページを閉じると、対応する表示も閉じます。最後の表示を閉じると表示用Chromeを終了します。表示用Chromeが異常終了しても、headlessのページは残ります。表示用タブの割当や終了が停止した場合は、表示用Chromeを強制終了し、他の共同操作画面も閉じる場合があります。

表示中だけ、ページごとに `127.0.0.1` のランダムなポートでWebSocketを待ち受けます。ランダムな256ビットの接続パスとDevToolsのOriginを検証し、対象ページとその子ターゲットのCDPセッションだけに接続します。ブラウザ全体の終了や別タブへの接続は許可しません。ページや表示の終了時に接続を無効にします。Chrome自体のデバッグ用TCPポートは開きません。表示用Chromeの一時プロファイルには対象サイトのCookie等を保存せず、正常終了時に削除します。異常終了時にはOSの一時領域に残る場合があります。

DevToolsの画面には日本語入力の制約があります。検証用の日本語挿入は対象ページへ届かず、実機キーボードでのIME操作は未確認です。ポップアップへの表示の自動切り替えも未対応です。

## ログイン状態の保存

作業フォルダは、Codex固有の実験的な呼び出し情報 `codex/sandbox-state` の `sandboxCwd` から自動で取得します。Gitの補助情報 `workspaces` には依存しません。

| 作業フォルダ | 保存単位 |
| --- | --- |
| Git管理下 | 作業ツリーのルート。同じルート内の別フォルダや別プロジェクトも共有 |
| Git管理外 | 作業フォルダの実パス。フォルダごとに永続保存 |

同じフォルダへのシンボリックリンクは同じ保存領域を使います。別のチェックアウトとworktreeは別の保存領域になります。Git管理下の判定にはGitコマンドが必要です。最寄りの `.git` があるフォルダとGitが返したルートが一致しない場合は、保存済みのログイン状態を使わない一時環境で開き、起動結果に警告を添えます。一時環境は親スレッドと作業フォルダごとに分離し、その環境のすべてのタブを閉じると破棄します。元の保存データは変更しません。Gitの実行失敗など、それ以外の判定失敗はエラーにします。Git管理外ではGitコマンドを使いません。

プロファイルは `~/.config/doze-bworser-mcp/profiles/<Gitルートまたは作業フォルダから算出したハッシュ>/` に保存します。Cookie、localStorage、IndexedDB等はタブ終了、操作のタイムアウト、MCPの切断、サービスの再起動後も残ります。起動時に専用Chromeの設定APIでセッション復元を有効にし、セッションCookieも引き継ぎます。以前のタブを自動で開き直したり、操作を再実行したりはしません。サービス側の期限切れや認証の取り消しがあれば、再ログインが必要です。異常終了直前の未保存データは失われる可能性があります。

プロファイルには認証情報が含まれるため、Gitへの登録や公開をしないでください。Unixでは保存ディレクトリを所有者だけがアクセスできる権限にします。ログアウトは対象サイトで行います。保存データをすべて消す場合は、すべてのMCP接続を閉じ、`doze-bworser-mcp status` でサービスの終了を確認してから `profiles` ディレクトリを削除してください。

Codexから `sandboxCwd` を取得できない場合は `open_page` がエラーになります。対応するCodexへ更新し、このMCPへ再接続してください。作業フォルダの情報を提供しないCodex以外のクライアントは、接続ごとの一時保存領域を使い、永続化しません。

## インストール

```sh
brew install mmng-a/tap/doze-bworser-mcp
codex mcp add doze-bworser-mcp -- doze-bworser-mcp
```

HomebrewはRustで本体をビルドし、Node.jsと実行時の依存関係を配置します。初回の `open_page` で対応する専用のChrome for TestingをPuppeteerの公式ダウンローダーから取得します。普段使うブラウザには接続しません。

npmから導入する場合は、Node.js 22.12以降を用意して次を実行します。Rustは不要です。

```sh
npm install -g doze-bworser-mcp@0.2.0
codex mcp add doze-bworser-mcp -- doze-bworser-mcp
```

OSとCPUに合う実行ファイルはnpmが自動で選び、専用Chromeは初回利用時に取得します。コマンドの導入にはHomebrewかnpmのどちらかを使ってください。

MCPクライアントが実行ファイルを見つけられない場合は、`command -v doze-bworser-mcp`（PowerShellでは `(Get-Command doze-bworser-mcp).Source`）で確認した絶対パスを登録してください。MCP設定を直接書く場合は次のとおりです。

```toml
[mcp_servers.doze-bworser-mcp]
command = "doze-bworser-mcp"
tool_timeout_sec = 90
```

専用インストーラーやフック登録は不要です。MCPサーバーはクライアントの設定ファイルを書き換えません。ローカル通信の認証情報は初回起動時に `~/.config/doze-bworser-mcp`、専用ブラウザは `~/.cache/doze-bworser-mcp` に準備します。設定ファイルを公開しないでください。初回のブラウザ取得には時間がかかることがあります。

更新前に、このサーバーへのすべてのMCP接続を閉じ、`doze-bworser-mcp status` で共有サービスが終了したことを確認してください。その後、導入方法に合わせて `brew upgrade mmng-a/tap/doze-bworser-mcp` または `npm install -g doze-bworser-mcp@0.2.0` を実行し、再接続します。`doze-bworser-mcp status` で共有サービスの状態を確認できます。

macOSとLinuxではHomebrewを利用できます。npm版はWindows x64にも対応しています。ソースからビルドする場合は、Rust 1.89以降、Node.js 22.12以降とnpmが必要です。

```sh
npm ci --ignore-scripts --prefix runtime
DOZE_RUNTIME_DIR="$PWD/runtime" cargo build --release --locked
codex mcp add doze-bworser-mcp -- /absolute/path/to/target/release/doze-bworser-mcp
```

ソースからのビルドでは、上記の `DOZE_RUNTIME_DIR` で実行部の場所を明示します。Homebrew版とnpm配布物は自動で指定します。WindowsのPowerShellでビルドする場合は、先に `$env:DOZE_RUNTIME_DIR = (Resolve-Path runtime).Path` を設定し、`cargo build --release --locked` を実行してください。

npm版の対応環境と、配布物の作成・検証手順は [npm/README.md](https://github.com/mmng-a/doze-bworser-mcp/blob/main/npm/README.md) に記載しています。

MCPにしてもOSの制限やツールの承認はなくなりません。MCPプロセス自体を制限するホストでは、ローカルIPC、ブラウザのダウンロード・起動への許可が必要です。

## ツール

| ツール | 引数 | 結果 |
| --- | --- | --- |
| `open_page` | `url`、任意の `headed` | `{ "page_id": "…" }` |
| `show_page` | `page_id` | 既存ページの共同操作画面を表示して `OK` |
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

結果はMCPの `content` だけで返します。`open_page` は先頭のテキスト項目に `{ "page_id": "…" }` を返し、一時環境へ切り替えた場合は別のテキスト項目に警告を返します。警告は利用者に伝えてください。URLはHTTP(S)か `about:blank` に限定します。公開スキーマと引数の検証は、公式MCP SDKを通じて同じZod定義から生成します。真偽値に文字列の `"false"` は使えません。

要素の操作には、最新の `inspect_page` が返す `uid` を使ってください。HTMLの選択肢はPuppeteerの選択APIで操作し、無効な選択肢や値が重複して一意に選べない場合はエラーにします。独自の選択UIは通常のクリックを使います。初期表示は1440×900です。ビューポートの変更では利用者のウインドウをリサイズしません。画面表示は明示された共同操作にだけ使います。成果物の作成に正式な撮影・検査CLIがある場合はそちらを優先します。

## 動作と後始末

- 所有者と作業フォルダはCodexの呼び出し情報から取得し、モデルが入力する引数にはしません。保存領域を共有していても、他のスレッドのタブは操作できません。切断時にはその接続のタブを閉じます。
- 30分以上操作していないタブは、ダイアログの応答待ちも含めて終了します。実行中の操作には別の制限時間を適用します。古いページIDは再利用しません。終了後は新しいタブを開いてください。
- 順番待ちと実行の制限時間は、それぞれ既定で20秒です。起動と一覧取得にも制限時間を適用します。ダイアログの応答待ちはPuppeteer内部の別の制限時間では打ち切りません。待機中に取り消された要求や時間切れの要求は実行しません。実行中の取消・時間切れでは、結果が不明なタブを閉じます。外部への変更が起きている可能性は残ります。自動再実行はしません。
- ダイアログの通知を返しても、元の操作の順番は解放しません。元の操作を追跡し、応答待ちでは実行の制限時間を止め、通常操作との重複を防ぎます。`handle_dialog` は元の操作を再開して完了を待ちます。`open_page` 中に開いた場合は、保持した `page_id` をエラーに含めます。
- `close_page` は実行中の操作を中断します。終了を始める前の取消ではタブを保持し、終了を始めた後は完了まで続けます。タブの割当を安全に取り消せない場合や、後始末が停止した場合は、その専用ブラウザを強制終了し、同じブラウザの他のタブも失われます。
- プロジェクトの最後のタブを閉じると対応するChromiumを終了し、プロファイルは残します。Codex以外のクライアントが使う一時プロファイルは削除します。MCP接続中はNodeが残り、最後の切断後に終了します。NodeやChromiumの異常終了時にはページが失われるため、再接続して新しく開いてください。開始済みの操作は再実行しません。MCP転送前の接続切断・終了中通知だけは、10秒以内で再接続します。認証不一致や開始済みのMCP要求は再送しません。
- 入力操作の成功は、外部の業務処理の成功を保証しません。必要に応じて操作後の画面で結果を確認してください。

## Git運用

- `dev`は通常の開発、`main`は配布対象の確定コードを管理します。
- 変更の反映経路は`dev → main`とします。

## 検証とCI

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
npm ci --ignore-scripts --prefix runtime
npm test --prefix runtime
DOZE_BROWSER_CHROME='/専用のChrome実行ファイルの絶対パス' DOZE_TEST_VIEWER=1 cargo test --locked --test service
```

通常のテストではChromeを起動せず、並行した初回起動、SDKのスキーマ、所有者と作業フォルダの呼び出し情報、headlessページと表示の共有条件、OSのロック、待機中の取消、ダイアログの順序、後始末を確認します。任意の実ブラウザ検証では、ローカルの検証用ページと専用headless Chromeで入力・内容取得・画像・保存領域の分離・ダイアログ・並行操作・取消に加え、Cookie、localStorage、IndexedDBのスレッド間共有、タブ終了・タイムアウト・サービス再起動後の保持とログアウトを確認します。`DOZE_TEST_VIEWER=1` も指定すると、表示画面のアドレスバー・クリック・英字入力、別ページとの併用、表示の終了・異常終了・取消を検証します。画面表示が可能な環境が必要です。

CIは「Run workflow」または `gh workflow run ci.yml -f os=windows-latest -f suite=browser` で手動実行した場合だけ動作します。実行ごとにLinux・Windows・macOSから対象を選びます。pushとプルリクエストでは起動しません。npm配布物の作成・導入検証は、別の手動ワークフロー `npm-packages.yml` で4種類のOS・CPUに対して行い、npmへは公開しません。対象のOSに加え、通常の `light` と、固定版Chromeの取得・実ブラウザ・共同操作画面の検証を加えた `browser` を選べます。選んだOSで整形、Clippy、Rust、Nodeを検証します。デプロイやサービスのインストールは行いません。
