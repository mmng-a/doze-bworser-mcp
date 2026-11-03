use anyhow::{Context, Result, bail};
use doze_bworser_mcp::server::{default_config_path, read_config, serve};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpStream,
    path::PathBuf,
    time::Duration,
};

#[tokio::main]
async fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() || args[0] == "--help" {
        println!(
            "doze-bworser-mcp serve|hook [--config PATH]\nShared local HTTP MCP; Chromium starts on first browser operation."
        );
        return Ok(());
    }
    if args[0] == "--version" {
        println!("doze-bworser-mcp {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let path = if args.len() == 3 && args[1] == "--config" {
        PathBuf::from(&args[2])
    } else if args.len() == 1 {
        default_config_path()
    } else {
        bail!("Expected serve|hook [--config PATH]")
    };
    match args[0].as_str() {
        "serve" => serve(read_config(&path)?).await,
        "hook" => {
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text)?;
            let payload: Value = serde_json::from_str(&text)?;
            let config = read_config(&path)?;
            let thread = payload["session_id"]
                .as_str()
                .context("Hook is missing session_id")?;
            let (event, thread, parent) = match payload["hook_event_name"].as_str() {
                Some("SessionStart") => ("start", thread, None),
                Some("SubagentStart") => (
                    "start",
                    payload["agent_id"]
                        .as_str()
                        .context("Hook is missing agent_id")?,
                    Some(thread),
                ),
                Some("SessionEnd") => ("end", thread, None),
                _ => bail!("Unsupported lifecycle hook"),
            };
            let body = json!({"event":event,"thread":thread,"parent":parent}).to_string();
            let mut socket = TcpStream::connect_timeout(
                &format!("127.0.0.1:{}", config.port).parse()?,
                Duration::from_secs(1),
            )?;
            socket.set_read_timeout(Some(Duration::from_secs(2)))?;
            socket.set_write_timeout(Some(Duration::from_secs(1)))?;
            write!(
                socket,
                "POST /lifecycle HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                config.port,
                config.token,
                body.len(),
                body
            )?;
            let mut response = String::new();
            socket.read_to_string(&mut response)?;
            if !response.starts_with("HTTP/1.1 204") {
                bail!("Browser lifecycle update failed");
            }
            if payload["hook_event_name"] == "SessionStart" {
                println!(
                    "{}",
                    json!({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Use doze-bworser-mcp tools for browser operations. The shared service starts Chromium only when needed. Always pass page_id; different pages run concurrently. Use headed only for explicit joint viewing. Formal project capture/check CLIs take precedence."}})
                );
            }
            Ok(())
        }
        _ => bail!("Unknown command"),
    }
}
