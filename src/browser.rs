//! Share Puppeteer workers and enforce caller ownership and page lifetimes.
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
    worker: PathBuf,
    operation_timeout: Duration,
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    engines: HashMap<bool, Arc<Engine>>,
    pages: HashMap<String, Arc<Page>>,
    parents: HashMap<String, Option<String>>,
    updating: bool,
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
        worker: PathBuf,
    ) -> Self {
        Self {
            chrome,
            node,
            worker,
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
            anyhow::ensure!(
                !state.updating,
                "Service is updating; try open_page again after the update"
            );
            let root = Self::root(&state, &caller.thread)?;
            state.reap_dead().await;
            if let std::collections::hash_map::Entry::Vacant(entry) = state.engines.entry(headed) {
                entry.insert(Engine::launch(&self.node, &self.worker, &self.chrome, headed).await?);
            }
            let engine = state.engines[&headed].clone();
            let allocated = timeout(
                Duration::from_secs(30),
                engine.call("new_page", json!({"root":root})),
            )
            .await;
            let allocated = match allocated {
                Ok(Ok(result)) => result,
                error => {
                    if error.is_err() {
                        // An allocation that timed out may still create an untracked page.
                        state.pages.retain(|_, p| p.headed != headed);
                    }
                    if !state.pages.values().any(|p| p.headed == headed) {
                        state.engines.remove(&headed);
                        engine.stop().await;
                    }
                    return Err(match error {
                        Ok(Err(e)) => e,
                        _ => anyhow!("Puppeteer page creation timed out"),
                    });
                }
            };
            let backend = allocated.as_u64().context("Missing created page ID")?;
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
            self.close_now(caller, id).await?;
            bail!("Page is closed or expired; open a new page with open_page");
        }
        let result = tokio::select! {
            _ = cancel.cancelled() => Err(anyhow!("Cancelled during execution; outcome may be unknown")),
            result = timeout(self.operation_timeout,page.perform(name,&args,self.operation_timeout)) => result.unwrap_or_else(|_|Err(anyhow!("Operation timed out; outcome may be unknown"))),
        };
        if result
            .as_ref()
            .is_err_and(|e| e.to_string().contains("outcome may be unknown"))
            && self.close_now(caller, id).await.is_err()
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
        state.reap_dead().await;
        let mut live = HashMap::new();
        for (headed, engine) in &state.engines {
            for page in engine.pages().await? {
                live.insert(
                    (
                        *headed,
                        page["id"].as_u64().context("Invalid Puppeteer page ID")?,
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

    pub async fn prepare_update(&self) -> Result<()> {
        let mut state = self
            .state
            .try_lock()
            .context("Service is busy; retry the update later")?;
        state.reap_dead().await;
        anyhow::ensure!(
            state.pages.is_empty(),
            "The service has active pages; close them before updating"
        );
        state.updating = true;
        Ok(())
    }

    pub async fn cancel_update(&self) {
        self.state.lock().await.updating = false;
    }

    pub async fn status(&self) -> Value {
        let state = self.state.lock().await;
        json!({"name":"doze-bworser-mcp","version":env!("CARGO_PKG_VERSION"),"browser_count":state.engines.len(),"page_count":state.pages.len()})
    }

    pub async fn close(&self, caller: &Caller, id: &str) -> Result<Value> {
        let page = self.state.lock().await.pages.get(id).cloned();
        let Some(page) = page else {
            return Ok(json!("OK"));
        };
        if page.owner != caller.thread || page.connection != caller.connection {
            bail!("Page belongs to another caller");
        }
        let _guard = timeout(self.operation_timeout, page.operation.lock())
            .await
            .context("Timed out waiting to close this page; close was not sent")?;
        self.close_now(caller, id).await
    }

    async fn close_now(&self, caller: &Caller, id: &str) -> Result<Value> {
        let mut state = self.state.lock().await;
        state.reap_dead().await;
        let Some(page) = state.pages.get(id) else {
            return Ok(json!("OK"));
        };
        if page.owner != caller.thread || page.connection != caller.connection {
            bail!("Page belongs to another caller");
        }
        let page = page.clone();
        let closed = timeout(
            Duration::from_secs(5),
            page.engine
                .call("close_page", json!({"page_id":page.upstream_id})),
        )
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
                let _ = self.close_now(&caller, &page.id).await;
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
    async fn reap_dead(&mut self) {
        for headed in [false, true] {
            if self
                .engines
                .get(&headed)
                .is_some_and(|engine| !engine.alive())
            {
                self.pages.retain(|_, page| page.headed != headed);
                if let Some(engine) = self.engines.remove(&headed) {
                    engine.stop().await;
                }
            }
        }
    }
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
        match name {
            "navigate_page" => validate_url(args["url"].as_str().context("url must be a string")?)?,
            "set_viewport" => {
                let w = args["width"].as_u64().context("width must be an integer")?;
                let h = args["height"]
                    .as_u64()
                    .context("height must be an integer")?;
                if !(200..=3840).contains(&w) || !(200..=2160).contains(&h) {
                    bail!("Viewport must be 200–3840 × 200–2160");
                }
            }
            "press_key" => {
                let key = args["key"].as_str().context("key must be a string")?;
                if ![
                    "Enter",
                    "Tab",
                    "Escape",
                    "Backspace",
                    "ArrowDown",
                    "ArrowUp",
                    "PageDown",
                    "PageUp",
                ]
                .contains(&key)
                {
                    bail!("Unsupported key");
                }
            }
            _ => {}
        }
        let mut params = args.clone();
        params["page_id"] = json!(self.upstream_id);
        params["timeout"] = json!(deadline.as_millis().saturating_sub(200).max(1) as u64);
        self.engine.call(name, params).await
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

    #[tokio::test]
    async fn closing_a_dead_worker_releases_pages_and_allows_updates() {
        let (manager, page) = setup(false).await;
        page.engine.stop().await;
        let caller = Caller {
            thread: "owner".into(),
            parent: None,
            connection: "connection".into(),
        };
        manager.close(&caller, "1").await.unwrap();
        assert_eq!(manager.status().await["page_count"], 0);
        assert_eq!(manager.status().await["browser_count"], 0);
        manager.prepare_update().await.unwrap();
    }
}
