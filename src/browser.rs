//! Own browser processes globally and serialize only operations on the same page.

use crate::cdp::Cdp;
use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
    time::timeout,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub struct Manager {
    chrome: PathBuf,
    operation_timeout: Duration,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    engines: HashMap<bool, Engine>,
    pages: HashMap<String, Arc<Page>>,
    parents: HashMap<String, Option<String>>,
}

struct Engine {
    child: Child,
    cdp: Cdp,
    contexts: HashMap<String, String>,
    _profile: TempDir,
}

pub struct Page {
    pub id: String,
    owner: String,
    connection: String,
    root: String,
    headed: bool,
    target: String,
    session: String,
    cdp: Cdp,
    operation: Mutex<()>,
    dialog: AtomicBool,
}

#[derive(Clone, Debug)]
pub struct Caller {
    pub thread: String,
    pub parent: Option<String>,
    pub connection: String,
}

impl Caller {
    pub fn from_meta(meta: &Value, session: &str) -> Result<Self> {
        let metadata = match &meta["x-codex-turn-metadata"] {
            Value::String(s) => serde_json::from_str::<Value>(s)?,
            Value::Object(_) => meta["x-codex-turn-metadata"].clone(),
            _ => Value::Null,
        };
        let thread = metadata["thread_id"]
            .as_str()
            .or_else(|| meta["threadId"].as_str())
            .unwrap_or(session);
        if thread.is_empty() || thread.len() > 200 {
            bail!("Missing or invalid caller identity");
        }
        let source = match &metadata["thread_source"] {
            Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
            v => v.clone(),
        };
        let parent = source
            .pointer("/subagent/thread_spawn/parent_thread_id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        Ok(Self {
            thread: thread.into(),
            parent,
            connection: session.into(),
        })
    }
}

impl Manager {
    pub fn new(chrome: PathBuf, operation_timeout: Duration) -> Self {
        Self {
            chrome,
            operation_timeout,
            state: Mutex::default(),
        }
    }

    pub async fn register(&self, caller: &Caller) -> Result<()> {
        if caller.thread.is_empty() || caller.thread.len() > 200 {
            bail!("Invalid thread identity");
        }
        if caller
            .parent
            .as_ref()
            .is_some_and(|p| p.is_empty() || p == &caller.thread || p.len() > 200)
        {
            bail!("Invalid parent thread");
        }
        let mut state = self.state.lock().await;
        if let Some(existing) = state.parents.get(&caller.thread)
            && existing.is_some()
            && caller.parent.is_some()
            && existing != &caller.parent
        {
            bail!("Caller parent changed");
        }
        let previous = state.parents.get(&caller.thread).cloned();
        if caller.parent.is_some() || !state.parents.contains_key(&caller.thread) {
            state
                .parents
                .insert(caller.thread.clone(), caller.parent.clone());
        }
        if let Err(error) = Self::root(&state, &caller.thread) {
            if let Some(parent) = previous {
                state.parents.insert(caller.thread.clone(), parent);
            } else {
                state.parents.remove(&caller.thread);
            }
            return Err(error);
        }
        Ok(())
    }

    fn root(state: &State, thread: &str) -> Result<String> {
        let mut root = thread;
        for _ in 0..64 {
            match state.parents.get(root).and_then(Option::as_deref) {
                Some(parent) => root = parent,
                None => return Ok(root.into()),
            }
        }
        bail!("Invalid parent thread chain")
    }

