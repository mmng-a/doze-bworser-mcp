//! Share DevTools MCP workers and enforce caller ownership and page lifetimes.
use crate::upstream::{self, Engine};
use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    sync::Mutex,
    time::{Instant, timeout},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
const PAGE_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub struct Manager {
    chrome: PathBuf,
    node: PathBuf,
    devtools: PathBuf,
    operation_timeout: Duration,
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    engines: HashMap<bool, Arc<Engine>>,
    pages: HashMap<String, Arc<Page>>,
    parents: HashMap<String, Option<String>>,
}
pub struct Page {
    pub id: String,
    owner: String,
    connection: String,
    root: String,
    headed: bool,
    upstream_id: u64,
    engine: Arc<Engine>,
    operation: Mutex<()>,
    last_used: std::sync::Mutex<Instant>,
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
    pub fn new(
        chrome: PathBuf,
        operation_timeout: Duration,
        node: PathBuf,
        devtools: PathBuf,
    ) -> Self {
        Self {
            chrome,
            node,
            devtools,
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
        headed: bool,
        cancel: CancellationToken,
    ) -> Result<Value> {
        validate_url(url)?;
        self.register(caller).await?;
        let page = {
            let mut state = self.state.lock().await;
            let root = Self::root(&state, &caller.thread)?;
            if state.engines.get(&headed).is_some_and(|e| !e.alive()) {
                state.pages.retain(|_, p| p.headed != headed);
                if let Some(engine) = state.engines.remove(&headed) {
                    engine.stop().await;
                }
            }
            if let std::collections::hash_map::Entry::Vacant(entry) = state.engines.entry(headed) {
                entry.insert(
                    Engine::launch(&self.node, &self.devtools, &self.chrome, headed).await?,
                );
            }
            let engine = state.engines[&headed].clone();
            // Navigating inside new_page would hold DevTools' browser-wide queue.
            let allocated = timeout(
                Duration::from_secs(30),
                engine.call(
                    "new_page",
                    json!({"url":"about:blank","background":true,"isolatedContext":root}),
                ),
            )
            .await;
            let allocated = match allocated {
                Ok(Ok(result)) => result,
                error => {
                    if !state.pages.values().any(|p| p.headed == headed) {
                        state.engines.remove(&headed);
                        engine.stop().await;
                    }
                    return Err(match error {
                        Ok(Err(e)) => e,
                        _ => anyhow!("DevTools page creation timed out"),
                    });
                }
            };
            let backend = allocated["structuredContent"]["pages"]
                .as_array()
                .context("Missing created page")?
                .iter()
                .find(|p| p["selected"] == true && p["isolatedContext"] == root)
                .and_then(|p| p["id"].as_u64())
                .context("Missing created page ID")?;
            let page = Arc::new(Page {
                id: Uuid::new_v4().to_string(),
                owner: caller.thread.clone(),
                connection: caller.connection.clone(),
                root,
                headed,
                upstream_id: backend,
                engine,
                operation: Mutex::new(()),
                last_used: std::sync::Mutex::new(Instant::now()),
            });
            state.pages.insert(page.id.clone(), page.clone());
            page
        };
        if let Err(error) = self
            .run(
                caller,
                &page.id,
                "navigate_page",
                json!({"url":url}),
                cancel,
            )
            .await
        {
            // A dialog blocks navigation without making the new page unusable.
            if error.is::<upstream::PendingDialog>() {
                bail!("page_id={}: {error}", page.id);
            }
            let _ = self.close(caller, &page.id).await;
            return Err(error);
        }
        Ok(json!({"page_id":page.id}))
    }

    async fn page(&self, caller: &Caller, id: &str) -> Result<Arc<Page>> {
        let state = self.state.lock().await;
        let page = state
            .pages
            .get(id)
            .context("Page is closed or expired; open a new page with open_page")?;
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
            result = timeout(self.operation_timeout, page.operation.lock()) => result.context("Timed out waiting for this page; operation was not sent")?,
        };
        self.page(caller, id).await?;
        if page.idle() {
            self.close(caller, id).await?;
            bail!("Page is closed or expired; open a new page with open_page");
        }
        let result = tokio::select! {
            _ = cancel.cancelled() => Err(anyhow!("Cancelled during execution; outcome may be unknown")),
            result = timeout(self.operation_timeout,page.perform(name,&args,self.operation_timeout)) => result.unwrap_or_else(|_|Err(anyhow!("Operation timed out; outcome may be unknown"))),
        };
        if result
            .as_ref()
            .is_err_and(|e| e.to_string().contains("outcome may be unknown"))
            && self.close(caller, id).await.is_err()
        {
            let mut state = self.state.lock().await;
            state
                .pages
                .retain(|_, p| !Arc::ptr_eq(&p.engine, &page.engine));
            if state
                .engines
                .get(&page.headed)
                .is_some_and(|e| Arc::ptr_eq(e, &page.engine))
            {
                state.engines.remove(&page.headed);
            }
            page.engine.stop().await;
        }
        *page.last_used.lock().unwrap() = Instant::now();
        drop(guard);
        result
    }

