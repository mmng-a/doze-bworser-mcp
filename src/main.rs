use anyhow::{Context, Result, bail};
use doze_bworser_mcp::{connection, default_config_path, proxy, read_config, supervise};
use serde_json::{Value, json};
use std::{io::Read, path::PathBuf};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.first().is_some_and(|arg| arg == "--help") {
        println!(
            "doze-bworser-mcp [proxy|hook|status|stop] [--config PATH]\nOne shared Node MCP endpoint, started on demand through local IPC."
        );
        return Ok(());
    }
    if args.first().is_some_and(|arg| arg == "--version") {
        println!("doze-bworser-mcp {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let command = args.first().map(String::as_str).unwrap_or("proxy");
    let path = match args.as_slice() {
        [] | [_] => default_config_path(),
        [_, flag, path] if flag == "--config" => PathBuf::from(path),
        _ => bail!("Expected [proxy|hook|status|stop] [--config PATH]"),
    };
    let config = read_config(&path)?;
    match command {
        "proxy" => {
            let result = proxy(&path, &config).await;
            // Tokio's stdin reader cannot be canceled when its peer disconnects.
            if let Err(error) = result {
                eprintln!("Error: {error:#}");
                std::process::exit(1);
            }
            std::process::exit(0);
        }
        "supervise" => supervise(&path, &config),
        "hook" => {
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text)?;
            let payload: Value = serde_json::from_str(&text)?;
            payload["session_id"]
                .as_str()
                .context("Hook is missing session_id")?;
            connection(&path, &config, "hook", payload.clone(), true).await?;
            if payload["hook_event_name"] == "SessionStart" {
                println!(
                    "{}",
                    json!({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Use doze-bworser-mcp tools for browser operations. Chromium starts only when needed. Always pass page_id; different pages run concurrently. Use headed only for explicit joint viewing. Formal project capture/check CLIs take precedence."}})
                );
            }
            Ok(())
        }
        "status" | "stop" => {
            connection(&path, &config, command, Value::Null, false).await?;
            Ok(())
        }
        _ => bail!("Unknown command"),
    }
}
