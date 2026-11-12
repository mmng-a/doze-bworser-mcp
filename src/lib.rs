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
    #[serde(default)]
    pub electron_path: PathBuf,
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

/// Prepare private transport credentials; runtime paths belong to the installed package.
pub fn local_config() -> Result<(PathBuf, Config)> {
    let path = default_config_path();
    let directory = path.parent().context("Missing config directory")?;
    std::fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    }
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("bootstrap.lock"))?;
    lock.lock()?;
    let token = if path.exists() {
        read_config(&path)?.token
    } else {
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes)
            .map_err(|error| anyhow::anyhow!("Cannot generate service token: {error}"))?;
        hex::encode(bytes)
    };
    #[cfg(unix)]
    let socket_path = {
        let socket_dir = PathBuf::from("/tmp").join(format!("doze-bworser-{}", &token[..24]));
        std::fs::create_dir_all(&socket_dir)?;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = std::fs::symlink_metadata(&socket_dir)?;
        if !metadata.is_dir() || metadata.uid() != std::fs::metadata(directory)?.uid() {
            bail!("IPC directory must belong to this user");
        }
        std::fs::set_permissions(&socket_dir, std::fs::Permissions::from_mode(0o700))?;
        socket_dir.join("ipc.sock")
    };
    #[cfg(windows)]
    let socket_path = PathBuf::from(format!(r"\\.\pipe\doze-bworser-{}", &token[..24]));
    let runtime = std::env::var_os("DOZE_RUNTIME_DIR")
        .map(PathBuf::from)
        .or_else(|| option_env!("DOZE_RUNTIME_DIR").map(PathBuf::from));
    #[cfg(debug_assertions)]
    let runtime =
        runtime.or_else(|| Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime")));
    let runtime =
        runtime.context("Node runtime location is missing; use the Homebrew or npm launcher")?;
    if !runtime.is_absolute() {
        bail!("Node runtime location must be absolute");
    }
    let config = Config {
        token,
        socket_path,
        node_path: std::env::var_os("DOZE_NODE_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| option_env!("DOZE_NODE_PATH").unwrap_or("node").into()),
        daemon_path: runtime.join("daemon.mjs"),
        electron_path: PathBuf::new(),
        operation_timeout_seconds: default_timeout(),
    };
    if !config.daemon_path.is_file() {
        bail!("Node runtime is missing: {}", config.daemon_path.display());
    }
    let data = serde_json::to_vec_pretty(&config)?;
    if std::fs::read(&path).ok().as_deref() != Some(&data) {
        let temporary = directory.join("config.json.new");
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        options.open(&temporary)?.write_all(&data)?;
        std::fs::rename(temporary, &path)?;
    }
    Ok((path, config))
}

/// Hold the native lock for the shared service lifetime.
pub fn service_lock(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_file_name("service.lock"))?;
    file.try_lock().context("The shared service is running")?;
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
    start: bool,
) -> Result<BufReader<Stream>> {
    let mut supervisor: Option<std::process::Child> = None;
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match connect(config).await {
                Ok(stream) => match authenticate(stream, config, command).await {
                    Ok(Handshake::Ready(stream)) => return Ok(stream),
                    Ok(Handshake::Stopping) if command == "mcp" => {}
                    Ok(Handshake::Stopping) => {
                        bail!("Service is stopping; reconnect after it exits")
                    }
                    Err(error) if command == "mcp" && disconnected(&error) => {}
                    Err(error) => return Err(error),
                },
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
                            .args(["--internal", "supervise"])
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
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        Err(anyhow::anyhow!(
            "Shared service connection timed out; see service.log"
        ))
    });
    if let Some(mut child) = supervisor {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    result
}

enum Handshake {
    Ready(BufReader<Stream>),
    Stopping,
}

fn disconnected(error: &anyhow::Error) -> bool {
    error
        .chain()
        .filter_map(|error| error.downcast_ref::<std::io::Error>())
        .any(|error| {
            matches!(
                error.kind(),
                std::io::ErrorKind::UnexpectedEof
                    | std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::NotConnected
            )
        })
}

async fn authenticate(stream: Stream, config: &Config, command: &str) -> Result<Handshake> {
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
        .write_all(format!("{}\n", json!({"proof":proof,"command":command})).as_bytes())
        .await?;
    let reply = greeting(&mut stream).await?;
    if reply["ok"] != true {
        if reply["code"] == "stopping" {
            return Ok(Handshake::Stopping);
        }
        bail!(
            "{}",
            reply["error"]
                .as_str()
                .unwrap_or("Service rejected connection")
        );
    }
    if command != "mcp" {
        println!("{}", reply["result"]);
    }
    Ok(Handshake::Ready(stream))
}

async fn greeting(stream: &mut BufReader<Stream>) -> Result<Value> {
    let mut reply = String::new();
    let size = (&mut *stream).take(65536).read_line(&mut reply).await?;
    if !reply.ends_with('\n') {
        if size == 65536 {
            bail!("Service greeting exceeds the size limit");
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "Service disconnected during authentication",
        )
        .into());
    }
    serde_json::from_str(&reply).context("Invalid service greeting")
}

pub async fn proxy(path: &Path, config: &Config) -> Result<()> {
    let mut stream = connection(path, config, "mcp", true).await?;
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
