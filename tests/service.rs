use doze_bworser_mcp::{
    browser::Manager,
    server::{Config, application},
};
use reqwest::Client;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

struct Service {
    base: String,
    token: String,
    manager: Arc<Manager>,
    cancel: CancellationToken,
}
impl Drop for Service {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
impl Service {
    async fn start(chrome: PathBuf, seconds: u64) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = "test-token-that-is-long-enough-for-local-tests".to_string();
        let manager = Arc::new(Manager::new(
            chrome.clone(),
            Duration::from_secs(seconds),
            "node".into(),
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/runtime/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js"
            )
            .into(),
        ));
        let cancel = CancellationToken::new();
        let app = application(
            Config {
                port,
                token: token.clone(),
                chrome_path: chrome,
                node_path: "node".into(),
                devtools_path: "/unused".into(),
                operation_timeout_seconds: seconds,
            },
            manager.clone(),
            cancel.clone(),
        );
        let stop = cancel.clone();
        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(stop.cancelled_owned())
                .await
                .unwrap();
        });
        Self {
            base: format!("http://127.0.0.1:{port}"),
            token,
            manager,
            cancel,
        }
    }
    async fn caller(&self, thread: &str) -> Mcp {
        let client = Client::new();
        let response=client.post(format!("{}/mcp",self.base)).bearer_auth(&self.token)
            .header("accept","application/json, text/event-stream")
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
                "protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}))
            .send().await.unwrap();
        assert!(
            response.status().is_success(),
            "initialize: {:?}",
            response.status()
        );
        let session = response
            .headers()
            .get("mcp-session-id")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let body = response_json(response).await;
        assert!(body.get("error").is_none(), "{body}");
        assert_eq!(body["result"]["serverInfo"]["name"], "doze-bworser-mcp");
        let mcp = Mcp {
            client,
            base: self.base.clone(),
            token: self.token.clone(),
            session,
            thread: thread.into(),
            parent: None,
            next: AtomicU64::new(2),
        };
        mcp.client
            .post(format!("{}/mcp", mcp.base))
            .bearer_auth(&mcp.token)
            .header("mcp-session-id", &mcp.session)
            .header("mcp-protocol-version", "2025-11-25")
            .header("accept", "application/json, text/event-stream")
            .json(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .send()
            .await
            .unwrap();
        mcp
    }
}
struct Mcp {
    client: Client,
    base: String,
    token: String,
    session: String,
    thread: String,
    parent: Option<String>,
    next: AtomicU64,
}
impl Mcp {
    async fn rpc(&self, method: &str, mut params: Value) -> Value {
        let source = match &self.parent {
            Some(parent) => json!({"subagent":{"thread_spawn":{"parent_thread_id":parent}}}),
            None => json!("cli"),
        };
        params["_meta"] = json!({"x-codex-turn-metadata":json!({"thread_id":self.thread,"thread_source":source}).to_string()});
        let response=self.client.post(format!("{}/mcp",self.base)).bearer_auth(&self.token)
            .header("mcp-session-id",&self.session).header("mcp-protocol-version","2025-11-25")
            .header("accept","application/json, text/event-stream")
            .json(&json!({"jsonrpc":"2.0","id":self.next.fetch_add(1,Ordering::Relaxed),"method":method,"params":params}))
            .send().await.unwrap();
        assert!(
            response.status().is_success(),
            "HTTP {}: {}",
            response.status(),
            response.text().await.unwrap()
        );
        let body = response_json(response).await;
        assert!(body.get("error").is_none(), "{body}");
        body["result"].clone()
    }
    async fn tool(&self, name: &str, args: Value) -> Value {
        self.rpc("tools/call", json!({"name":name,"arguments":args}))
            .await
    }
    async fn ok(&self, name: &str, args: Value) -> Value {
        let result = self.tool(name, args).await;
        assert_ne!(result["isError"], true, "{name}: {result}");
        assert!(result.get("structuredContent").is_none());
        assert_eq!(result["content"].as_array().unwrap().len(), 1);
        let text = result["content"][0]["text"].as_str().unwrap();
        serde_json::from_str(text).unwrap_or_else(|_| json!(text))
    }
    async fn finish(&self) {
        let response = self
            .client
            .delete(format!("{}/mcp", self.base))
            .bearer_auth(&self.token)
            .header("mcp-session-id", &self.session)
            .header("mcp-protocol-version", "2025-11-25")
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
    }
}

