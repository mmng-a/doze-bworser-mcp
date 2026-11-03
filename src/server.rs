//! MCP transport and typed tool catalog. Discovery never starts Chromium.

use crate::browser::{Caller, Manager};
use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rmcp::{
    ErrorData, ServerHandler,
    model::*,
    service::{RequestContext, RoleServer},
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
pub struct Config {
    pub port: u16,
    pub token: String,
    pub chrome_path: PathBuf,
    #[serde(default = "default_timeout")]
    pub operation_timeout_seconds: u64,
}
fn default_timeout() -> u64 {
    20
}

#[derive(Clone)]
struct BrowserService {
    lease: Arc<Lease>,
}
struct Lease {
    connection: String,
    manager: Arc<Manager>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let connection = self.connection.clone();
        let manager = self.manager.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                manager.end_connection(&connection).await;
            });
        }
    }
}

impl ServerHandler for BrowserService {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(env!("CARGO_PKG_NAME"),env!("CARGO_PKG_VERSION")))
            .with_instructions(
            "Use open_page to create your own page, then pass its page_id to every operation. Different pages run concurrently; the same page runs in order. inspect_page returns fresh element references. Calls return completed results, never background job IDs. On an unknown outcome, do not repeat a write automatically. Close pages when finished. Project capture/check CLIs take precedence. Headed pages are only for explicit joint viewing.")
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: catalog(),
            ..Default::default()
        })
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        catalog().into_iter().find(|tool| tool.name == name)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let meta = serde_json::to_value(&context.meta).unwrap_or(Value::Null);
        let caller = match Caller::from_meta(&meta, &self.lease.connection) {
            Ok(caller) => caller,
            Err(error) => return Ok(failure(error).into()),
        };
        let name = request.name.as_ref();
        let args = Value::Object(request.arguments.unwrap_or_default());
        let manager = &self.lease.manager;
        let result: Result<Value> = async {
            manager.register(&caller).await?;
            match name {
                "open_page" => {
                    manager
                        .open(
                            &caller,
                            args["url"].as_str().context("url must be a string")?,
                            args["headed"].as_bool().unwrap_or(false),
                            context.ct.clone(),
                        )
                        .await
                }
                "list_pages" => manager.list(&caller).await,
                "close_page" => {
                    manager
                        .close(
                            &caller,
                            args["page_id"]
                                .as_str()
                                .context("page_id must be a string")?,
                        )
                        .await
                }
                _ if self.get_tool(name).is_some() => {
                    let id = args["page_id"]
                        .as_str()
                        .context("page_id must be a string")?
                        .to_owned();
                    manager
                        .run(&caller, &id, name, args, context.ct.clone())
                        .await
                }
                _ => anyhow::bail!("Unknown tool: {name}"),
            }
        }
        .await;
        let result = match result {
            Ok(value) if name == "take_screenshot" => {
                CallToolResult::success(vec![ContentBlock::image(
                    value["image"].as_str().unwrap_or_default(),
                    "image/png",
                )])
            }
            Ok(value) => {
                let text = if name == "evaluate_script" {
                    value.to_string()
                } else {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string())
                };
                CallToolResult::success(vec![ContentBlock::text(text)])
            }
            Err(error) => failure(error),
        };
        Ok(result.into())
    }
}

fn failure(error: anyhow::Error) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(format!("{error:#}"))])
}

fn catalog() -> Vec<Tool> {
    let string = json!({"type":"string"});
    let integer = json!({"type":"integer"});
    let page = json!({"page_id":string});
    let definitions = vec![
        (
            "open_page",
            "Open a dedicated page. Browser starts only when needed; url must be http(s) or about:blank. headed requires explicit joint viewing.",
            json!({"url":string,"headed":{"type":"boolean"}}),
            vec!["url"],
            false,
            false,
        ),
        (
            "list_pages",
            "List only pages owned by this caller. Does not start a browser.",
            json!({}),
            vec![],
            true,
            false,
        ),
        (
            "inspect_page",
            "Read the Chromium accessibility tree as DevTools-style text. Pass a uid to click or fill as element; references are refreshed on each inspection.",
            page.clone(),
            vec!["page_id"],
            true,
            false,
        ),
        (
            "navigate_page",
            "Navigate your page and wait for DOM readiness. Does not wait for all background requests.",
            json!({"page_id":string,"url":string}),
            vec!["page_id", "url"],
            false,
            true,
        ),
        (
            "click",
            "Click an element reference from inspect_page. May submit a form or change external state.",
            json!({"page_id":string,"element":string}),
            vec!["page_id", "element"],
            false,
            true,
        ),
        (
            "fill",
            "Replace an editable field using its element reference. Fires input and change events.",
            json!({"page_id":string,"element":string,"value":string}),
            vec!["page_id", "element", "value"],
            false,
            true,
        ),
        (
            "press_key",
            "Press Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp, PageDown or PageUp.",
            json!({"page_id":string,"key":string}),
            vec!["page_id", "key"],
            false,
            true,
        ),
        (
            "scroll_page",
            "Scroll your page to absolute x,y coordinates.",
            json!({"page_id":string,"x":integer,"y":integer}),
            vec!["page_id", "y"],
            false,
            false,
        ),
        (
            "set_viewport",
            "Set only your page's emulated viewport. Does not resize a user window.",
            json!({"page_id":string,"width":integer,"height":integer}),
            vec!["page_id", "width", "height"],
            false,
            false,
        ),
        (
            "take_screenshot",
            "Return a PNG image of your page. full_page includes the entire document.",
            json!({"page_id":string,"full_page":{"type":"boolean"}}),
            vec!["page_id"],
            true,
            false,
        ),
        (
            "evaluate_script",
            "Evaluate a JavaScript expression in your page; awaits a returned promise. May change external state. Has no local shell access.",
            json!({"page_id":string,"expression":string}),
            vec!["page_id", "expression"],
            false,
            true,
        ),
        (
            "handle_dialog",
            "Accept or dismiss a JavaScript dialog on your page. Acceptance may confirm an external action.",
            json!({"page_id":string,"accept":{"type":"boolean"}}),
            vec!["page_id", "accept"],
            false,
            true,
        ),
        (
            "close_page",
            "Close only your page. Stops the dedicated browser when no managed pages remain.",
            page,
            vec!["page_id"],
            false,
            true,
        ),
    ];
    definitions.into_iter().map(|(name,description,properties,required,read_only,destructive)| {
        let schema=json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
        let mut tool=Tool::new(name,description,schema.as_object().expect("schema is an object").clone());
        tool.annotations=Some(ToolAnnotations::new().read_only(read_only).destructive(destructive)
            .idempotent(read_only).open_world(true)); tool
    }).collect()
}

