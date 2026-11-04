use anyhow::{Result, bail};
use doze_bworser_mcp::{connection, local_config, proxy, read_config, supervise};
use serde_json::Value;
use std::path::PathBuf;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.first().is_some_and(|arg| arg == "--help") {
        println!(
            "doze-bworser-mcp [proxy|status|stop] [--config PATH]\nOne shared Node MCP endpoint, started on demand through local IPC."
        );
        return Ok(());
    }
    if args.first().is_some_and(|arg| arg == "--version") {
        println!("doze-bworser-mcp {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let command = args.first().map(String::as_str).unwrap_or("proxy");
    let (path, config) = match args.as_slice() {
        [] | [_] => local_config()?,
        [_, flag, path] if flag == "--config" => {
            let path = PathBuf::from(path);
            let config = read_config(&path)?;
            (path, config)
        }
        _ => bail!("Expected [proxy|status|stop] [--config PATH]"),
    };
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
        "status" | "stop" => {
            connection(&path, &config, command, Value::Null, false).await?;
            Ok(())
        }
        _ => bail!("Unknown command"),
    }
}
