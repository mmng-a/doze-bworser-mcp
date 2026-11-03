//! Multiplex CDP commands over one browser connection without a global operation lock.

use anyhow::{Result, anyhow, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tokio::sync::{Mutex, broadcast, mpsc, oneshot};
use tokio_tungstenite::{connect_async, tungstenite::Message};

type Replies = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>>;

#[derive(Clone)]
pub struct Cdp {
    outgoing: mpsc::Sender<Message>,
    replies: Replies,
    next_id: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
    events: broadcast::Sender<Value>,
    dialogs: Arc<std::sync::Mutex<HashMap<String, Value>>>,
}

impl Cdp {
    pub async fn connect(endpoint: &str) -> Result<Self> {
        let (socket, _) = connect_async(endpoint).await?;
        let (mut sink, mut stream) = socket.split();
        let (outgoing, mut messages) = mpsc::channel::<Message>(64);
        let replies: Replies = Arc::default();
        let readers = replies.clone();
        let alive = Arc::new(AtomicBool::new(true));
        let connected = alive.clone();
        let (events, _) = broadcast::channel(64);
        let incoming_events = events.clone();
        let dialogs = Arc::new(std::sync::Mutex::new(HashMap::new()));
        let incoming_dialogs = dialogs.clone();
        tokio::spawn(async move {
            while let Some(message) = messages.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            while let Some(Ok(message)) = stream.next().await {
                let Message::Text(text) = message else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if value.get("id").is_none() {
                    if let Some(session) = value["sessionId"].as_str() {
                        match value["method"].as_str() {
                            Some("Page.javascriptDialogOpening") => {
                                incoming_dialogs
                                    .lock()
                                    .unwrap()
                                    .insert(session.into(), value["params"].clone());
                            }
                            Some("Page.javascriptDialogClosed") => {
                                incoming_dialogs.lock().unwrap().remove(session);
                            }
                            _ => {}
                        }
                    }
                    let _ = incoming_events.send(value);
                    continue;
                }
                if let Some(id) = value["id"].as_u64()
                    && let Some(reply) = readers.lock().await.remove(&id)
                {
                    let result = if value.get("error").is_some() {
                        Err(anyhow!("CDP: {}", value["error"]))
                    } else {
                        Ok(value["result"].clone())
                    };
                    let _ = reply.send(result);
                }
            }
            connected.store(false, Ordering::Release);
            for (_, reply) in readers.lock().await.drain() {
                let _ = reply.send(Err(anyhow!(
                    "Browser connection closed; the operation was not retried"
                )));
            }
        });
        Ok(Self {
            outgoing,
            replies,
            next_id: Arc::new(AtomicU64::new(1)),
            alive,
            events,
            dialogs,
        })
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn events(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    pub fn dialog(&self, session: &str) -> Option<Value> {
        self.dialogs.lock().unwrap().get(session).cloned()
    }

    pub fn forget_session(&self, session: &str) {
        self.dialogs.lock().unwrap().remove(session);
    }

    pub async fn call(&self, session: Option<&str>, method: &str, params: Value) -> Result<Value> {
        if !self.is_alive() {
            bail!("Browser connection is closed; stale pages cannot be reused");
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut message = json!({"id": id, "method": method, "params": params});
        if let Some(session) = session {
            message["sessionId"] = session.into();
        }
        let (reply, receive) = oneshot::channel();
        self.replies.lock().await.insert(id, reply);
        if self
            .outgoing
            .send(Message::Text(message.to_string().into()))
            .await
            .is_err()
        {
            self.replies.lock().await.remove(&id);
            bail!("Browser connection closed before sending the operation");
        }
        let deadline = if session.is_some() { 30 } else { 5 };
        match tokio::time::timeout(std::time::Duration::from_secs(deadline), receive).await {
            Ok(reply) => reply?,
            Err(_) => {
                self.replies.lock().await.remove(&id);
                bail!("CDP {method} timed out; outcome may be unknown")
            }
        }
    }

    pub async fn evaluate(&self, session: &str, expression: &str) -> Result<Value> {
        let result = self
            .call(
                Some(session),
                "Runtime.evaluate",
                json!({
                    "expression": expression, "awaitPromise": true, "returnByValue": true,
                    "userGesture": true,
                }),
            )
            .await?;
        if result.get("exceptionDetails").is_some() {
            bail!("Page script failed: {}", result["exceptionDetails"]);
        }
        Ok(result["result"]["value"].clone())
    }
}