    pub async fn open(
        &self,
        caller: &Caller,
        url: &str,
        width: u64,
        height: u64,
        headed: bool,
        cancel: CancellationToken,
    ) -> Result<Value> {
        validate_url(url)?;
        validate_viewport(width, height)?;
        self.register(caller).await?;
        let page = {
            // Navigation happens after this registry lock is released.
            let mut state = self.state.lock().await;
            let root = Self::root(&state, &caller.thread)?;
            if state
                .engines
                .get(&headed)
                .is_some_and(|engine| !engine.cdp.is_alive())
            {
                state.pages.retain(|_, page| page.headed != headed);
                if let Some(mut engine) = state.engines.remove(&headed) {
                    engine.stop().await;
                }
            }
            if let std::collections::hash_map::Entry::Vacant(entry) = state.engines.entry(headed) {
                entry.insert(Engine::launch(&self.chrome, headed).await?);
            }
            let mut allocated_target = None;
            let allocation: Result<Arc<Page>> = async {
                let engine = state.engines.get_mut(&headed).expect("engine was inserted");
                let context = if let Some(context) = engine.contexts.get(&root) {
                    context.clone()
                } else {
                    let result = engine
                        .cdp
                        .call(
                            None,
                            "Target.createBrowserContext",
                            json!({"disposeOnDetach":true}),
                        )
                        .await?;
                    let context = string(&result, "browserContextId")?;
                    engine.contexts.insert(root.clone(), context.clone());
                    context
                };
                let target = engine
                    .cdp
                    .call(
                        None,
                        "Target.createTarget",
                        json!({
                            "url":"about:blank", "browserContextId":context, "background":true,
                        }),
                    )
                    .await?;
                let target = string(&target, "targetId")?;
                allocated_target = Some(target.clone());
                let session = engine
                    .cdp
                    .call(
                        None,
                        "Target.attachToTarget",
                        json!({"targetId":target,"flatten":true}),
                    )
                    .await?;
                let page = Arc::new(Page {
                    id: Uuid::new_v4().to_string(),
                    owner: caller.thread.clone(),
                    connection: caller.connection.clone(),
                    root: root.clone(),
                    headed,
                    target,
                    session: string(&session, "sessionId")?,
                    cdp: engine.cdp.clone(),
                    operation: Mutex::new(()),
                    dialog: AtomicBool::new(false),
                });
                Ok(page)
            }
            .await;
            let page = match allocation {
                Ok(page) => page,
                Err(error) => {
                    if let Some(engine) = state.engines.get_mut(&headed) {
                        if let Some(target) = allocated_target {
                            let _ = timeout(
                                Duration::from_secs(2),
                                engine.cdp.call(
                                    None,
                                    "Target.closeTarget",
                                    json!({"targetId":target}),
                                ),
                            )
                            .await;
                        }
                        let context = engine.contexts.get(&root).cloned();
                        if !state
                            .pages
                            .values()
                            .any(|p| p.root == root && p.headed == headed)
                            && let Some(context) = context
                            && let Some(engine) = state.engines.get_mut(&headed)
                        {
                            engine.contexts.remove(&root);
                            let _ = timeout(
                                Duration::from_secs(2),
                                engine.cdp.call(
                                    None,
                                    "Target.disposeBrowserContext",
                                    json!({"browserContextId":context}),
                                ),
                            )
                            .await;
                        }
                    }
                    if !state.pages.values().any(|p| p.headed == headed)
                        && let Some(mut engine) = state.engines.remove(&headed)
                    {
                        engine.stop().await;
                    }
                    return Err(error);
                }
            };
            state.pages.insert(page.id.clone(), page.clone());
            page
        };
        let args = json!({"url":url,"width":width,"height":height});
        match self
            .run(caller, &page.id, "navigate_page", args, cancel)
            .await
        {
            Ok(result) => Ok(result),
            Err(error) => {
                let _ = self.close(caller, &page.id).await;
                Err(error)
            }
        }
    }

    async fn page(&self, caller: &Caller, id: &str) -> Result<Arc<Page>> {
        let state = self.state.lock().await;
        let page = state
            .pages
            .get(id)
            .context("Page is closed or does not exist")?;
        if page.owner != caller.thread || page.connection != caller.connection {
            bail!("Page belongs to another caller");
        }
        Ok(page.clone())
    }

    pub async fn run(
        &self,
        caller: &Caller,
        id: &str,
        name: &str,
        args: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let page = self.page(caller, id).await?;
        let guard = tokio::select! {
            _ = cancel.cancelled() => bail!("Cancelled before execution; operation was not sent"),
            result = timeout(self.operation_timeout, page.operation.lock()) =>
                result.context("Timed out waiting for this page; operation was not sent")?,
        };
        self.page(caller, id).await?;
        if page.dialog.load(Ordering::Acquire) && name != "handle_dialog" {
            bail!("A JavaScript dialog is open; call handle_dialog before continuing");
        }
        let mut events = page.cdp.events();
        let opening = async {
            loop {
                match events.recv().await {
                    Ok(event)
                        if event["sessionId"] == page.session
                            && event["method"] == "Page.javascriptDialogOpening" =>
                    {
                        return Ok(event["params"].clone());
                    }
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(error) => return Err(anyhow!(error)),
                }
            }
        };
        let result = tokio::select! {
            _ = cancel.cancelled() => Err(anyhow!("Cancelled during execution; outcome may be unknown")),
            dialog=opening => { page.dialog.store(true,Ordering::Release); dialog.map(|dialog|json!({"page_id":id,"action_completed":false,"dialog":dialog,"next_action":"handle_dialog; do not repeat the original operation"})) },
            result = timeout(self.operation_timeout, page.perform(name, &args)) =>
                result.unwrap_or_else(|_| Err(anyhow!("Operation timed out; outcome may be unknown"))),
        };
        if result
            .as_ref()
            .is_err_and(|e| e.to_string().contains("outcome may be unknown"))
        {
            let _ = self.close(caller, id).await;
        }
        drop(guard);
        result
    }

