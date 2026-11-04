//! Start one shared Node MCP endpoint and relay its streams without parsing MCP.
use anyhow::{Context, Result, bail};
use hmac::{Hmac, Mac};
use interprocess::local_socket::{
    GenericFilePath,
    tokio::{Stream, prelude::*},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[derive(Deserialize, Serialize)]
pub struct Config {
    pub token: String,
    pub socket_path: PathBuf,
    pub node_path: PathBuf,
    pub daemon_path: PathBuf,
    pub chrome_path: PathBuf,
    #[serde(default = "default_timeout")]
    pub operation_timeout_seconds: u64,
}
fn default_timeout() -> u64 {
    20
}

pub fn default_config_path() -> PathBuf {
    PathBuf::from(
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .unwrap_or_default(),
    )
    .join(".config/doze-bworser-mcp/config.json")
}
pub fn read_config(path: &Path) -> Result<Config> {
    let config: Config = serde_json::from_slice(
        &std::fs::read(path).with_context(|| format!("Cannot read {}", path.display()))?,
    )?;
    if config.token.len() < 32 || !config.token.bytes().all(|c| c.is_ascii_hexdigit()) {
        bail!("Invalid service token");
    }
    if !(1..=30).contains(&config.operation_timeout_seconds) {
        bail!("Operation timeout must be between 1 and 30 seconds");
    }
    Ok(config)
}

/// Only the supervisor or installer may hold this lock; it covers Node's lifetime.
pub fn service_lock(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_file_name("service.lock"))?;
    file.try_lock()
        .context("The shared service is running or being installed")?;
    Ok(file)
}

fn detached(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000008 | 0x00000200);
    }
}

/// Keep the OS lock until Node exits, including when the first relay disappears.
pub fn supervise(path: &Path, config: &Config) -> Result<()> {
    let Ok(_lock) = service_lock(path) else {
        return Ok(());
    };
    #[cfg(unix)]
    match std::fs::remove_file(&config.socket_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let status = Command::new(&config.node_path)
        .arg(&config.daemon_path)
        .arg(path)
        .stdin(Stdio::null())
        .status()
        .context("Cannot start Node service")?;
    if !status.success() {
        bail!("Node service exited with {status}");
    }
    Ok(())
}

async fn connect(config: &Config) -> std::io::Result<Stream> {
    Stream::connect(
        config
            .socket_path
            .as_path()
            .to_fs_name::<GenericFilePath>()?,
    )
    .await
}

/// Authenticate before forwarding any agent bytes; retries never include MCP calls.
pub async fn connection(
    path: &Path,
    config: &Config,
    command: &str,
    payload: Value,
    start: bool,
) -> Result<BufReader<Stream>> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut supervisor: Option<std::process::Child> = None;
    let stream = loop {
        match connect(config).await {
            Ok(stream) => break stream,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                ) =>
            {
                if !start {
                    return Err(error.into());
                }
                let exited = match supervisor.as_mut() {
                    Some(child) => child.try_wait()?.is_some(),
                    None => true,
                };
                if exited {
                    let log = OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(path.with_file_name("service.log"))?;
                    let mut child = Command::new(std::env::current_exe()?);
                    child
                        .args(["supervise", "--config"])
                        .arg(path)
                        .stdin(Stdio::null())
                        .stdout(log.try_clone()?)
                        .stderr(log);
                    detached(&mut child);
                    supervisor = Some(child.spawn().context("Cannot start shared supervisor")?);
                }
            }
            Err(error) => return Err(error.into()),
        }
        if tokio::time::Instant::now() >= deadline {
            bail!("Shared service did not start; see service.log");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    if let Some(mut child) = supervisor {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    let mut stream = BufReader::new(stream);
    let mut nonce = [0u8; 32];
    getrandom::fill(&mut nonce)
        .map_err(|error| anyhow::anyhow!("Cannot generate IPC nonce: {error}"))?;
    let nonce = hex::encode(nonce);
    stream
        .get_mut()
        .write_all(format!("{}\n", json!({"nonce":nonce})).as_bytes())
        .await?;
    let challenge = greeting(&mut stream).await?;
    let proof = hex::decode(
        challenge["proof"]
            .as_str()
            .context("Missing service proof")?,
    )?;
    let mut expected = Hmac::<Sha256>::new_from_slice(config.token.as_bytes())?;
    expected.update(format!("server:{nonce}").as_bytes());
    expected
        .verify_slice(&proof)
        .context("IPC service authentication failed")?;
    let mut client = Hmac::<Sha256>::new_from_slice(config.token.as_bytes())?;
    client.update(format!("client:{nonce}").as_bytes());
    let proof = hex::encode(client.finalize().into_bytes());
    stream
        .get_mut()
        .write_all(
            format!(
                "{}\n",
                json!({"proof":proof,"command":command,"payload":payload})
            )
            .as_bytes(),
        )
        .await?;
    let reply = greeting(&mut stream).await?;
    if reply["ok"] != true {
        bail!(
            "{}",
            reply["error"]
                .as_str()
                .unwrap_or("Service rejected connection")
        );
    }
    if command != "mcp" && command != "hook" {
        println!("{}", reply["result"]);
    }
    Ok(stream)
}

async fn greeting(stream: &mut BufReader<Stream>) -> Result<Value> {
    let mut reply = String::new();
    tokio::time::timeout(
        Duration::from_secs(10),
        (&mut *stream).take(65536).read_line(&mut reply),
    )
    .await??;
    serde_json::from_str(&reply).context("Invalid service greeting")
}

pub async fn proxy(path: &Path, config: &Config) -> Result<()> {
    let mut stream = connection(path, config, "mcp", Value::Null, true).await?;
    let (mut read, mut write) = tokio::io::split(&mut stream);
    let mut input = tokio::io::stdin();
    let mut output = tokio::io::stdout();
    tokio::select! {
        result = tokio::io::copy(&mut input, &mut write) => { result?; },
        result = tokio::io::copy(&mut read, &mut output) => { result?; },
    }
    output.flush().await?;
    Ok(())
}
