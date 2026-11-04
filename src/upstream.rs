//! Concurrent private transport to the lazy Puppeteer worker.

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        Arc, Mutex as SyncMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{Mutex, oneshot},
    time::timeout,
};

type Pending = Arc<SyncMutex<HashMap<u64, oneshot::Sender<Value>>>>;

pub struct Engine {
    input: Mutex<Option<Box<dyn AsyncWrite + Send + Unpin>>>,
    child: Mutex<Option<Child>>,
    pending: Pending,
    next: AtomicU64,
    alive: Arc<AtomicBool>,
}

impl Engine {
    pub async fn launch(
        node: &Path,
        entry: &Path,
        chrome: &Path,
        headed: bool,
    ) -> Result<Arc<Self>> {
        anyhow::ensure!(
            entry.is_file(),
            "Puppeteer runtime is missing; run the installer"
        );
        anyhow::ensure!(chrome.is_file(), "Dedicated Chrome for Testing is missing");
        let mut child = Command::new(node)
            .arg(entry)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("Could not start Puppeteer")?;
        let input = child.stdin.take().context("Missing worker stdin")?;
        let output = child.stdout.take().context("Missing worker stdout")?;
        let engine = Self::connect(input, output, Some(child));
        let ready = timeout(
            Duration::from_secs(20),
            engine.call("init", json!({"chrome":chrome,"headed":headed})),
        )
        .await;
        match ready {
            Ok(Ok(_)) => Ok(engine),
            failure => {
                engine.stop().await;
                match failure {
                    Ok(Err(error)) => Err(error),
                    _ => bail!("Puppeteer initialization timed out"),
                }
            }
        }
    }

    fn connect(
        input: impl AsyncWrite + Send + Unpin + 'static,
        output: impl AsyncRead + Send + Unpin + 'static,
        child: Option<Child>,
    ) -> Arc<Self> {
        let pending: Pending = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        let engine = Arc::new(Self {
            input: Mutex::new(Some(Box::new(input))),
            child: Mutex::new(child),
            pending: pending.clone(),
            next: AtomicU64::new(1),
            alive: alive.clone(),
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(output).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(response) = serde_json::from_str::<Value>(&line) else {
                    break;
                };
                if let Some(id) = response["id"].as_u64()
                    && let Some(sender) = pending.lock().unwrap().remove(&id)
                {
                    let _ = sender.send(response);
                }
            }
            alive.store(false, Ordering::Release);
            pending.lock().unwrap().clear();
        });
        engine
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub async fn call(&self, name: &str, args: Value) -> Result<Value> {
        anyhow::ensure!(self.alive(), "Puppeteer worker stopped; open a new page");
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, sender);
        // Cancellation must also release requests whose JavaScript never settles.
        struct RequestGuard(u64, Pending);
        impl Drop for RequestGuard {
            fn drop(&mut self) {
                self.1.lock().unwrap().remove(&self.0);
            }
        }
        let _guard = RequestGuard(id, self.pending.clone());
        {
            let mut writer = self.input.lock().await;
            let input = writer.as_mut().context("Puppeteer worker stopped")?;
            input
                .write_all(format!("{}\n", json!({"id":id,"name":name,"args":args})).as_bytes())
                .await?;
        }
        let response = receiver.await.context("Puppeteer worker stopped")?;
        if let Some(error) = response["error"].as_str() {
            match response["kind"].as_str() {
                Some("dialog") => return Err(PendingDialog(error.into()).into()),
                Some("timeout") => bail!("Operation timed out; outcome may be unknown: {error}"),
                _ => bail!("{error}"),
            }
        }
        Ok(response["result"].clone())
    }

    pub async fn pages(&self) -> Result<Vec<Value>> {
        let result = timeout(Duration::from_secs(5), self.call("list_pages", json!({})))
            .await
            .context("Puppeteer page listing timed out")??;
        Ok(result
            .as_array()
            .context("Missing Puppeteer page list")?
            .clone())
    }

    pub async fn stop(&self) {
        self.alive.store(false, Ordering::Release);
        self.input.lock().await.take();
        if let Some(mut child) = self.child.lock().await.take()
            && timeout(Duration::from_secs(5), child.wait()).await.is_err()
        {
            let _ = child.kill().await;
        }
        self.pending.lock().unwrap().clear();
    }
}

#[derive(Debug)]
pub struct PendingDialog(String);
impl std::fmt::Display for PendingDialog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for PendingDialog {}

#[cfg(test)]
pub async fn mock(fail_first: bool) -> Arc<Engine> {
    let (client, server) = tokio::io::duplex(8192);
    let (input, output) = tokio::io::split(client);
    let (server_read, mut server_write) = tokio::io::split(server);
    tokio::spawn(async move {
        let mut pages = vec![1_u64, 2, 3];
        let mut fail = fail_first;
        let mut lines = BufReader::new(server_read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let request: Value = serde_json::from_str(&line).unwrap();
            let mut response = json!({"id":request["id"],"result":"OK"});
            if request["name"] == "close_page" {
                let id = request["args"]["page_id"].as_u64().unwrap();
                if fail {
                    fail = false;
                    response = json!({"id":request["id"],"error":"test close failure"});
                } else {
                    pages.retain(|p| *p != id);
                }
            } else {
                response["result"] =
                    json!(pages.iter().map(|id| json!({"id":id})).collect::<Vec<_>>());
            }
            if server_write
                .write_all(format!("{response}\n").as_bytes())
                .await
                .is_err()
            {
                break;
            }
        }
    });
    Engine::connect(output, input, None)
}
