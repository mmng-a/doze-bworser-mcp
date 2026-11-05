use anyhow::{Result, bail};
use doze_bworser_mcp::{connection, local_config, proxy, read_config, supervise};
use std::path::PathBuf;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.first().is_some_and(|arg| arg == "--help") {
        println!(
            "doze-bworser-mcp [proxy|status]\nOne shared Node MCP endpoint, started on demand through local IPC."
        );
        return Ok(());
    }
    if args.first().is_some_and(|arg| arg == "--version") {
        println!("doze-bworser-mcp {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let (command, config_path) = match args.as_slice() {
        [] => ("proxy", None),
        [command] if matches!(command.as_str(), "proxy" | "status") => (command.as_str(), None),
        [flag, command, path]
            if flag == "--internal"
                && matches!(command.as_str(), "proxy" | "status" | "supervise") =>
        {
            (command.as_str(), Some(PathBuf::from(path)))
        }
        _ => bail!("Expected [proxy|status]"),
    };
    let (path, config) = if let Some(path) = config_path {
        let config = read_config(&path)?;
        (path, config)
    } else {
        local_config()?
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
        "status" => {
            connection(&path, &config, command, false).await?;
            Ok(())
        }
        _ => bail!("Unknown command"),
    }
}