    pub async fn list(&self, caller: &Caller) -> Value {
        let state = self.state.lock().await;
        json!({"pages":state.pages.values().filter(|p| p.owner == caller.thread && p.connection == caller.connection)
            .map(|p|json!({"page_id":p.id,"headed":p.headed})).collect::<Vec<_>>()})
    }

    pub async fn status(&self) -> Value {
        let state = self.state.lock().await;
        json!({"name":"doze-bworser-mcp","version":env!("CARGO_PKG_VERSION"),
            "browser_count":state.engines.len(),"page_count":state.pages.len()})
    }

    pub async fn close(&self, caller: &Caller, id: &str) -> Result<Value> {
        let mut state = self.state.lock().await;
        let Some(page) = state.pages.get(id) else {
            return Ok(json!({"closed":true}));
        };
        if page.owner != caller.thread || page.connection != caller.connection {
            bail!("Page belongs to another caller");
        }
        let page = state.pages.remove(id).expect("page exists");
        let result = timeout(
            Duration::from_secs(3),
            page.cdp
                .call(None, "Target.closeTarget", json!({"targetId":page.target})),
        )
        .await;
        let root_unused = !state
            .pages
            .values()
            .any(|p| p.root == page.root && p.headed == page.headed);
        if root_unused
            && let Some(engine) = state.engines.get_mut(&page.headed)
            && let Some(context) = engine.contexts.remove(&page.root)
        {
            let _ = timeout(
                Duration::from_secs(3),
                engine.cdp.call(
                    None,
                    "Target.disposeBrowserContext",
                    json!({"browserContextId":context}),
                ),
            )
            .await;
        }
        if !state.pages.values().any(|p| p.headed == page.headed)
            && let Some(mut engine) = state.engines.remove(&page.headed)
        {
            engine.stop().await;
        }
        result.context("Timed out closing page")??;
        Ok(json!({"page_id":id,"closed":true}))
    }