#[derive(Clone)]
struct Access {
    config: Config,
    manager: Arc<Manager>,
}

async fn authorize(State(access): State<Access>, request: Request, next: Next) -> Response {
    let expected = format!("Bearer {}", access.config.token);
    let auth = request
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok());
    if auth != Some(expected.as_str()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let expected_host = format!("127.0.0.1:{}", access.config.port);
    let host = request.headers().get("host").and_then(|h| h.to_str().ok());
    if host != Some(expected_host.as_str()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if let Some(origin) = request.headers().get("origin")
        && origin.to_str().ok() != Some(format!("http://{expected_host}").as_str())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}

async fn health(State(access): State<Access>) -> Json<Value> {
    Json(access.manager.status().await)
}

#[derive(Deserialize)]
struct Lifecycle {
    event: String,
    thread: String,
    parent: Option<String>,
}
async fn lifecycle(State(access): State<Access>, Json(event): Json<Lifecycle>) -> Response {
    let result = match event.event.as_str() {
        "start" => {
            access
                .manager
                .register(&Caller {
                    thread: event.thread,
                    parent: event.parent,
                    connection: String::new(),
                })
                .await
        }
        "end" => {
            let manager = access.manager.clone();
            tokio::spawn(async move {
                if let Err(error) = manager.end_thread(&event.thread).await {
                    eprintln!("Thread cleanup failed: {error:#}");
                }
            });
            Ok(())
        }
        _ => Err(anyhow::anyhow!("Unknown lifecycle event")),
    };
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => StatusCode::BAD_REQUEST.into_response(),
    }
}

pub fn application(config: Config, manager: Arc<Manager>, cancel: CancellationToken) -> Router {
    let shared = manager.clone();
    let mut sessions = LocalSessionManager::default();
    // The transport must outlive the 30-minute page idle limit.
    sessions.session_config.keep_alive = Some(Duration::from_secs(60 * 60));
    let service = StreamableHttpService::new(
        move || {
            Ok(BrowserService {
                lease: Arc::new(Lease {
                    connection: Uuid::new_v4().to_string(),
                    manager: shared.clone(),
                }),
            })
        },
        Arc::new(sessions),
        StreamableHttpServerConfig::default()
            .with_json_response(true)
            .with_cancellation_token(cancel)
            .with_max_request_body_bytes(1024 * 1024),
    );
    let access = Access { config, manager };
    Router::new()
        .nest_service("/mcp", service)
        .route("/health", get(health))
        .route("/lifecycle", post(lifecycle))
        .route_layer(middleware::from_fn_with_state(access.clone(), authorize))
        .with_state(access)
}

pub async fn serve(config: Config) -> Result<()> {
    if config.token.len() < 32 {
        anyhow::bail!("Service token must contain at least 32 characters");
    }
    if !(1..=30).contains(&config.operation_timeout_seconds) {
        anyhow::bail!("operation_timeout_seconds must be between 1 and 30");
    }
    let manager = Arc::new(Manager::new(
        config.chrome_path.clone(),
        Duration::from_secs(config.operation_timeout_seconds),
    ));
    let cancel = CancellationToken::new();
    let app = application(config.clone(), manager.clone(), cancel.clone());
    let idle_manager = manager.clone();
    let idle_stop = cancel.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = idle_stop.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(30)) => idle_manager.expire_idle().await,
            }
        }
    });
    let listener =
        tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.port)).await?;
    eprintln!(
        "doze-bworser-mcp listening on 127.0.0.1:{}; Chromium starts on first browser operation",
        config.port
    );
    let shutdown = cancel.clone();
    tokio::spawn(async move {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! { _=tokio::signal::ctrl_c()=>{},_=term.recv()=>{} }
        shutdown.cancel();
    });
    axum::serve(listener, app)
        .with_graceful_shutdown(cancel.cancelled_owned())
        .await?;
    manager.shutdown().await;
    Ok(())
}

pub fn read_config(path: &std::path::Path) -> Result<Config> {
    Ok(serde_json::from_slice(&std::fs::read(path).with_context(
        || format!("Cannot read {}", path.display()),
    )?)?)
}

pub fn default_config_path() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
        .join(".config/doze-bworser-mcp/config.json")
}
