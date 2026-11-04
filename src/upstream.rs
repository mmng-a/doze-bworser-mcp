//! Own a lazy Chrome DevTools MCP connection; browser behavior belongs upstream.

use anyhow::{Context, Result, bail};
use rmcp::{
    RoleClient, ServiceExt,
    model::{CallToolRequestParams, CallToolResponse},
    service::{Peer, RunningService},
    transport::TokioChildProcess,
};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};
use tokio::{process::Command, sync::Mutex, time::timeout};

pub struct Engine {
    peer: Peer<RoleClient>,
    service: Mutex<Option<RunningService<RoleClient, ()>>>,
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
            "Chrome DevTools MCP runtime is missing; run the installer"
        );
        anyhow::ensure!(chrome.is_file(), "Dedicated Chrome for Testing is missing");
        let mut command = Command::new(node);
        command
            .arg(entry)
            .args([
                "--isolated",
                "--viewport=1440x900",
                "--experimental-structured-content",
                "--no-usage-statistics",
                "--no-performance-crux",
                "--executable-path",
            ])
            .arg(chrome)
            .env("CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS", "1")
            .env("CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS", "1");
        if !headed {
            command.arg("--headless");
        }
        let transport =
            TokioChildProcess::new(command).context("Could not start Chrome DevTools MCP")?;
        let service = timeout(Duration::from_secs(20), ().serve(transport))
            .await
            .context("DevTools MCP initialization timed out")??;
        Ok(Arc::new(Self {
            peer: service.peer().clone(),
            service: Mutex::new(Some(service)),
        }))
    }

    pub fn alive(&self) -> bool {
        !self.peer.is_transport_closed()
    }

    pub async fn request(&self, name: &str, args: Value) -> Result<Value> {
        let response = self
            .peer
            .call_tool_once(
                CallToolRequestParams::new(name.to_owned()).with_arguments(
                    args.as_object()
                        .context("Tool arguments must be an object")?
                        .clone(),
                ),
            )
            .await?;
        match response {
            CallToolResponse::Complete(result) => Ok(serde_json::to_value(result)?),
            _ => bail!("Unexpected incomplete DevTools response"),
        }
    }

    pub async fn call(&self, name: &str, args: Value) -> Result<Value> {
        let result = self.request(name, args).await?;
        check(&result)?;
        Ok(result)
    }

    pub async fn pages(&self) -> Result<Vec<Value>> {
        let result = timeout(
            Duration::from_secs(5),
            self.request("list_pages", json!({})),
        )
        .await
        .context("DevTools page listing timed out")??;
        anyhow::ensure!(result["isError"] != true, "DevTools could not list pages");
        Ok(result["structuredContent"]["pages"]
            .as_array()
            .context("Missing DevTools page list")?
            .clone())
    }

    pub async fn stop(&self) {
        if let Some(service) = self.service.lock().await.take() {
            let _ = service.cancel().await;
        }
    }
}

pub fn text(result: &Value) -> String {
    result["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug)]
pub struct PendingDialog(String);
impl std::fmt::Display for PendingDialog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for PendingDialog {}

pub fn check(result: &Value) -> Result<()> {
    if let Some(dialog) = result["structuredContent"].get("dialog") {
        return Err(PendingDialog(format!(
            "JavaScript dialog ({}): {}. Use handle_dialog; do not repeat the original operation",
            dialog["type"].as_str().unwrap_or("unknown"),
            dialog["message"].as_str().unwrap_or("")
        ))
        .into());
    }
    if result["isError"] == true || result["structuredContent"].get("errorMessage").is_some() {
        bail!(
            "{}",
            result["structuredContent"]["errorMessage"]
                .as_str()
                .unwrap_or("Chrome DevTools MCP operation failed")
        );
    }
    Ok(())
}

#[cfg(test)]
pub async fn mock(fail_first: bool) -> Arc<Engine> {
    use rmcp::{
        ServerHandler,
        model::*,
        service::{RequestContext, RoleServer},
    };
    struct Mock {
        pages: Mutex<Vec<u64>>,
        fail: std::sync::atomic::AtomicBool,
    }
    impl ServerHandler for Mock {
        fn get_info(&self) -> ServerConfig {
            ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
        }
        async fn call_tool(
            &self,
            request: CallToolRequestParams,
            _: RequestContext<RoleServer>,
        ) -> Result<CallToolResponse, rmcp::ErrorData> {
            let mut pages = self.pages.lock().await;
            if request.name == "close_page" {
                let id = request.arguments.as_ref().unwrap()["pageId"]
                    .as_u64()
                    .unwrap();
                pages.retain(|p| *p != id);
                if self.fail.swap(false, std::sync::atomic::Ordering::Relaxed) {
                    let mut result = CallToolResult::error(vec![]);
                    result.structured_content = Some(json!({"errorMessage":"test close failure"}));
                    return Ok(result.into());
                }
            }
            let mut result = CallToolResult::success(vec![]);
            result.structured_content =
                Some(json!({"pages":pages.iter().map(|id|json!({"id":id})).collect::<Vec<_>>()}));
            Ok(result.into())
        }
    }
    let (client, server) = tokio::io::duplex(8192);
    tokio::spawn(async move {
        let service = Mock {
            pages: Mutex::new(vec![1, 2, 3]),
            fail: std::sync::atomic::AtomicBool::new(fail_first),
        }
        .serve(server)
        .await
        .unwrap();
        let _ = service.waiting().await;
    });
    let service = ().serve(client).await.unwrap();
    Arc::new(Engine {
        peer: service.peer().clone(),
        service: Mutex::new(Some(service)),
    })
}