    pub async fn end_thread(&self, thread: &str) -> Result<()> {
        let pages = {
            let state = self.state.lock().await;
            let root = Self::root(&state, thread)?;
            state
                .pages
                .values()
                .filter(|p| p.owner == thread || (root == thread && p.root == root))
                .map(|p| {
                    (
                        Caller {
                            thread: p.owner.clone(),
                            parent: None,
                            connection: p.connection.clone(),
                        },
                        p.id.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };
        for (caller, id) in pages {
            self.close(&caller, &id).await?;
        }
        Ok(())
    }

    pub async fn end_connection(&self, connection: &str) {
        let pages = {
            let state = self.state.lock().await;
            state
                .pages
                .values()
                .filter(|p| p.connection == connection)
                .map(|p| {
                    (
                        Caller {
                            thread: p.owner.clone(),
                            parent: None,
                            connection: p.connection.clone(),
                        },
                        p.id.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };
        for (caller, id) in pages {
            let _ = self.close(&caller, &id).await;
        }
    }

    pub async fn shutdown(&self) {
        let mut state = self.state.lock().await;
        state.pages.clear();
        for (_, mut engine) in state.engines.drain() {
            engine.stop().await;
        }
    }
}

impl Engine {
    async fn launch(chrome: &PathBuf, headed: bool) -> Result<Self> {
        if !chrome.is_file() {
            bail!("Chrome for Testing is missing: {}", chrome.display());
        }
        let profile = tempfile::tempdir()?;
        let mut command = Command::new(chrome);
        command
            .args([
                "--remote-debugging-port=0",
                "--remote-debugging-address=127.0.0.1",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-sync",
                "--password-store=basic",
                "--use-mock-keychain",
            ])
            .arg(format!("--user-data-dir={}", profile.path().display()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if !headed {
            command.args(["--headless=new", "--hide-scrollbars", "--mute-audio"]);
        }
        command.arg("about:blank");
        let mut child = command
            .spawn()
            .context("Could not launch the dedicated Chrome for Testing")?;
        let mut lines =
            BufReader::new(child.stderr.take().context("Missing browser stderr")?).lines();
        let endpoint = timeout(Duration::from_secs(20), async {
            while let Some(line) = lines.next_line().await? {
                if let Some(endpoint) = line.strip_prefix("DevTools listening on ") {
                    return Ok::<_, anyhow::Error>(endpoint.to_owned());
                }
            }
            bail!("Chrome exited before providing a DevTools endpoint")
        })
        .await
        .context("Chrome startup timed out")??;
        tokio::spawn(async move { while matches!(lines.next_line().await, Ok(Some(_))) {} });
        let cdp = Cdp::connect(&endpoint).await?;
        Ok(Self {
            child,
            cdp,
            contexts: HashMap::new(),
            _profile: profile,
        })
    }

    async fn stop(&mut self) {
        let _ = timeout(
            Duration::from_secs(2),
            self.cdp.call(None, "Browser.close", json!({})),
        )
        .await;
        if timeout(Duration::from_secs(3), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
            let _ = self.child.wait().await;
        }
    }
}

impl Page {
    async fn perform(&self, name: &str, args: &Value) -> Result<Value> {
        match name {
            "navigate_page" => {
                let url = args["url"].as_str().context("url must be a string")?;
                validate_url(url)?;
                self.cdp
                    .call(Some(&self.session), "Page.enable", json!({}))
                    .await?;
                if args.get("width").is_some() {
                    self.viewport(args).await?;
                }
                let result = self
                    .cdp
                    .call(Some(&self.session), "Page.navigate", json!({"url":url}))
                    .await?;
                if let Some(error) = result["errorText"].as_str() {
                    bail!("Navigation failed: {error}");
                }
                loop {
                    let tree = self
                        .cdp
                        .call(Some(&self.session), "Page.getFrameTree", json!({}))
                        .await?;
                    let committed = result.get("loaderId").is_none()
                        || tree["frameTree"]["frame"]["loaderId"] == result["loaderId"];
                    if let Ok(state) = self
                        .cdp
                        .evaluate(
                            &self.session,
                            "({url:location.href,ready:document.readyState})",
                        )
                        .await
                        && committed
                        && state["url"] != "about:blank"
                        && state["ready"] != "loading"
                    {
                        break;
                    }
                    if url == "about:blank" {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(40)).await;
                }
            }
            "inspect_page" => {
                return self
                    .cdp
                    .evaluate(&self.session, include_str!("inspect.js"))
                    .await;
            }
            "evaluate_script" => {
                return self
                    .cdp
                    .evaluate(
                        &self.session,
                        args["expression"]
                            .as_str()
                            .context("expression must be a string")?,
                    )
                    .await;
            }
            "set_viewport" => self.viewport(args).await?,
            "take_screenshot" => {
                let full = args["full_page"].as_bool().unwrap_or(false);
                let mut params = json!({"format":"png","captureBeyondViewport":full});
                if full {
                    let layout = self
                        .cdp
                        .call(Some(&self.session), "Page.getLayoutMetrics", json!({}))
                        .await?;
                    params["clip"] = json!({"x":0,"y":0,"width":layout["cssContentSize"]["width"],
                        "height":layout["cssContentSize"]["height"],"scale":1});
                }
                let image = self
                    .cdp
                    .call(Some(&self.session), "Page.captureScreenshot", params)
                    .await?;
                return Ok(json!({"image":image["data"],"mime_type":"image/png"}));
            }
            "scroll_page" => {
                let x = args["x"].as_i64().unwrap_or(0);
                let y = args["y"].as_i64().context("y must be an integer")?;
                self.cdp
                    .evaluate(&self.session, &format!("scrollTo({x},{y})"))
                    .await?;
            }
            "click" | "fill" => {
                let reference = args["element"]
                    .as_str()
                    .context("element must be a string from inspect_page")?;
                let reference = serde_json::to_string(reference)?;
                let expression = format!(
                    "(() => {{const e=globalThis.__dozeElements?.get({reference});if(!e?.isConnected)throw new Error('Stale element; call inspect_page again');e.scrollIntoView({{block:'center'}});return e;}})()"
                );
                let element = self
                    .cdp
                    .call(
                        Some(&self.session),
                        "Runtime.evaluate",
                        json!({"expression":expression,"returnByValue":false}),
                    )
                    .await?;
                let object = element["result"]["objectId"]
                    .as_str()
                    .context("Stale element; call inspect_page again")?;
                let result = if name == "fill" {
                    self.cdp.call(Some(&self.session),"Runtime.callFunctionOn",json!({"objectId":object,
                        "functionDeclaration":"function(value){if(this.disabled||this.readOnly)throw new Error('Element is not editable');this.focus();if(this.isContentEditable)this.textContent=value;else {const proto=this instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(!setter)throw new Error('Element is not an input');setter.call(this,value);}this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}",
                        "arguments":[{"value":args["value"].as_str().context("value must be a string")?}],"returnByValue":true})).await?
                } else {
                    self.cdp.call(Some(&self.session),"Runtime.callFunctionOn",json!({"objectId":object,
                        "functionDeclaration":"function(){const r=this.getBoundingClientRect();if(!r.width||!r.height||this.disabled)throw new Error('Element is not actionable');const x=Math.max(0,r.left)+Math.min(r.width,innerWidth-Math.max(0,r.left))/2;const y=Math.max(0,r.top)+Math.min(r.height,innerHeight-Math.max(0,r.top))/2;const hit=document.elementFromPoint(x,y);if(hit!==this&&!this.contains(hit))throw new Error('Element is covered by another element');return {x,y};}","returnByValue":true})).await?
                };
                if result.get("exceptionDetails").is_some() {
                    bail!("Element operation failed: {}", result["exceptionDetails"]);
                }
                if name == "click" {
                    let point = &result["result"]["value"];
                    for kind in ["mousePressed", "mouseReleased"] {
                        self.cdp.call(Some(&self.session),"Input.dispatchMouseEvent",json!({"type":kind,"x":point["x"],"y":point["y"],"button":"left","clickCount":1})).await?;
                    }
                }
                let _ = self
                    .cdp
                    .call(
                        Some(&self.session),
                        "Runtime.releaseObject",
                        json!({"objectId":object}),
                    )
                    .await;
            }
            "press_key" => {
                let key = args["key"].as_str().context("key must be a string")?;
                let code = match key {
                    "Enter" => 13,
                    "Tab" => 9,
                    "Escape" => 27,
                    "Backspace" => 8,
                    "ArrowDown" => 40,
                    "ArrowUp" => 38,
                    "PageDown" => 34,
                    "PageUp" => 33,
                    _ => bail!("Unsupported key"),
                };
                for kind in ["keyDown", "keyUp"] {
                    self.cdp
                        .call(
                            Some(&self.session),
                            "Input.dispatchKeyEvent",
                            json!({"type":kind,"key":key,"windowsVirtualKeyCode":code}),
                        )
                        .await?;
                }
            }
            "handle_dialog" => {
                self.cdp.call(Some(&self.session),"Page.handleJavaScriptDialog",json!({"accept":args["accept"].as_bool().context("accept must be a boolean")?})).await?;
                self.dialog.store(false, Ordering::Release);
            }
            _ => bail!("Unknown browser operation"),
        }
        let info = self
            .cdp
            .call(
                None,
                "Target.getTargetInfo",
                json!({"targetId":self.target}),
            )
            .await?;
        let state = json!({"url":info["targetInfo"]["url"],"title":info["targetInfo"]["title"]});
        Ok(json!({"page_id":self.id,"action_completed":true,"page":state}))
    }

    async fn viewport(&self, args: &Value) -> Result<()> {
        let width = args["width"].as_u64().context("width must be an integer")?;
        let height = args["height"]
            .as_u64()
            .context("height must be an integer")?;
        validate_viewport(width, height)?;
        self.cdp
            .call(
                Some(&self.session),
                "Emulation.setDeviceMetricsOverride",
                json!({
                    "width":width,"height":height,"deviceScaleFactor":1,"mobile":false,
                }),
            )
            .await?;
        Ok(())
    }
}

fn string(value: &Value, key: &str) -> Result<String> {
    value[key]
        .as_str()
        .map(str::to_owned)
        .with_context(|| format!("Missing CDP field {key}"))
}

fn validate_url(url: &str) -> Result<()> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url == "about:blank") {
        bail!("Only http://, https:// and about:blank URLs are supported");
    }
    Ok(())
}

fn validate_viewport(width: u64, height: u64) -> Result<()> {
    if !(200..=3840).contains(&width) || !(200..=2160).contains(&height) {
        bail!("Viewport must be 200–3840 × 200–2160");
    }
    Ok(())
}
