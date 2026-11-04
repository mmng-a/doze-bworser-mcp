use doze_bworser_mcp::browser::{Caller, Manager};
use serde_json::json;
use std::time::Duration;

#[test]
fn codex_metadata_keeps_the_host_identity_out_of_tool_arguments() {
    let caller=Caller::from_meta(&json!({"x-codex-turn-metadata":json!({
        "thread_id":"worker","thread_source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}
    }).to_string()}),"connection").unwrap();
    assert_eq!(caller.thread, "worker");
    assert_eq!(caller.parent.as_deref(), Some("parent"));
    assert_eq!(caller.connection, "connection");
    let standalone = Caller::from_meta(&json!({}), "standalone").unwrap();
    assert_eq!(standalone.thread, "standalone");
    assert!(Caller::from_meta(&json!({}), "").is_err());
}

#[tokio::test]
async fn invalid_parent_cycles_do_not_poison_registration() {
    let manager = Manager::new(
        "/missing/chrome".into(),
        Duration::from_secs(1),
        "/missing/node".into(),
        "/missing/devtools".into(),
    );
    let child = Caller {
        thread: "child".into(),
        parent: Some("parent".into()),
        connection: "a".into(),
    };
    manager.register(&child).await.unwrap();
    let parent = Caller {
        thread: "parent".into(),
        parent: Some("child".into()),
        connection: "b".into(),
    };
    assert!(manager.register(&parent).await.is_err());
    manager
        .register(&Caller {
            parent: None,
            ..parent
        })
        .await
        .unwrap();
    manager.register(&child).await.unwrap();
    assert_eq!(manager.status().await["browser_count"], 0);
}