#[tokio::test]
async fn discovery_is_cold_and_http_access_is_scoped() {
    let service = Service::start("/missing/chrome".into(), 2).await;
    let caller = service.caller("thread-a").await;
    let tools = caller.rpc("tools/list", json!({})).await;
    assert_eq!(tools["tools"].as_array().unwrap().len(), 13);
    let open = tools["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "open_page")
        .unwrap();
    assert_eq!(
        open["inputSchema"]["properties"].as_object().unwrap().len(),
        2
    );
    assert_eq!(caller.ok("list_pages", json!({})).await, json!([]));
    assert_eq!(service.manager.status().await["browser_count"], 0);
    assert_eq!(
        Client::new()
            .get(format!("{}/health", service.base))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        Client::new()
            .get(format!("{}/health", service.base))
            .bearer_auth(&service.token)
            .header("origin", "https://other.example")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    caller.finish().await;
}

async fn response_json(response: reqwest::Response) -> Value {
    let event_stream = response
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("text/event-stream");
    let text = response.text().await.unwrap();
    let json = if event_stream {
        text.lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .next_back()
            .unwrap_or("")
    } else {
        &text
    };
    serde_json::from_str(json).unwrap_or_else(|error| panic!("{error}: {text}"))
}

async fn fixture() -> (String, CancellationToken) {
    use axum::{Router, response::Html, routing::get};
    let app=Router::new().route("/",get(||async {Html("<title>Fixture</title><h1>Browser fixture</h1><input aria-label='Name'><button onclick=\"document.querySelector('h1').textContent='Clicked'\">Apply</button>" )}))
        .route("/slow",get(||async {tokio::time::sleep(Duration::from_millis(1200)).await;Html("<title>Slow fixture</title><h1>Ready</h1>")}));
    let app = app.route("/regression",get(||async {Html(r#"<title>Regression</title><div contenteditable="true" aria-label="Editor"></div><div onclick="globalThis.textClicks=1">Clickable text</div><form onsubmit="event.preventDefault();globalThis.submitted=true"><input aria-label="Name"><button>Submit</button></form>"#)}))
        .route("/alert",get(||async {Html("<script>alert('initial')</script><h1>Ready</h1>")}));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(stop.cancelled_owned())
            .await
            .unwrap();
    });
    (format!("http://127.0.0.1:{port}/"), cancel)
}

/// Run explicitly with DOZE_BROWSER_CHROME pointing to a dedicated Chrome for Testing.
#[tokio::test]
#[ignore = "launches the explicitly configured dedicated headless Chrome for Testing"]
async fn real_browser_shares_isolates_and_runs_pages_concurrently() {
    let chrome = std::env::var_os("DOZE_BROWSER_CHROME").expect("Set DOZE_BROWSER_CHROME");
    let service = Service::start(PathBuf::from(chrome), 5).await;
    let (url, fixture_stop) = fixture().await;
    let a = Arc::new(service.caller("thread-a").await);
    let b = service.caller("thread-b").await;
    let opened = a.ok("open_page", json!({"url":url})).await;
    assert_eq!(opened.as_object().unwrap().len(), 1);
    let pa = opened["page_id"].as_str().unwrap().to_string();
    let opened = b.ok("open_page", json!({"url":url})).await;
    let pb = opened["page_id"].as_str().unwrap().to_string();
    assert_eq!(service.manager.status().await["browser_count"], 1);
    assert_eq!(
        a.ok("list_pages", json!({}))
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        b.tool(
            "evaluate_script",
            json!({"page_id":pa,"expression":"document.title"})
        )
        .await["isError"],
        true
    );
    a.ok("evaluate_script",json!({"page_id":pa,"expression":"localStorage.setItem('private','a');document.cookie='private=a';true"})).await;
    assert_eq!(b.ok("evaluate_script",json!({"page_id":pb,"expression":"({storage:localStorage.getItem('private'),cookie:document.cookie})"})).await,json!({"storage":null,"cookie":""}));
    let slow = {
        let a = a.clone();
        let url = format!("{url}slow");
        tokio::spawn(async move { a.ok("open_page", json!({"url":url})).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    let start = Instant::now();
    let inspected = b.ok("inspect_page", json!({"page_id":pb})).await;
    assert!(inspected.as_str().unwrap().contains("Fixture"));
    assert!(
        start.elapsed() < Duration::from_millis(800),
        "slow navigation blocked an unrelated page"
    );
    let slow = slow.await.unwrap();
    a.ok("close_page", json!({"page_id":slow["page_id"]})).await;
    let mut child = service.caller("worker-a").await;
    child.parent = Some("thread-a".into());
    let pc = child.ok("open_page", json!({"url":url})).await["page_id"].clone();
    assert_eq!(
        child
            .ok(
                "evaluate_script",
                json!({"page_id":pc,"expression":"localStorage.getItem('private')"})
            )
            .await,
        "a"
    );
    assert_eq!(
        child.tool("inspect_page", json!({"page_id":pa})).await["isError"],
        true
    );
    let work = {
        let a = a.clone();
        let pa = pa.clone();
        tokio::spawn(async move {
            a.ok("evaluate_script",json!({"page_id":pa,"expression":"new Promise(r=>setTimeout(()=>{globalThis.finished=true;r(true)},400))"})).await
        })
    };
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(
        a.ok(
            "evaluate_script",
            json!({"page_id":pa,"expression":"globalThis.finished"})
        )
        .await,
        true
    );
    work.await.unwrap();
    let snapshot = a.ok("inspect_page", json!({"page_id":pa})).await;
    let snapshot = snapshot.as_str().unwrap();
    assert!(snapshot.contains("RootWebArea \"Fixture\""));
    assert!(snapshot.contains("heading \"Browser fixture\""));
    let reference = |name: &str| {
        snapshot
            .lines()
            .find(|line| line.contains(name))
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .strip_prefix("uid=")
            .unwrap()
            .to_string()
    };
    let input = reference("textbox \"Name\"");
    let button = reference("button \"Apply\"");
    assert_eq!(
        a.ok(
            "fill",
            json!({"page_id":pa,"element":input,"value":"Example"}),
        )
        .await,
        "OK"
    );
    a.ok("click", json!({"page_id":pa,"element":button})).await;
    assert_eq!(
        a.ok(
            "evaluate_script",
            json!({"page_id":pa,"expression":"document.querySelector('h1').textContent"})
        )
        .await,
        "Clicked"
    );
    a.ok("evaluate_script",json!({"page_id":pa,"expression":"document.querySelector('button').onclick=()=>{document.querySelector('h1').textContent=confirm('Continue?')?'Confirmed':'Dismissed'};true"})).await;
    let dialog = a
        .tool("click", json!({"page_id":pa,"element":button}))
        .await;
    assert_eq!(dialog["isError"], true);
    assert!(dialog.to_string().contains("confirm"));
    a.ok("handle_dialog", json!({"page_id":pa,"accept":true}))
        .await;
    assert_eq!(
        a.ok(
            "evaluate_script",
            json!({"page_id":pa,"expression":"document.querySelector('h1').textContent"})
        )
        .await,
        "Confirmed"
    );
    a.ok(
        "evaluate_script",
        json!({"page_id":pa,"expression":"setTimeout(()=>alert('Delayed alert'),150);true"}),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let started = Instant::now();
    let dialog = a.tool("inspect_page", json!({"page_id":pa})).await;
    assert_eq!(dialog["isError"], true);
    assert!(dialog.to_string().contains("Delayed alert"));
    assert!(started.elapsed() < Duration::from_secs(1));
    a.ok("handle_dialog", json!({"page_id":pa,"accept":true}))
        .await;
    assert_eq!(
        a.tool("handle_dialog", json!({"page_id":pa,"accept":true}))
            .await["isError"],
        true
    );
    let refreshed = a.ok("inspect_page", json!({"page_id":pa})).await;
    assert!(refreshed.as_str().unwrap().contains("value=\"Example\""));
    let pages = a.ok("list_pages", json!({})).await;
    assert_eq!(pages[0]["title"], "Fixture");
    assert_eq!(pages[0]["url"], url);
    assert!(pages[0].get("headed").is_none());
    assert_eq!(
        a.ok(
            "set_viewport",
            json!({"page_id":pa,"width":800,"height":600})
        )
        .await,
        "OK"
    );
    assert_eq!(
        a.ok(
            "evaluate_script",
            json!({"page_id":pa,"expression":"innerWidth"})
        )
        .await,
        800
    );
    let screenshot = a.tool("take_screenshot", json!({"page_id":pa})).await;
    use base64::Engine;
    let png = base64::engine::general_purpose::STANDARD
        .decode(screenshot["content"][0]["data"].as_str().unwrap())
        .unwrap();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    std::fs::create_dir_all("tmp").unwrap();
    std::fs::write("tmp/browser-fixture.png", png).unwrap();
    a.finish().await;
    for _ in 0..50 {
        if service.manager.status().await["page_count"] == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    assert_eq!(service.manager.status().await["page_count"], 2);
    service.manager.end_thread("thread-a").await.unwrap();
    assert_eq!(service.manager.status().await["page_count"], 1);
    child.finish().await;
    assert_eq!(
        b.ok(
            "evaluate_script",
            json!({"page_id":pb,"expression":"document.title"})
        )
        .await,
        "Fixture"
    );
    b.ok("close_page", json!({"page_id":pb})).await;
    assert_eq!(service.manager.status().await["browser_count"], 0);
    b.finish().await;
    fixture_stop.cancel();
    service.manager.shutdown().await;
}

#[tokio::test]
#[ignore = "launches the explicitly configured dedicated headless Chrome for Testing"]
async fn timed_out_page_is_closed_without_blocking_other_pages() {
    let chrome = std::env::var_os("DOZE_BROWSER_CHROME").expect("Set DOZE_BROWSER_CHROME");
    let service = Service::start(PathBuf::from(chrome), 1).await;
    let (url, stop) = fixture().await;
    let a = service.caller("timeout-owner").await;
    let pa = a.ok("open_page", json!({"url":url})).await["page_id"].clone();
    let pb = a.ok("open_page", json!({"url":url})).await["page_id"].clone();
    let result = a
        .tool(
            "evaluate_script",
            json!({"page_id":pa,"expression":"new Promise(()=>{})"}),
        )
        .await;
    assert_eq!(result["isError"], true);
    assert!(result.to_string().contains("outcome may be unknown"));
    assert_eq!(
        a.ok("list_pages", json!({}))
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        a.ok("evaluate_script", json!({"page_id":pb,"expression":"21*2"}))
            .await,
        42
    );
    a.ok("close_page", json!({"page_id":pb})).await;
    a.finish().await;
    stop.cancel();
    service.manager.shutdown().await;
}

#[tokio::test]
#[ignore = "launches the explicitly configured dedicated headless Chrome for Testing"]
async fn devtools_handles_editable_text_enter_closed_tabs_and_initial_dialogs() {
    let chrome = std::env::var_os("DOZE_BROWSER_CHROME").expect("Set DOZE_BROWSER_CHROME");
    let service = Service::start(chrome.into(), 5).await;
    let (url, stop) = fixture().await;
    let a = service.caller("regression").await;
    let p = a
        .ok("open_page", json!({"url":format!("{url}regression")}))
        .await["page_id"]
        .clone();
    let snapshot = a.ok("inspect_page", json!({"page_id":p})).await;
    let text = snapshot.as_str().unwrap();
    let uid = |needle: &str| {
        text.lines()
            .find(|l| l.contains(needle))
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .strip_prefix("uid=")
            .unwrap()
            .to_string()
    };
    let editor = uid("generic \"Editor\"");
    a.ok(
        "fill",
        json!({"page_id":p,"element":editor,"value":"Hello"}),
    )
    .await;
    assert_eq!(a.ok("evaluate_script",json!({"page_id":p,"expression":"document.querySelector('[contenteditable]').innerText"})).await,"Hello");
    let label = text
        .lines()
        .find(|l| l.contains("\"Clickable text\""))
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .strip_prefix("uid=")
        .unwrap();
    a.ok("click", json!({"page_id":p,"element":label})).await;
    assert_eq!(
        a.ok(
            "evaluate_script",
            json!({"page_id":p,"expression":"globalThis.textClicks"})
        )
        .await,
        1
    );
    a.ok(
        "fill",
        json!({"page_id":p,"element":uid("textbox \"Name\""),"value":"Example"}),
    )
    .await;
    a.ok("press_key", json!({"page_id":p,"key":"Enter"})).await;
    assert_eq!(
        a.ok(
            "evaluate_script",
            json!({"page_id":p,"expression":"globalThis.submitted"})
        )
        .await,
        true
    );
    let alert = a
        .tool("open_page", json!({"url":format!("{url}alert")}))
        .await;
    assert_eq!(alert["isError"], true);
    assert!(alert.to_string().contains("page_id="), "{alert}");
    let pages = a.ok("list_pages", json!({})).await;
    let alert_page = pages
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["url"].as_str().unwrap().ends_with("/alert"))
        .unwrap()["page_id"]
        .clone();
    a.ok("handle_dialog", json!({"page_id":alert_page,"accept":true}))
        .await;
    assert!(
        a.ok("inspect_page", json!({"page_id":alert_page}))
            .await
            .as_str()
            .unwrap()
            .contains("Ready")
    );
    a.ok("close_page", json!({"page_id":alert_page})).await;
    let other = a.ok("open_page", json!({"url":"about:blank"})).await["page_id"].clone();
    let _ = a
        .tool(
            "evaluate_script",
            json!({"page_id":other,"expression":"setTimeout(()=>window.close(),0);true"}),
        )
        .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let pages = a.ok("list_pages", json!({})).await;
    assert_eq!(pages.as_array().unwrap().len(), 1, "{pages}");
    assert_eq!(pages[0]["page_id"], p);
    assert!(
        a.ok("inspect_page", json!({"page_id":p}))
            .await
            .as_str()
            .unwrap()
            .contains("Regression")
    );
    a.ok("close_page", json!({"page_id":p})).await;
    assert_eq!(service.manager.status().await["browser_count"], 0);
    a.finish().await;
    stop.cancel();
    service.manager.shutdown().await;
}
