use doze_bworser_mcp::{read_config, service_lock};
use serde_json::json;
use std::process::Command;

#[test]
fn public_cli_rejects_removed_controls_without_creating_state() {
    let temporary = tempfile::tempdir().unwrap();
    let binary = env!("CARGO_BIN_EXE_doze-bworser-mcp");
    for args in [
        vec!["stop"],
        vec!["proxy", "--config", "missing.json"],
        vec!["status", "--config", "missing.json"],
        vec!["supervise"],
    ] {
        let output = Command::new(binary)
            .args(&args)
            .env("HOME", temporary.path())
            .env("USERPROFILE", temporary.path())
            .output()
            .unwrap();
        assert!(!output.status.success(), "{args:?}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("Expected [proxy|status]"));
    }
    assert!(!temporary.path().join(".config").exists());
}

#[test]
fn config_validation_and_supervisor_exclusion() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("config.json");
    let mut config = json!({"token":"a".repeat(64),"socket_path":"test","node_path":"node","daemon_path":"daemon.mjs","chrome_path":"chrome","operation_timeout_seconds":20});
    std::fs::write(&path, config.to_string()).unwrap();
    assert!(read_config(&path).is_ok());
    config["operation_timeout_seconds"] = json!(0);
    std::fs::write(&path, config.to_string()).unwrap();
    assert!(read_config(&path).is_err());
    let owner = service_lock(&path).unwrap();
    assert!(service_lock(&path).is_err());
    drop(owner);
    assert!(service_lock(&path).is_ok());
}