    pub async fn list(&self, caller: &Caller) -> Result<Value> {
        let mut state = self.state.lock().await;
        let mut live = HashMap::new();
        for (headed, engine) in &state.engines {
            for page in engine.pages().await? {
                live.insert(
                    (
                        *headed,
                        page["id"].as_u64().context("Invalid DevTools page ID")?,
                    ),
                    page,
                );
            }
        }
        state
            .pages
            .retain(|_, p| live.contains_key(&(p.headed, p.upstream_id)));
        state.stop_unused().await;
        Ok(json!(
            state
                .pages
                .values()
                .filter(|p| p.owner == caller.thread && p.connection == caller.connection)
                .map(|p| {
                    let info = &live[&(p.headed, p.upstream_id)];
                    json!({"page_id":p.id,"url":info["url"],"title":info["title"]})
                })
                .collect::<Vec<_>>()
        ))
    }

    pub async fn status(&self) -> Value {
        let state = self.state.lock().await;
        json!({"name":"doze-bworser-mcp","version":env!("CARGO_PKG_VERSION"),"browser_count":state.engines.len(),"page_count":state.pages.len()})
    }

    pub async fn close(&self, caller: &Caller, id: &str) -> Result<Value> {
        let mut state = self.state.lock().await;
        let Some(page) = state.pages.get(id) else {
            return Ok(json!("OK"));
        };
        if page.owner != caller.thread || page.connection != caller.connection {
            bail!("Page belongs to another caller");
        }
        let page = page.clone();
        let closed = timeout(Duration::from_secs(5), async {
            let live = page.engine.pages().await?;
            if live.iter().any(|p| p["id"] == page.upstream_id) {
                page.engine
                    .call("close_page", json!({"pageId":page.upstream_id}))
                    .await?;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await;
        let closed = closed.context("Timed out closing page").and_then(|r| r);
        if closed.is_ok() {
            state.pages.remove(id);
        } else {
            // Keep uncertain closures tracked and ineligible for further operations.
            *page.last_used.lock().unwrap() = Instant::now() - PAGE_IDLE_TIMEOUT;
        }
        state.stop_unused().await;
        closed?;
        Ok(json!("OK"))
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
        let mut failure = None;
        for (caller, id) in pages {
            if let Err(error) = self.close(&caller, &id).await {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
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

    pub async fn expire_idle(&self) {
        let pages = self
            .state
            .lock()
            .await
            .pages
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for page in pages {
            if let Ok(_guard) = page.operation.try_lock()
                && page.idle()
            {
                let caller = Caller {
                    thread: page.owner.clone(),
                    parent: None,
                    connection: page.connection.clone(),
                };
                let _ = self.close(&caller, &page.id).await;
            }
        }
    }

    pub async fn shutdown(&self) {
        let mut state = self.state.lock().await;
        state.pages.clear();
        for (_, engine) in state.engines.drain() {
            engine.stop().await;
        }
    }
}

impl State {
    async fn stop_unused(&mut self) {
        for headed in [false, true] {
            if !self.pages.values().any(|p| p.headed == headed)
                && let Some(engine) = self.engines.remove(&headed)
            {
                engine.stop().await;
            }
        }
    }
}
impl Page {
    fn idle(&self) -> bool {
        self.last_used.lock().unwrap().elapsed() >= PAGE_IDLE_TIMEOUT
    }
    async fn perform(&self, name: &str, args: &Value, deadline: Duration) -> Result<Value> {
        let (tool, mut params) = match name {
            "navigate_page" => {
                let url = args["url"].as_str().context("url must be a string")?;
                validate_url(url)?;
                (
                    "navigate_page",
                    json!({"url":url,"type":"url","timeout":deadline.as_millis().saturating_sub(300).max(1) as u64}),
                )
            }
            "inspect_page" => ("take_snapshot", json!({})),
            "click" => ("click", json!({"uid":args["element"]})),
            "fill" => ("fill", json!({"uid":args["element"],"value":args["value"]})),
            "press_key" => ("press_key", json!({"key":args["key"]})),
            "handle_dialog" => (
                "handle_dialog",
                json!({"action":if args["accept"].as_bool().context("accept must be a boolean")? {"accept"}else{"dismiss"}}),
            ),
            "set_viewport" => {
                let w = args["width"].as_u64().context("width must be an integer")?;
                let h = args["height"]
                    .as_u64()
                    .context("height must be an integer")?;
                if !(200..=3840).contains(&w) || !(200..=2160).contains(&h) {
                    bail!("Viewport must be 200–3840 × 200–2160");
                }
                ("emulate", json!({"viewport":format!("{w}x{h}x1")}))
            }
            "take_screenshot" => (
                "take_screenshot",
                json!({"format":"png","fullPage":args["full_page"].as_bool().unwrap_or(false)}),
            ),
            "evaluate_script" => {
                let expression = args["expression"]
                    .as_str()
                    .context("expression must be a string")?;
                (
                    "evaluate_script",
                    json!({"function":format!("async()=>{{let timer;try{{return await Promise.race([eval({}),new Promise((_,reject)=>{{timer=setTimeout(()=>reject(new Error(\"Operation timed out; outcome may be unknown\")),{})}})])}}finally{{clearTimeout(timer)}}}}",serde_json::to_string(expression)?,deadline.as_millis().saturating_sub(200).max(1)),"dialogAction":"dismiss","waitForStableDom":false}),
                )
            }
            "scroll_page" => {
                let x = args["x"].as_i64().unwrap_or(0);
                let y = args["y"].as_i64().context("y must be an integer")?;
                (
                    "evaluate_script",
                    json!({"function":format!("()=>scrollTo({x},{y})"),"dialogAction":"dismiss","waitForStableDom":false}),
                )
            }
            _ => bail!("Unknown browser operation"),
        };
        params["pageId"] = json!(self.upstream_id);
        let result = self.engine.call(tool, params).await?;
        match name {
            "inspect_page" => Ok(json!(upstream::text(&result))),
            "evaluate_script" => {
                let text = upstream::text(&result);
                let output = text
                    .split_once("```json\n")
                    .and_then(|(_, v)| v.rsplit_once("\n```").map(|(v, _)| v))
                    .context("Missing DevTools evaluation result")?;
                if output == "undefined" {
                    Ok(Value::Null)
                } else {
                    Ok(serde_json::from_str(output)?)
                }
            }
            "take_screenshot" => {
                let image = result["content"]
                    .as_array()
                    .and_then(|cs| cs.iter().find(|c| c["type"] == "image"))
                    .context("Missing DevTools screenshot")?;
                Ok(json!({"image":image["data"]}))
            }
            _ => Ok(json!("OK")),
        }
    }
}
fn validate_url(url: &str) -> Result<()> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url == "about:blank") {
        bail!("Only http://, https:// and about:blank URLs are supported");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn setup(fail: bool) -> (Manager, Arc<Page>) {
        let manager = Manager::new(
            "/missing".into(),
            Duration::from_secs(1),
            "/missing".into(),
            "/missing".into(),
        );
        let engine = crate::upstream::mock(fail).await;
        manager
            .state
            .lock()
            .await
            .engines
            .insert(false, engine.clone());
        let mut last = None;
        for id in 1..=3 {
            let page = Arc::new(Page {
                id: id.to_string(),
                owner: "owner".into(),
                connection: "connection".into(),
                root: "owner".into(),
                headed: false,
                upstream_id: id,
                engine: engine.clone(),
                operation: Mutex::new(()),
                last_used: std::sync::Mutex::new(Instant::now()),
            });
            manager
                .state
                .lock()
                .await
                .pages
                .insert(page.id.clone(), page.clone());
            last = Some(page);
        }
        (manager, last.unwrap())
    }
    #[tokio::test]
    async fn idle_pages_expire_but_fresh_and_busy_pages_survive() {
        let (manager, busy) = setup(false).await;
        let expired = manager.state.lock().await.pages["1"].clone();
        *expired.last_used.lock().unwrap() = Instant::now() - PAGE_IDLE_TIMEOUT;
        *busy.last_used.lock().unwrap() = Instant::now() - PAGE_IDLE_TIMEOUT;
        let guard = busy.operation.lock().await;
        manager.expire_idle().await;
        assert_eq!(manager.status().await["page_count"], 2);
        let caller = Caller {
            thread: "owner".into(),
            parent: None,
            connection: "connection".into(),
        };
        assert!(
            manager
                .run(
                    &caller,
                    "1",
                    "inspect_page",
                    json!({}),
                    CancellationToken::new()
                )
                .await
                .unwrap_err()
                .to_string()
                .contains("open a new page")
        );
        drop(guard);
        manager.expire_idle().await;
        assert_eq!(manager.status().await["page_count"], 1);
        manager.shutdown().await;
    }
    #[tokio::test]
    async fn thread_cleanup_continues_after_a_close_failure() {
        let (manager, _) = setup(true).await;
        assert!(manager.end_thread("owner").await.is_err());
        assert_eq!(manager.status().await["page_count"], 1);
        manager.expire_idle().await;
        assert_eq!(manager.status().await["page_count"], 0);
        assert_eq!(manager.status().await["browser_count"], 0);
    }
}
